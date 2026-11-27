#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/data}"
APP_DIR="${APP_DIR:-/app}"
STATE="$DATA_DIR/state.env"
CONFIG="$DATA_DIR/config.json"
PANEL_PORT="${PORT:-8080}"
VPN_PORT="${VPN_PORT:-8443}"
SNI="${SNI:-www.microsoft.com}"
NODE_NAME="${NODE_NAME:-railway}"

mkdir -p "$DATA_DIR"

if [ "${RESET_KEYS:-0}" = "1" ]; then
    sh "$APP_DIR/genconfig.sh" rotate
else
    sh "$APP_DIR/genconfig.sh"
fi

. "$STATE"

PUB_HOST="${PUBLIC_HOST:-${RAILWAY_TCP_PROXY_DOMAIN:-}}"
PUB_PORT="${PUBLIC_PORT:-${RAILWAY_TCP_PROXY_PORT:-$VPN_PORT}}"
LINK="vless://${UUID}@${PUB_HOST:-SERVER_HOST}:${PUB_PORT}?encryption=none&flow=xtls-rprx-vision&security=reality&sni=${SNI}&fp=chrome&pbk=${PUBLIC_KEY}&sid=${SHORT_ID}&type=tcp#${NODE_NAME}"

echo "============================================================"
echo "Panel: http://0.0.0.0:${PANEL_PORT}  (public: see Railway domain)"
echo "VPN listening on 0.0.0.0:${VPN_PORT}  |  disguise site: ${SNI}"
if [ -n "$PUB_HOST" ]; then
    echo "Client link:"
    echo "$LINK"
    echo
    qrencode -t ANSIUTF8 "$LINK" 2>/dev/null || true
else
    echo "No TCP proxy yet. Enable Settings > Networking > TCP Proxy for"
    echo "port ${VPN_PORT}; the panel will then show the full link and QR."
fi
echo "============================================================"

# Panel: restarts itself if it ever exits.
( while :; do
    node "$APP_DIR/panel/server.js" || echo "panel exited, restarting in 3s"
    sleep 3
  done ) &

# Xray supervisor: lets the panel rotate keys by simply killing xray.
trap 'kill 0 2>/dev/null; exit 0' INT TERM
while :; do
    xray run -c "$CONFIG" &
    XPID=$!
    wait "$XPID" || true
    sleep 2
done
