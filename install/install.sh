#!/usr/bin/env bash
# install.sh — penv installer
#
# Usage:
#   curl -fsSL https://TODO_RELEASE_URL/install.sh | sh
#   # or, to build from a local checkout:
#   bash install.sh --from-source
#
# Idempotent and safe to re-run.
set -euo pipefail

# ── TODO: release download ────────────────────────────────────────────────────
# When release hosting exists, replace the BUILD_ONLY guard below with a
# platform-dispatch download block. Expected URL shape:
#
#   BASE=https://releases.example.com/penv
#   curl -fsSL "$BASE/v${VERSION}/${os}-${arch}/penv" -o "$TARGET/penv"
#   curl -fsSL "$BASE/v${VERSION}/${os}-${arch}/penv" -o "$TARGET/penv"
#
# For now the --from-source path is the only implemented path.
# The download block is a clearly-marked TODO so the shape is obvious when
# release infra is ready.
# ─────────────────────────────────────────────────────────────────────────────

TARGET="${PENV_INSTALL_DIR:-$HOME/.local/bin}"
FROM_SOURCE=0

# ── parse flags ──────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --from-source) FROM_SOURCE=1 ;;
    --help|-h)
      echo "Usage: install.sh [--from-source]"
      echo ""
      echo "  --from-source   Build penv from the local checkout (requires bun)"
      echo ""
      echo "Without --from-source, a pre-built binary would be downloaded from the"
      echo "release server (not yet available — use --from-source for now)."
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg  (try --help)" >&2
      exit 1
      ;;
  esac
done

# ── if not --from-source, would download; for now error with guidance ────────
if [ "$FROM_SOURCE" = "0" ]; then
  cat >&2 <<'EOF'
penv installer: pre-built binaries are not yet hosted.

Run with --from-source to build from the local checkout:

  bash install.sh --from-source

Requires: bun (https://bun.sh)
EOF
  exit 1
fi

# ── --from-source: find the local checkout ───────────────────────────────────
# Resolve the tooling repo root from this script's location.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ ! -f "$REPO_ROOT/penv/cli.ts" ]; then
  echo "install.sh: cannot find penv/cli.ts under $REPO_ROOT" >&2
  echo "Run this script from inside the tooling repo checkout." >&2
  exit 1
fi

# Require bun
if ! command -v bun >/dev/null 2>&1; then
  cat >&2 <<'EOF'
install.sh: bun is required to build from source.

Install it with:
  curl -fsSL https://bun.sh/install | bash

Then re-run this installer.
EOF
  exit 1
fi

# ── detect OS / arch for informational output only ───────────────────────────
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH="x64"  ;;
  aarch64) ARCH="arm64" ;;
  arm64)   ARCH="arm64" ;;
esac
echo "penv installer: building for $OS/$ARCH from $REPO_ROOT"

# ── create install target ────────────────────────────────────────────────────
mkdir -p "$TARGET"

# ── build penv ───────────────────────────────────────────────────────────────
PENV_ENTRY="$REPO_ROOT/penv/entry.ts"
if [ ! -f "$PENV_ENTRY" ]; then
  # Fall back to cli.ts if entry.ts doesn't exist yet
  PENV_ENTRY="$REPO_ROOT/penv/cli.ts"
fi

echo "penv installer: compiling penv → $TARGET/penv"
bun build "$PENV_ENTRY" \
  --compile \
  --outfile "$TARGET/penv" \
  --target "bun"

chmod +x "$TARGET/penv"

# ── verify the binary works ───────────────────────────────────────────────────
"$TARGET/penv" --help >/dev/null 2>&1 \
  && echo "penv installer: penv binary OK" \
  || { echo "penv installer: WARNING — penv binary did not respond to --help" >&2; }

# ── ensure ~/.local/bin is on PATH ───────────────────────────────────────────
# Detect the user's shell rc file
if [ -n "${ZDOTDIR:-}" ] && [ -f "$ZDOTDIR/.zshrc" ]; then
  RC_FILE="$ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  RC_FILE="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  RC_FILE="$HOME/.bashrc"
elif [ -f "$HOME/.bash_profile" ]; then
  RC_FILE="$HOME/.bash_profile"
else
  RC_FILE="$HOME/.bashrc"
fi

MARKER_START="# >>> penv installer >>>"
MARKER_END="# <<< penv installer <<<"

# Only append if the block is not already present (idempotent)
if grep -qF "$MARKER_START" "$RC_FILE" 2>/dev/null; then
  echo "penv installer: PATH block already present in $RC_FILE"
else
  cat >>"$RC_FILE" <<EOF

$MARKER_START
export PATH="$TARGET:\$PATH"
$MARKER_END
EOF
  echo "penv installer: added $TARGET to PATH in $RC_FILE"
fi

# ── print next steps ─────────────────────────────────────────────────────────
cat <<EOF

penv installer: done!

  Binary: $TARGET/penv
  Shell:  $RC_FILE

To activate in the current shell:
  export PATH="$TARGET:\$PATH"

Or open a new terminal.

Next steps:
  penv --help          See all commands
  penv doctor          Detect your repo's stack and suggest a sample
  penv init            Generate .preview/* scripts for this repo

EOF
