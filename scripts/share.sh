#!/usr/bin/env bash
# Serve sim-remote over https so teammates on the LAN can use it.
# WebCodecs needs a secure context; plain http only works on localhost.
set -euo pipefail

PORT="${SIM_REMOTE_PORT:-8080}"
TLS_PORT="${SIM_REMOTE_TLS_PORT:-8443}"

# First non-loopback IPv4 address is what teammates will use.
LAN_HOST="${SIM_REMOTE_LAN_HOST:-$(ipconfig getifaddr en0 2>/dev/null || true)}"
if [ -z "$LAN_HOST" ]; then
  LAN_HOST=$(ifconfig 2>/dev/null | awk '/inet /  && $2 != "127.0.0.1" { print $2; exit }')
fi
if [ -z "$LAN_HOST" ]; then
  echo "Could not determine a LAN address. Set SIM_REMOTE_LAN_HOST=<ip> and retry." >&2
  exit 1
fi
export SIM_REMOTE_LAN_HOST="$LAN_HOST" SIM_REMOTE_TLS_PORT="$TLS_PORT" SIM_REMOTE_PORT="$PORT"

caddy start --config Caddyfile >/dev/null
trap 'caddy stop >/dev/null 2>&1 || true' EXIT INT TERM

echo "https via Caddy on $LAN_HOST:$TLS_PORT (self-signed — expect a one-time browser warning)"
echo

# Bind the app to loopback only: Caddy is the front door.
exec node src/server/index.ts \
  --host 127.0.0.1 --port "$PORT" \
  --public-origin "https://${LAN_HOST}:${TLS_PORT}" "$@"
