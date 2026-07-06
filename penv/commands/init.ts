import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { gitContext } from '../lib/git.ts';
import {
  runDoctor,
  generateScripts,
  syntaxCheck,
  type DoctorReport,
  type GeneratedScripts,
} from '../lib/doctor.ts';
import { emit, say, note, fail, type Ctx } from '../lib/output.ts';

/** True when the optional `wt` worktree provisioner is on PATH. */
function hasWt(): boolean {
  try {
    return Bun.spawnSync(['sh', '-c', 'command -v wt']).exitCode === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// penv doctor
// ---------------------------------------------------------------------------

export function cmdDoctor(ctx: Ctx): void {
  const gc = gitContext();
  if (!gc.root) {
    fail(ctx, 'not in a git repo', 'NOT_A_REPO');
  }

  const report = runDoctor(gc.root);

  if (ctx.json) {
    emit(ctx, reportToJson(report));
    return;
  }

  printReport(ctx, report);
}

// ---------------------------------------------------------------------------
// penv init
// ---------------------------------------------------------------------------

export function cmdInit(ctx: Ctx, opts: { force?: boolean } = {}): void {
  const gc = gitContext();
  if (!gc.root) {
    fail(ctx, 'not in a git repo', 'NOT_A_REPO');
  }

  const root = gc.root;
  const report = runDoctor(root);

  // Detect --force from process.argv (init.ts doesn't receive flags directly;
  // force is forwarded from cli.ts but not currently threaded — check argv).
  const force = opts.force ?? (process.argv.includes('--force') || process.argv.includes('-f'));

  if (ctx.json) {
    // Always emit the doctor report in json mode first.
    emit(ctx, { phase: 'doctor', ...reportToJson(report) });
  } else {
    printReport(ctx, report);
  }

  // --- Existing preview setup: don't clobber. ---
  if (report.existingOtherPreview && !report.existingPreview) {
    const msg =
      'existing non-penv preview system detected (scripts/preview-env.sh or similar). ' +
      'penv init will NOT overwrite it. Adapt .preview/ scripts manually if you want penv isolation.';
    if (ctx.json) emit(ctx, { phase: 'init', skipped: true, reason: 'existing-preview', detail: msg });
    else say(ctx, `penv: ${msg}`);
    return;
  }

  // --- Decide whether to generate scripts ---
  // Existing scripts are never clobbered without --force, but agent integration
  // still runs so a re-run wires/repairs the docs + hooks (e.g. after the scripts
  // were hand-adapted). Escalate only stops us when there are no scripts to wire.
  const previewDir = join(root, '.preview');
  let skipScripts = false;

  if (report.existingPreview && !force) {
    skipScripts = true;
    if (!ctx.json) {
      say(ctx, 'penv: .preview/ scripts already exist — keeping them (use --force to regenerate); ensuring agent integration');
    }
  } else if (!report.existingPreview && report.confidence === 'escalate') {
    const msg =
      'confidence=escalate (tier 2 or ambiguous blockers). Review the report above, ' +
      'adapt a sample from samples/preview/ into .preview/, then re-run `penv init` to wire agent integration.';
    if (ctx.json) emit(ctx, { phase: 'init', skipped: true, reason: 'escalate', detail: msg });
    else say(ctx, `penv: ${msg}`);
    return;
  }

  // --- Generate scripts (unless they already exist) ---
  if (!skipScripts) {
    const scripts = generateScripts(report);
    mkdirSync(previewDir, { recursive: true });

    const written: string[] = [];
    for (const [name, content] of Object.entries(scripts)) {
      if (!content) continue;
      const path = join(previewDir, name);
      if (existsSync(path) && !force) {
        note(ctx, `penv: skip ${name} (already exists; use --force)`);
        continue;
      }
      writeFileSync(path, content, 'utf8');
      chmodSync(path, 0o755);
      written.push(name);
    }

    const syntaxResults = syntaxCheck(scripts as GeneratedScripts);
    const allOk = syntaxResults.every((r) => r.ok);

    if (ctx.json) {
      emit(ctx, { phase: 'scripts', written, syntax: syntaxResults, allSyntaxOk: allOk });
    } else {
      say(ctx, `penv: wrote ${written.join(', ')} → .preview/`);
      for (const r of syntaxResults) {
        if (r.ok) say(ctx, `  bash -n ${r.script}: ok`);
        else say(ctx, `  bash -n ${r.script}: FAIL — ${r.error ?? 'syntax error'}`);
      }
    }
  }

  // --- Agent integration (idempotent; runs whether or not scripts were generated) ---
  const agentResults = applyAgentIntegration(ctx, root, report);
  if (ctx.json) {
    emit(ctx, { phase: 'agent-integration', ...agentResults });
  }
}

// ---------------------------------------------------------------------------
// Agent integration
// ---------------------------------------------------------------------------

interface AgentIntegrationResult {
  wtWorktreesJson?: 'written' | 'merged' | 'skipped' | 'already-present' | undefined;
  claudeSettingsJson?: 'written' | 'merged' | 'skipped' | 'already-present' | undefined;
  agentDoc?: { file: string; action: 'written' | 'appended' | 'updated' | 'already-present' } | 'none' | undefined;
  worktreeInclude?: 'written' | 'merged' | 'already-present' | undefined;
  codexHooks?: 'written' | 'merged' | 'already-present' | undefined;
}

function applyAgentIntegration(ctx: Ctx, root: string, report: DoctorReport): AgentIntegrationResult {
  const result: AgentIntegrationResult = {};

  // Claude Code: wt worktree hooks + SessionStart/WorktreeCreate/WorktreeRemove
  // hooks (so CC's own worktree creation routes through wt+penv, and sessions in
  // a worktree get the preview ctx injected).
  if (report.agents.includes('claude-code')) {
    // wt integration (symlinked deps + WorktreeCreate/Remove routing) is optional:
    // only wire it when the `wt` provisioner is installed. Without it, penv still
    // scaffolds `.preview/` + the SessionStart context; provision by running
    // `penv up` from the worktree yourself.
    const wt = hasWt();
    if (wt) {
      result.wtWorktreesJson = mergeWtWorktreesJson(ctx, root, report);
    } else {
      result.wtWorktreesJson = 'skipped';
      note(ctx, 'penv: `wt` not found — skipping .wt/worktrees.json + WorktreeCreate/Remove hooks. Run `penv up` from a worktree to provision.');
    }
    writeClaudeHookScripts(ctx, root, wt);
    result.claudeSettingsJson = mergeClaudeSettingsJson(ctx, root, wt);
  }

  // Codex: it can't be handed an externally-provisioned worktree, but it copies
  // ignored local files (.worktreeinclude) and supports a SessionStart hook.
  // Provisioning itself goes in Codex's "Local environment" setup script (`penv up`),
  // which is app-UI-configured — we print that instruction below.
  if (report.agents.includes('codex')) {
    Object.assign(result, writeCodexIntegration(ctx, root));
  }

  // Every repo with an agent instruction file (AGENTS.md / CLAUDE.md) gets a
  // prose block documenting that the repo uses penv — this is the durable,
  // always-in-context signal that worktrees should use penv. Independent of
  // which agent is detected (an AGENTS.md/CLAUDE.md may exist with or without .claude/).
  result.agentDoc = ensureAgentDocBlock(ctx, root, report);

  return result;
}

function mergeWtWorktreesJson(ctx: Ctx, root: string, report: DoctorReport): AgentIntegrationResult['wtWorktreesJson'] {
  if (report.existingPenvIntegration) {
    note(ctx, 'penv: .wt/worktrees.json already has penv integration — skipping');
    return 'already-present';
  }

  // Check if existing worktrees.json has scripts/preview-env.sh style entries
  const wtDir = join(root, '.wt');
  const wtPath = join(wtDir, 'worktrees.json');
  const existing = readTextSafe(wtPath);

  if (existing?.includes('preview-env.sh')) {
    note(ctx, 'penv: .wt/worktrees.json has scripts/preview-env.sh entries — skipping penv injection to avoid duplication');
    return 'skipped';
  }

  mkdirSync(wtDir, { recursive: true });

  let data: Record<string, unknown> = {};
  if (existing) {
    try {
      data = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      note(ctx, 'penv: .wt/worktrees.json is not valid JSON — creating fresh');
    }
  }

  // Merge setup-worktree
  const setup = Array.isArray(data['setup-worktree']) ? (data['setup-worktree'] as string[]) : [];
  if (!setup.includes('penv up')) setup.push('penv up');
  data['setup-worktree'] = setup;

  // Merge teardown-worktree
  const teardown = Array.isArray(data['teardown-worktree']) ? (data['teardown-worktree'] as string[]) : [];
  if (!teardown.includes('penv destroy --force')) teardown.push('penv destroy --force');
  data['teardown-worktree'] = teardown;

  writeFileSync(wtPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  const action = existing ? 'merged' : 'written';
  if (!ctx.json) say(ctx, `penv: ${action} .wt/worktrees.json (penv up / penv destroy --force)`);
  return action;
}

// Claude Code hook scripts (written to .claude/hooks/). Mirrors the proven
// events-discovery pattern, generalized: preview-env.sh → penv, and the wt glue
// is repo-agnostic. PATH is widened because hook shells can be minimal.
const HOOK_PATH_LINE =
  '# Reach common tool + version-manager (mise OR asdf) locations in the minimal\n' +
  '# hook environment. Missing dirs on PATH are ignored, so listing both is safe.\n' +
  'export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:${ASDF_DATA_DIR:-$HOME/.asdf}/shims:$HOME/.bun/bin:$HOME/.local/bin"\n' +
  '_penv="$(command -v penv 2>/dev/null || true)"; [ -n "$_penv" ] && export PATH="$(dirname "$_penv"):$PATH"';

const HOOK_SESSION = `#!/usr/bin/env bash
# Claude Code SessionStart hook — inject penv preview-env context in a worktree.
# Stdout is added to Claude's context. Silent no-op on the main checkout /
# outside a penv repo ("if it's not a driven environment, nothing happens").
${HOOK_PATH_LINE}
command -v penv >/dev/null 2>&1 || exit 0
exec penv session
`;

const HOOK_WT_CREATE = `#!/usr/bin/env bash
# Claude Code WorktreeCreate hook → delegate worktree provisioning to \`wt\`.
# Fires for \`claude --worktree\`, EnterWorktree, and subagent isolation:"worktree".
# stdin: JSON {branch,name,worktree_id,base_path,cwd,...}; stdout: ready worktree path.
set -euo pipefail
${HOOK_PATH_LINE}
INPUT="$(cat)"
BRANCH="$(jq -r '.branch // .name // .worktree_id // empty' <<<"$INPUT")"
PROJECT="$(jq -r '.cwd // empty' <<<"$INPUT")"; PROJECT="\${PROJECT:-\${CLAUDE_PROJECT_DIR:-$PWD}}"
[[ -n "$BRANCH" ]] || { echo "wt-create hook: no branch/name in input" >&2; exit 1; }
WT_BIN="$(command -v wt || true)"
MAIN="$(git -C "$PROJECT" worktree list --porcelain | head -1 | sed 's/^worktree //')"
[[ -n "$MAIN" && -d "$MAIN" ]] || { echo "wt-create hook: no main worktree from $PROJECT" >&2; exit 1; }
cd "$MAIN"
if [[ ! -x "$WT_BIN" ]]; then
  echo "wt-create hook: wt not found, falling back to git worktree add" >&2
  BASE_PATH="$(jq -r '.base_path // empty' <<<"$INPUT")"; WID="$(jq -r '.worktree_id // empty' <<<"$INPUT")"
  DIR="\${BASE_PATH:-$MAIN/.claude/worktrees}/\${WID:-$BRANCH}"; mkdir -p "$(dirname "$DIR")"
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then git worktree add "$DIR" "$BRANCH" >&2; else git worktree add -b "$BRANCH" "$DIR" >&2; fi
  echo "$DIR"; exit 0
fi
EXISTING="$("$WT_BIN" exists --branch "$BRANCH" --json)"
if [[ "$(jq -r '.exists' <<<"$EXISTING")" == "true" ]]; then jq -r '.path' <<<"$EXISTING"; exit 0; fi
RESULT="$("$WT_BIN" create --branch "$BRANCH" --json)" || { echo "wt-create hook: wt create failed: \${RESULT:-}" >&2; exit 1; }
WT_PATH_OUT="$(jq -r '.path // empty' <<<"$RESULT")"
[[ -n "$WT_PATH_OUT" ]] || { echo "wt-create hook: wt create returned no path: $RESULT" >&2; exit 1; }
ISSUE_COUNT="$(jq -r '((.setupWarnings // []) + (.setupErrors // [])) | length' <<<"$RESULT")"
if [[ "$ISSUE_COUNT" -gt 0 ]]; then
  jq -r '((.setupWarnings // []) + (.setupErrors // []))[] | "wt-create hook: setup issue (exit \\(.exitCode)): \\(.command)"' <<<"$RESULT" >&2 || true
  { echo "# Worktree provisioning issues"; echo;
    echo "Setup commands failed during \\\`wt create\\\` (Claude Code WorktreeCreate hook). The worktree is";
    echo "usable, but parts of the environment may be missing (installs / .env.preview).";
    echo; echo "Fix, then: wt setup $(basename "$WT_PATH_OUT") && rm .wt-setup-issues.md"; echo;
    jq -r '((.setupWarnings // []) + (.setupErrors // []))[] | "## \\(.command) (exit \\(.exitCode))\\n\\n\\\`\\\`\\\`\\n\\(.stderr // "<no stderr>")\\n\\\`\\\`\\\`\\n"' <<<"$RESULT"; } > "$WT_PATH_OUT/.wt-setup-issues.md"
fi
echo "$WT_PATH_OUT"
`;

const HOOK_WT_REMOVE = `#!/usr/bin/env bash
# Claude Code WorktreeRemove hook → delegate cleanup to \`wt remove\` (runs the
# teardown-worktree commands, including \`penv destroy\`), then deletes the branch.
# stdin: JSON {worktree_id, worktree_path, cwd, ...}
set -euo pipefail
${HOOK_PATH_LINE}
INPUT="$(cat)"
TARGET="$(jq -r '.worktree_path // empty' <<<"$INPUT")"
[[ -n "$TARGET" ]] || { echo "wt-remove hook: no worktree_path in input" >&2; exit 1; }
[[ -d "$TARGET" ]] || exit 0 # already gone
WT_BIN="$(command -v wt || true)"
MAIN="$(git -C "$TARGET" worktree list --porcelain | head -1 | sed 's/^worktree //')"
if [[ ! -x "$WT_BIN" ]]; then
  echo "wt-remove hook: wt not found, falling back to git worktree remove" >&2
  git -C "\${MAIN:-$TARGET}" worktree remove --force "$TARGET" >&2; exit 0
fi
cd "\${MAIN:-/}"
"$WT_BIN" remove "$TARGET" --force --delete-branch --json >&2 || { echo "wt-remove hook: wt remove failed" >&2; exit 1; }
`;

/** Write the three Claude Code hook scripts (kept if already present). */
function writeClaudeHookScripts(ctx: Ctx, root: string, wt = true): void {
  const dir = join(root, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  // penv-session.sh (preview-context injection) is always useful; the wt-create/
  // wt-remove hooks only make sense when the `wt` provisioner is installed.
  const scripts: Record<string, string> = wt
    ? { 'penv-session.sh': HOOK_SESSION, 'wt-create.sh': HOOK_WT_CREATE, 'wt-remove.sh': HOOK_WT_REMOVE }
    : { 'penv-session.sh': HOOK_SESSION };
  for (const [name, body] of Object.entries(scripts)) {
    const p = join(dir, name);
    if (existsSync(p)) {
      note(ctx, `penv: .claude/hooks/${name} already exists — keeping`);
      continue;
    }
    writeFileSync(p, body, 'utf8');
    chmodSync(p, 0o755);
    if (!ctx.json) say(ctx, `penv: wrote .claude/hooks/${name}`);
  }
}

/** Merge SessionStart + WorktreeCreate + WorktreeRemove hooks into settings.json. */
function mergeClaudeSettingsJson(ctx: Ctx, root: string, wt = true): AgentIntegrationResult['claudeSettingsJson'] {
  const settingsPath = join(root, '.claude', 'settings.json');
  const existing = readTextSafe(settingsPath);

  let data: Record<string, unknown> = {};
  if (existing) {
    try {
      data = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      note(ctx, 'penv: .claude/settings.json is not valid JSON — skipping hook merge');
      return 'skipped';
    }
  }

  const hooksRaw = data['hooks'];
  const hooks: Record<string, unknown> =
    hooksRaw && typeof hooksRaw === 'object' && !Array.isArray(hooksRaw)
      ? (hooksRaw as Record<string, unknown>)
      : {};

  // A superseded penv entry references the v1 inline `penv status` hook (malformed
  // OR well-formed) but not the current `penv-session.sh` — drop it so re-running
  // upgrades cleanly to the hook-script form.
  const isSupersededPenv = (h: unknown): boolean => {
    if (typeof h !== 'object' || h === null) return false;
    const s = JSON.stringify(h);
    return s.includes('penv status') && !s.includes('penv-session.sh');
  };

  const cp = '"$CLAUDE_PROJECT_DIR"/.claude/hooks';
  let changed = false;
  let hadLegacy = false;

  const ensure = (event: string, marker: string, entry: unknown) => {
    let arr = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const before = arr.length;
    arr = arr.filter((h) => !isSupersededPenv(h));
    if (arr.length !== before) hadLegacy = true;
    if (!arr.some((h) => JSON.stringify(h).includes(marker))) {
      arr.push(entry);
      changed = true;
    }
    hooks[event] = arr;
  };

  ensure('SessionStart', 'penv-session.sh', {
    matcher: 'startup|resume|clear|compact',
    hooks: [{ type: 'command', command: `${cp}/penv-session.sh`, timeout: 30 }],
  });
  // WorktreeCreate/Remove route through the `wt` provisioner — only wire them
  // when wt is installed (writeClaudeHookScripts likewise skips the scripts).
  if (wt) {
    ensure('WorktreeCreate', 'wt-create.sh', {
      hooks: [{ type: 'command', command: `${cp}/wt-create.sh`, timeout: 900 }],
    });
    ensure('WorktreeRemove', 'wt-remove.sh', {
      hooks: [{ type: 'command', command: `${cp}/wt-remove.sh`, timeout: 300 }],
    });
  }

  if (!changed && !hadLegacy) {
    note(ctx, 'penv: .claude/settings.json already has penv hooks — skipping');
    return 'already-present';
  }

  data['hooks'] = hooks;
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  const action = existing ? 'merged' : 'written';
  if (!ctx.json) {
    const which = wt ? 'SessionStart + WorktreeCreate + WorktreeRemove hooks' : 'SessionStart hook';
    say(ctx, `penv: ${action} .claude/settings.json (${which}${hadLegacy ? ' — upgraded legacy' : ''})`);
  }
  return action;
}

// Codex SessionStart hook — emits JSON (Codex reads stdout JSON, unlike Claude
// Code which injects raw stdout). `penv session --json` wraps the ctx block.
const HOOK_CODEX_SESSION = `#!/usr/bin/env bash
# Codex SessionStart hook — inject penv preview-env ctx as JSON. {} on main.
${HOOK_PATH_LINE}
command -v penv >/dev/null 2>&1 || { echo '{}'; exit 0; }
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" 2>/dev/null || true
exec penv session --json
`;

/**
 * Codex integration. Codex can't be handed an externally-provisioned worktree,
 * so penv leans on what Codex *does* support: `.worktreeinclude` (copy ignored
 * local config into managed worktrees) + a SessionStart hook (ctx injection).
 * Provisioning itself belongs in Codex's app-configured "Local environment"
 * setup script (`penv up`) — we can only print that instruction.
 */
function writeCodexIntegration(
  ctx: Ctx,
  root: string,
): Pick<AgentIntegrationResult, 'worktreeInclude' | 'codexHooks'> {
  const result: Pick<AgentIntegrationResult, 'worktreeInclude' | 'codexHooks'> = {};

  // 1. .worktreeinclude — ignored local config Codex should copy into a worktree.
  const wiPath = join(root, '.worktreeinclude');
  const wiWant = ['.env', '.env.local'];
  const wiExisting = readTextSafe(wiPath);
  if (wiExisting === null) {
    writeFileSync(wiPath, `# penv: copy ignored local config into Codex-managed worktrees\n${wiWant.join('\n')}\n`, 'utf8');
    result.worktreeInclude = 'written';
    if (!ctx.json) say(ctx, 'penv: wrote .worktreeinclude (.env, .env.local)');
  } else {
    const lines = wiExisting.split('\n').map((l) => l.trim());
    const missing = wiWant.filter((p) => !lines.includes(p));
    if (missing.length) {
      const sep = wiExisting.endsWith('\n') ? '' : '\n';
      writeFileSync(wiPath, `${wiExisting}${sep}# penv\n${missing.join('\n')}\n`, 'utf8');
      result.worktreeInclude = 'merged';
      if (!ctx.json) say(ctx, `penv: merged .worktreeinclude (+${missing.join(', ')})`);
    } else {
      result.worktreeInclude = 'already-present';
    }
  }

  // 2. .codex/hooks/penv-session.sh wrapper.
  const hooksDir = join(root, '.codex', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const wrapperPath = join(hooksDir, 'penv-session.sh');
  if (!existsSync(wrapperPath)) {
    writeFileSync(wrapperPath, HOOK_CODEX_SESSION, 'utf8');
    chmodSync(wrapperPath, 0o755);
    if (!ctx.json) say(ctx, 'penv: wrote .codex/hooks/penv-session.sh');
  }

  // 3. .codex/hooks.json — SessionStart → wrapper.
  const hjPath = join(root, '.codex', 'hooks.json');
  const hjExisting = readTextSafe(hjPath);
  let data: Record<string, unknown> = {};
  if (hjExisting) {
    try {
      data = JSON.parse(hjExisting) as Record<string, unknown>;
    } catch {
      note(ctx, 'penv: .codex/hooks.json is not valid JSON — skipping');
      return result;
    }
  }
  const hooks: Record<string, unknown> =
    data['hooks'] && typeof data['hooks'] === 'object' && !Array.isArray(data['hooks'])
      ? (data['hooks'] as Record<string, unknown>)
      : {};
  const ss = Array.isArray(hooks['SessionStart']) ? (hooks['SessionStart'] as unknown[]) : [];
  if (ss.some((h) => JSON.stringify(h).includes('penv-session.sh'))) {
    result.codexHooks = 'already-present';
  } else {
    ss.push({ matcher: 'startup|resume', hooks: [{ type: 'command', command: '.codex/hooks/penv-session.sh', timeout: 30 }] });
    hooks['SessionStart'] = ss;
    data['hooks'] = hooks;
    writeFileSync(hjPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    result.codexHooks = hjExisting ? 'merged' : 'written';
    if (!ctx.json) say(ctx, `penv: ${result.codexHooks} .codex/hooks.json (SessionStart → penv session)`);
  }

  // 4. The one step we can't write — Codex's setup script is app-UI-configured.
  if (!ctx.json) {
    say(ctx, 'penv: NEXT (Codex) — set the worktree setup script to `penv up` in the Codex app');
    say(ctx, '      (Settings → Local environments) so managed worktrees auto-provision.');
  }
  return result;
}

const PENV_DOC_MARKER = '<!-- penv:preview-environments -->';
const PENV_DOC_END = '<!-- /penv:preview-environments -->';

function penvDocBlock(report: DoctorReport): string {
  const resources =
    report.tier === 0
      ? 'its own data dir + ports'
      : 'its own database, cache index, and ports';
  return `${PENV_DOC_MARKER}
## Preview environments (penv)

This repo uses **penv** for per-worktree isolation: each git worktree gets ${resources},
so parallel worktrees never collide and never share the dev database. On the main
checkout penv is a no-op.

- \`penv up\` provisions this worktree's env and writes \`.env.preview\` (connection
  strings / ports). \`penv status\` shows the allocation, \`penv verify\` checks it,
  \`penv destroy\` tears it down.
- Lifecycle scripts live in \`.preview/\`. \`wt\` worktrees run \`penv up\` / \`penv destroy\`
  automatically (see \`.wt/worktrees.json\`).
- **Starting work in a worktree?** If \`penv status\` shows it isn't provisioned yet, run
  \`penv up\` first (idempotent), then source \`.env.preview\`. Claude Code runs this via
  hooks automatically; **Codex / other agents should run \`penv up\` themselves**.
- When working inside a worktree, source \`.env.preview\` (or let direnv / dotenv load it)
  so the app uses the isolated resources instead of the shared dev ones.
${PENV_DOC_END}`;
}

/**
 * Write a "this repo uses penv" prose block into the repo's agent instruction
 * file. Prefers AGENTS.md (the canonical doc; CLAUDE.md is often just `@AGENTS.md`),
 * falls back to CLAUDE.md. Idempotent via a marker comment.
 */
function ensureAgentDocBlock(ctx: Ctx, root: string, report: DoctorReport): AgentIntegrationResult['agentDoc'] {
  const agentsPath = join(root, 'AGENTS.md');
  const claudePath = join(root, 'CLAUDE.md');
  const hasAgents = existsSync(agentsPath);
  const hasClaude = existsSync(claudePath);

  // Prefer AGENTS.md. Fall back to CLAUDE.md when present. If neither exists but
  // the repo uses Claude Code (.claude/), create a CLAUDE.md so the "use penv"
  // signal still has a durable, always-in-context home.
  let targetPath: string;
  if (hasAgents) {
    targetPath = agentsPath;
  } else if (hasClaude) {
    targetPath = claudePath;
  } else if (report.agents.includes('claude-code')) {
    targetPath = claudePath; // create it
  } else {
    return 'none';
  }

  const existing = readTextSafe(targetPath) ?? '';
  const fileLabel = targetPath === agentsPath ? 'AGENTS.md' : 'CLAUDE.md';
  const block = penvDocBlock(report);
  const start = existing.indexOf(PENV_DOC_MARKER);

  // Update an existing block in place (so re-running init refreshes the content,
  // e.g. to pick up new agent guidance). Bounded by the end marker when present;
  // legacy blocks (no end marker) ran to EOF since they were appended last.
  if (start >= 0) {
    const endMarker = existing.indexOf(PENV_DOC_END, start);
    const end = endMarker >= 0 ? endMarker + PENV_DOC_END.length : existing.length;
    if (existing.slice(start, end).trim() === block.trim()) {
      note(ctx, `penv: ${fileLabel} penv section already up to date — skipping`);
      return { file: fileLabel, action: 'already-present' };
    }
    const before = existing.slice(0, start).replace(/\s+$/, '');
    const after = existing.slice(end).replace(/^\s+/, '');
    const next = `${before}${before ? '\n\n' : ''}${block}${after ? `\n\n${after}` : '\n'}`;
    writeFileSync(targetPath, next, 'utf8');
    if (!ctx.json) say(ctx, `penv: updated ${fileLabel} (## Preview environments (penv) section)`);
    return { file: fileLabel, action: 'updated' };
  }

  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(targetPath, existing + sep + block + '\n', 'utf8');
  const action = existing ? 'appended' : 'written';
  if (!ctx.json) say(ctx, `penv: ${action} ${fileLabel} (## Preview environments (penv) section)`);
  return { file: fileLabel, action };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function reportToJson(report: DoctorReport): Record<string, unknown> {
  return {
    root: report.root,
    tier: report.tier,
    tierReason: report.tierReason,
    confidence: report.confidence,
    run: report.run,
    runCommand: report.runCommand,
    migration: report.migration,
    packageManager: report.packageManager,
    envVars: report.envVars,
    statefulServices: report.statefulServices,
    agents: report.agents,
    existingPreview: report.existingPreview,
    existingScripts: report.existingScripts,
    existingPenvIntegration: report.existingPenvIntegration,
    existingOtherPreview: report.existingOtherPreview,
    blockers: report.blockers,
  };
}

function printReport(ctx: Ctx, report: DoctorReport): void {
  say(ctx, `penv doctor — ${report.root}`);
  say(ctx, ``);
  say(ctx, `  tier:       ${report.tier} (${report.tierReason})`);
  say(ctx, `  confidence: ${report.confidence}`);
  say(ctx, `  run:        ${report.run}${report.runCommand ? ` (${report.runCommand})` : ''}`);
  say(ctx, `  migration:  ${report.migration}`);
  say(ctx, `  pkg-mgr:    ${report.packageManager}`);
  say(ctx, `  agents:     ${report.agents.length ? report.agents.join(', ') : 'none'}`);
  if (report.statefulServices.length) {
    say(ctx, `  services:   ${report.statefulServices.map((s) => `${s.name} (${s.source})`).join(', ')}`);
  }
  if (report.envVars.length) {
    say(ctx, `  env vars:   ${report.envVars.map((v) => v.key).join(', ')}`);
  }
  if (report.existingPreview) {
    say(ctx, `  existing:   .preview/{${report.existingScripts.join(', ')}} (present)`);
  }
  if (report.existingOtherPreview) {
    say(ctx, `  existing:   scripts/preview-env.sh or .wt/worktrees.json preview entries (non-penv)`);
  }
  if (report.existingPenvIntegration) {
    say(ctx, `  penv-wt:    already integrated in .wt/worktrees.json`);
  }
  if (report.blockers.length) {
    say(ctx, ``);
    say(ctx, `  blockers:`);
    for (const b of report.blockers) {
      say(ctx, `    [${b.kind}] ${b.detail}${b.file ? ` (${b.file})` : ''}`);
    }
  }
}
