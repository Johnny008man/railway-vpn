# Railway VPN + panel

A self-hosted VPN you deploy on [Railway](https://railway.com) in a few taps, with a web panel that gives you the config and a QR code.

- **VPN:** VLESS + REALITY over TCP, which is hard to detect. To any scanner the port looks like a real HTTPS site (default `www.microsoft.com`): it returns that site's genuine certificate, has no certificate of its own, and only your key gets a tunnel.
- **Panel:** password-protected page with the import link, QR code, sing-box config and a key-rotation button.

Railway only exposes TCP, so this is VLESS over TCP + REALITY rather than WireGuard.

## Deploy

1. Push this repo to GitHub (in ML AI Code: **Push to GitHub**), then in Railway: **New Project → Deploy from GitHub repo** and pick it. Railway builds the `Dockerfile`.
2. Open the service → **Variables** → add `PANEL_PASSWORD` with a password you choose. (If you skip this, one is generated and printed in the deploy logs.)
3. **Settings → Networking → Generate Domain.** The panel opens at that `https://…up.railway.app` URL, with target port **8080**.
4. Still in **Networking**, add a **TCP Proxy** for port **8443**. Railway gives a host like `roundhouse.proxy.rlwy.net` and a port.
5. Reload the panel: it now shows your full `vless://` link and QR code. Scan it in a client and connect.

Optional: attach a **Volume** at `/data` so keys stay the same across redeploys. Without it you get fresh keys on every deploy (the panel always shows the current ones).

## Using the panel

- Open your Railway domain, enter the panel password, and you get the QR, the import link, a downloadable `railway-vpn.txt` and a `singbox.json`.
- **Rotate keys** gives you a new UUID and REALITY keys; the VPN restarts itself and every device must import the new link.
- Clients: v2rayNG, Hiddify, NekoBox (Android); Streisand, Shadowrocket, Hiddify (iPhone); v2rayN, Hiddify, NekoRay, sing-box (desktop).

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANEL_PASSWORD` | generated | Password for the panel. Set it. |
| `PORT` | `8080` | Panel port. Railway's domain target port; the panel also always listens on 8080. |
| `VPN_PORT` | `8443` | Internal VPN port. The TCP proxy must point at this port. |
| `SNI` | `www.microsoft.com` | Disguise site. Any big site with TLS 1.3 + HTTP/2. |
| `DEST` | `${SNI}:443` | Where probes are forwarded. |
| `NODE_NAME` | `railway` | Name shown in the client. |
| `LOG_LEVEL` | `warning` | Xray log level. |
| `RESET_KEYS` | `0` | Set to `1` once to rotate keys on boot. |
| `PUBLIC_HOST` / `PUBLIC_PORT` | Railway TCP proxy vars | Override the address used in the link. |

## Notes

- Use the TCP proxy port, not `VPN_PORT`, in the client — the panel link already has it.
- Traffic exits from Railway's IP; that is what sites see.
- The panel is public but password-gated, and served over Railway's HTTPS domain. Keep the link private: anyone with it can use your server.
- If the panel says "one more step", the TCP proxy is missing or the service has not restarted since you added it.

## Local run (optional)

```sh
docker build -t railway-vpn .
docker run -p 8080:8080 -p 8443:8443 -e PANEL_PASSWORD=secret -v "$PWD/data:/data" railway-vpn
```
