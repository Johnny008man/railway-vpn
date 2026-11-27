#!/bin/sh
# Generates /data/config.json (Xray VLESS+REALITY) and the key state.
# Usage: genconfig.sh [rotate]
set -eu

DATA_DIR="${DATA_DIR:-/data}"
STATE="$DATA_DIR/state.env"
CONFIG="$DATA_DIR/config.json"
MODE="${1:-}"

PORT_VPN="${VPN_PORT:-8443}"
SNI="${SNI:-www.microsoft.com}"
DEST="${DEST:-${SNI}:443}"

mkdir -p "$DATA_DIR"

if [ "$MODE" = "rotate" ] || [ ! -f "$STATE" ]; then
    NEW_UUID=$(xray uuid)
    KEY_OUT=$(xray x25519)
    NEW_PRIVATE=$(printf '%s\n' "$KEY_OUT" | grep -i -m1 'private' | sed 's/^[^:]*: *//')
    NEW_PUBLIC=$(printf '%s\n' "$KEY_OUT" | grep -i -m1 'public\|password' | sed 's/^[^:]*: *//')
    NEW_SHORT_ID=$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')
    {
        printf 'UUID=%s\n' "$NEW_UUID"
        printf 'PRIVATE_KEY=%s\n' "$NEW_PRIVATE"
        printf 'PUBLIC_KEY=%s\n' "$NEW_PUBLIC"
        printf 'SHORT_ID=%s\n' "$NEW_SHORT_ID"
    } > "$STATE"
    chmod 600 "$STATE"
fi

. "$STATE"

cat > "$CONFIG" <<EOF
{
  "log": { "loglevel": "${LOG_LEVEL:-warning}" },
  "inbounds": [
    {
      "tag": "vless-reality",
      "listen": "0.0.0.0",
      "port": ${PORT_VPN},
      "protocol": "vless",
      "settings": {
        "clients": [
          { "id": "${UUID}", "flow": "xtls-rprx-vision" }
        ],
        "decryption": "none"
      },
      "streamSettings": {
        "network": "tcp",
        "security": "reality",
        "realitySettings": {
          "show": false,
          "dest": "${DEST}",
          "xver": 0,
          "serverNames": [ "${SNI}" ],
          "privateKey": "${PRIVATE_KEY}",
          "shortIds": [ "${SHORT_ID}" ]
        }
      },
      "sniffing": { "enabled": true, "destOverride": [ "http", "tls", "quic" ] }
    }
  ],
  "outbounds": [
    { "tag": "direct", "protocol": "freedom" },
    { "tag": "block", "protocol": "blackhole" }
  ],
  "routing": {
    "rules": [
      { "type": "field", "ip": [ "geoip:private" ], "outboundTag": "block" }
    ]
  }
}
EOF

xray run -test -c "$CONFIG" >/dev/null
