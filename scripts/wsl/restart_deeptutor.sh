#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
PORTS=(8001 3782)
LOG_DIR="$HOME/.local/state/deeptutor"
LOG="$LOG_DIR/restart.log"

mkdir -p "$LOG_DIR"
exec > >(tee "$LOG") 2>&1
printf '\n[%s] Restarting DeepTutor\n' "$(date --iso-8601=seconds)"

# Windows shortcuts start WSL without the interactive shell that normally
# activates nvm, so expose the installed Node/npm explicitly.
NODE_BIN=$(find "$HOME/.nvm/versions/node" -mindepth 2 -maxdepth 2 -type d -name bin 2>/dev/null | sort -V | tail -n 1)
if [[ ! -x "$NODE_BIN/npm" ]]; then
	echo "Node.js/npm not found under $HOME/.nvm/versions/node." >&2
	exit 1
fi
export PATH="$NODE_BIN:$HOME/.local/bin:$PATH"

# Stop the listeners on DeepTutor's dedicated ports. The old launcher notices
# its child exit, shuts down the other child, and exits cleanly.
for port in "${PORTS[@]}"; do
	fuser -k -TERM "${port}/tcp" >/dev/null 2>&1 || true
done

for _ in {1..50}; do
	busy=false
	for port in "${PORTS[@]}"; do
		if fuser "${port}/tcp" >/dev/null 2>&1; then
			busy=true
			break
		fi
	done
	"$busy" || break
	sleep 0.2
done

# A crashed dev server can leave a stale lock even after its port is free.
rm -f "$PROJECT/web/.next/dev/lock" "$PROJECT/web/.next/lock"

cd "$PROJECT"
exec "$PROJECT/.venv/bin/deeptutor" start --home "$PROJECT"
