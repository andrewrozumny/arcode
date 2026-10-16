#!/usr/bin/env bash
# Quality gates for Acode: the one definition used by the terminal and by Acode's own
# Gate buttons (which run `scripts/gates.sh <target>` in the open project).
#
#   scripts/gates.sh            # same as `all`
#   scripts/gates.sh lint       # ESLint (zero warnings) + TypeScript
#   scripts/gates.sh test       # Vitest
#   scripts/gates.sh build      # production bundle into out/
#   scripts/gates.sh all        # lint, test and build
#   scripts/gates.sh deploy     # preflight: everything above plus a clean-tree check; never ships
#
# Green means zero errors. Compatible with the bash 3.2 that ships with macOS.

set -o pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# IDE run buttons start outside a login shell, so Homebrew may be missing from PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

FAILED=""
FAILED_N=0

step() {
  printf '\n\033[1m▶ %s\033[0m\n' "$*"
  if "$@"; then
    printf '\033[32m✔ %s\033[0m\n' "$*"
  else
    printf '\033[31m✘ %s (exit %d)\033[0m\n' "$*" "$?"
    FAILED="${FAILED}   · $*
"
    FAILED_N=$((FAILED_N + 1))
  fi
}

lint()  { step pnpm run lint; step pnpm run typecheck; }
test_() { step pnpm run test; }
build() { step pnpm run build; }

case "${1:-all}" in
  lint) lint ;;
  test) test_ ;;
  build) build ;;
  all) lint; test_; build ;;
  deploy)
    lint; test_; build
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
      printf '\n\033[33m⚠ Working tree has uncommitted changes:\033[0m\n'
      git status --short
    fi
    printf '\nThis gate is a preflight only. To package the app run `pnpm dist` (see README).\n'
    ;;
  *)
    echo "Usage: scripts/gates.sh [all|lint|test|build|deploy]" >&2
    exit 2
    ;;
esac

echo
if [ "$FAILED_N" -eq 0 ]; then
  printf '\033[32m━━ GATES GREEN ━━\033[0m\n'
else
  printf '\033[31m━━ GATES RED: %d failed ━━\033[0m\n%s' "$FAILED_N" "$FAILED"
  exit 1
fi
