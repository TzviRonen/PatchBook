#!/usr/bin/env bash
# Build and serve the PatchBook Jekyll site for local preview — the same
# renderer GitHub Pages uses, so the community-validation UI looks identical
# to production.
#
# Usage:
#   ./serve.sh           # auto-pick a free port from $CONTAINER_PORTS, else 4000
#   ./serve.sh 4000      # use a specific port
#
# Run ./setup.sh first if Jekyll isn't installed.
set -euo pipefail

SITE_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v jekyll >/dev/null 2>&1; then
  echo "[!] jekyll not found — run ./setup.sh first." >&2
  exit 1
fi

# Pick a port: explicit argument wins; otherwise the first free port in
# $CONTAINER_PORTS; otherwise 4000.
PORT="${1:-}"
if [[ -z "$PORT" ]]; then
  if [[ -n "${CONTAINER_PORTS:-}" ]]; then
    for p in $CONTAINER_PORTS; do
      if ! ss -tlnp 2>/dev/null | awk '{print $4}' | grep -qE ":${p}$"; then
        PORT="$p"
        break
      fi
    done
    if [[ -z "$PORT" ]]; then
      echo "[!] All ports in CONTAINER_PORTS ($CONTAINER_PORTS) are in use." >&2
      exit 1
    fi
  else
    PORT=4000
  fi
fi

cd "$SITE_DIR"
echo "[*] Starting PatchBook (Jekyll) on port $PORT  →  http://localhost:${PORT}/"

# JEKYLL_NO_BUNDLER=1 : use the globally-installed gems (the Gemfile is only
#                       needed for the GitHub Pages CI build).
# --baseurl ""        : serve at the root locally so http://localhost:$PORT/
#                       works (production keeps baseurl "/patchbook").
exec env JEKYLL_NO_BUNDLER=1 jekyll serve --host 0.0.0.0 --port "$PORT" --baseurl "" --watch
