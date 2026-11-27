FROM alpine:3.22

ARG XRAY_VERSION=v26.11.9
ARG TARGETARCH=amd64

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) XARCH=64 ;; \
      arm64) XARCH=arm64-v8a ;; \
      *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apk add --no-cache ca-certificates curl unzip qrencode nodejs tzdata; \
    curl -fsSL -o /tmp/xray.zip \
      "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-${XARCH}.zip"; \
    unzip -q /tmp/xray.zip -d /usr/local/bin xray geoip.dat geosite.dat; \
    chmod +x /usr/local/bin/xray; \
    rm -f /tmp/xray.zip; \
    mkdir -p /data /app

COPY genconfig.sh entrypoint.sh /app/
COPY panel /app/panel
RUN chmod +x /app/genconfig.sh /app/entrypoint.sh

ENV XRAY_LOCATION_ASSET=/usr/local/bin \
    DATA_DIR=/data \
    VPN_PORT=8443

EXPOSE 8080 8443

ENTRYPOINT ["/app/entrypoint.sh"]
