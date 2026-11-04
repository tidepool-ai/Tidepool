#!/usr/bin/env bash
# Installs dependencies at the start of a Claude Code cloud session.
# Runs from the SessionStart hook in .claude/settings.json; does nothing on local machines.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

if [ ! -d "$ROOT/web/node_modules" ]; then
  (cd "$ROOT/web" && npm ci --no-audit --no-fund --loglevel=error)
fi

python3 -m pip install --quiet --disable-pip-version-check -r "$ROOT/api/requirements-dev.txt" \
  || python3 -m pip install --quiet --disable-pip-version-check --break-system-packages -r "$ROOT/api/requirements-dev.txt"

echo "Tidepool dependencies ready (web + api)."
