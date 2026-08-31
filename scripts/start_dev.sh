#!/usr/bin/env bash
# Bring up the full local PatchBook stack: the vote Worker (Cloudflare workerd
# + a local D1) and the site preview, wired together.
#
# Usage:
#   ./scripts/start_dev.sh            # Flask preview (no Ruby needed)
#   ./scripts/start_dev.sh --jekyll   # the real production renderer
#
#   WORKER_PORT=3003 SITE_PORT=3004 ./scripts/start_dev.sh
#
# While running, `votes_api` in _config.yml is pointed at the local Worker. It
# is restored on exit — committing that line would silently break votes in
# production, which is the whole reason this script exists.
#
# Ctrl-C stops both processes.
set -euo pipefail

SITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_DIR="$SITE_DIR/worker"
CONFIG="$SITE_DIR/_config.yml"

WORKER_PORT="${WORKER_PORT:-3003}"
SITE_PORT="${SITE_PORT:-3004}"
USE_JEKYLL=0
[[ "${1:-}" == "--jekyll" ]] && USE_JEKYLL=1

WORKER_PID=""
SITE_PID=""
CONFIG_BACKUP=""

cleanup() {
  trap - EXIT INT TERM
  echo
  echo "[*] Shutting down…"
  [[ -n "$SITE_PID"   ]] && kill "$SITE_PID"   2>/dev/null || true
  [[ -n "$WORKER_PID" ]] && kill "$WORKER_PID" 2>/dev/null || true
  # Restore _config.yml even if we were killed mid-run.
  if [[ -n "$CONFIG_BACKUP" && -f "$CONFIG_BACKUP" ]]; then
    mv "$CONFIG_BACKUP" "$CONFIG"
    echo "[*] Restored votes_api in _config.yml"
  fi
}
trap cleanup EXIT INT TERM

# ── preflight ────────────────────────────────────────────────────────────────

if [[ ! -d "$WORKER_DIR/node_modules" ]]; then
  echo "[*] Installing worker dependencies…"
  (cd "$WORKER_DIR" && npm install --silent)
fi

if [[ ! -f "$WORKER_DIR/.dev.vars" ]]; then
  echo "[*] Creating .dev.vars from the example (add your dev OAuth app's"
  echo "    credentials to it if you want to test the GitHub login flow)."
  cp "$WORKER_DIR/.dev.vars.example" "$WORKER_DIR/.dev.vars"
fi

# The local D1 is keyed by database_id, so changing that in wrangler.toml
# orphans the old database. Re-applying the schema is idempotent and cheap.
echo "[*] Ensuring the local D1 schema exists…"
(cd "$WORKER_DIR" && npm run --silent db:local >/dev/null 2>&1) \
  || { echo "[!] Could not apply schema.sql to the local D1." >&2; exit 1; }

# The Worker only serves CORS headers and accepts OAuth returns for origins in
# [env.dev].ALLOWED_ORIGINS. A site port outside that list renders fine, but the
# counts fetch is blocked and login 400s — so check it up front.
#
# Read the value out of the section rather than by line offset: a comment added
# above it must not turn this check into a no-op that always warns.
DEV_ORIGINS="$(awk '
  /^\[env\.dev\.vars\]/ { in_section = 1; next }
  /^\[/                 { in_section = 0 }
  in_section && /^ALLOWED_ORIGINS/ { print; exit }
' "$WORKER_DIR/wrangler.toml")"

if [[ -z "$DEV_ORIGINS" ]]; then
  echo "[!] No ALLOWED_ORIGINS found under [env.dev.vars] in wrangler.toml." >&2
elif [[ "$DEV_ORIGINS" != *"127.0.0.1:${SITE_PORT}"* && "$DEV_ORIGINS" != *"localhost:${SITE_PORT}"* ]]; then
  echo "[!] Port $SITE_PORT is not in [env.dev].ALLOWED_ORIGINS (wrangler.toml)."
  echo "    Vote counts will fail to load and GitHub login will return 400."
  echo "    Add both http://127.0.0.1:${SITE_PORT} and http://localhost:${SITE_PORT}"
  echo "    — browsers treat them as different origins."
fi

# ── vote API ─────────────────────────────────────────────────────────────────

# --ip 0.0.0.0 is load-bearing in a container. wrangler binds 127.0.0.1 by
# default, and this repo's container.sh publishes ports with `docker run -p`,
# which cannot reach a loopback-bound service inside the container. The site
# would load (serve.py binds 0.0.0.0) while every vote request from the host
# browser failed — with the API perfectly reachable from inside via curl.
echo "[*] Starting the vote Worker on port $WORKER_PORT…"
(cd "$WORKER_DIR" && npx wrangler dev --env dev --local --port "$WORKER_PORT" --ip 0.0.0.0 >/dev/null 2>&1) &
WORKER_PID=$!

for _ in $(seq 1 40); do
  if curl -fsS -m 2 "http://127.0.0.1:${WORKER_PORT}/api/me" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS -m 2 "http://127.0.0.1:${WORKER_PORT}/api/me" >/dev/null 2>&1; then
  echo "[!] The Worker did not come up on port $WORKER_PORT." >&2
  exit 1
fi
echo "[+] Vote API ready  →  http://127.0.0.1:${WORKER_PORT}"

# curl from inside the container succeeds even when the browser on the host
# cannot connect, so confirm the socket is not loopback-only. This exact
# asymmetry made the API look healthy while every vote failed.
if ! python3 - "$WORKER_PORT" <<'PYEOF'
import struct, sys
want = int(sys.argv[1])
for path, v6 in (("/proc/net/tcp", False), ("/proc/net/tcp6", True)):
    try:
        rows = open(path).read().splitlines()[1:]
    except OSError:
        continue
    for row in rows:
        f = row.split()
        addr, port = f[1].split(":")
        if int(port, 16) != want or f[3] != "0A":
            continue
        if v6:
            if int(addr, 16) == 1:      # ::1
                continue
        elif ".".join(str(b) for b in struct.pack("<I", int(addr, 16))) == "127.0.0.1":
            continue
        sys.exit(0)                     # reachable from outside loopback
sys.exit(1)
PYEOF
then
  echo "[!] The Worker is listening on loopback only."
  echo "    Inside this container that is invisible to curl but fatal to the"
  echo "    browser on your host: container.sh publishes ports with 'docker -p',"
  echo "    which cannot reach a loopback-bound socket. Pass --ip 0.0.0.0."
fi

# ── point the site at it ─────────────────────────────────────────────────────

CONFIG_BACKUP="$(mktemp)"
cp "$CONFIG" "$CONFIG_BACKUP"
sed -i "s|^votes_api:.*|votes_api: \"http://127.0.0.1:${WORKER_PORT}\"|" "$CONFIG"
echo "[*] votes_api → http://127.0.0.1:${WORKER_PORT} (restored on exit)"

# ── site ─────────────────────────────────────────────────────────────────────

if [[ "$USE_JEKYLL" == "1" ]]; then
  echo "[*] Starting Jekyll on port $SITE_PORT…"
  (cd "$SITE_DIR" && ./serve.sh "$SITE_PORT") &
else
  echo "[*] Starting the Flask preview on port $SITE_PORT…"
  echo "    (note: serve.py does not evaluate Liquid — use --jekyll before pushing)"
  (cd "$SITE_DIR" && python3 serve.py "$SITE_PORT") &
fi
SITE_PID=$!

echo
echo "[+] PatchBook dev stack up:"
echo "      site      http://127.0.0.1:${SITE_PORT}/  (or http://localhost:${SITE_PORT}/)"
echo "      vote API  http://127.0.0.1:${WORKER_PORT}/"
echo
# GitHub matches this string exactly — host, port and path. It is the single
# most common reason sign-in fails, and it is invisible until after consent.
echo "    Your dev OAuth app's Authorization callback URL must be EXACTLY:"
echo "      http://127.0.0.1:${WORKER_PORT}/auth/callback"
echo "    (github.com/settings/developers → your dev app. Not localhost, not ${SITE_PORT}.)"
echo
echo "    Ctrl-C to stop both."
echo

# Exit as soon as either process dies, so a crashed Worker doesn't leave a
# half-working site behind.
wait -n "$WORKER_PID" "$SITE_PID"
