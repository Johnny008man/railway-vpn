'use strict';

// Railway VPN panel: shows the VLESS+REALITY link, a QR code and client
// configs behind a password, and can rotate keys.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'state.env');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SECRET_FILE = path.join(DATA_DIR, 'panel.secret');
const PASSWORD_FILE = path.join(DATA_DIR, 'panel.password');
const PORT = Number(process.env.PORT || 8080);
const VPN_PORT = Number(process.env.VPN_PORT || 8443);
const SNI = process.env.SNI || 'www.microsoft.com';
const NODE_NAME = process.env.NODE_NAME || 'railway';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const STARTED = Date.now();

fs.mkdirSync(DATA_DIR, { recursive: true });

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function loadSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {}
  const s = randomHex(32);
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}

function loadPassword() {
  const fromEnv = (process.env.PANEL_PASSWORD || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const p = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
    if (p) return p;
  } catch {}
  const p = crypto.randomBytes(6).toString('base64url');
  fs.writeFileSync(PASSWORD_FILE, p, { mode: 0o600 });
  console.log(`[panel] PANEL_PASSWORD not set. Generated panel password: ${p}`);
  return p;
}

const SECRET = loadSecret();
const PASSWORD = loadPassword();

function readState() {
  const out = {};
  for (const line of fs.readFileSync(STATE_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function publicAddress() {
  const host = (process.env.PUBLIC_HOST || process.env.RAILWAY_TCP_PROXY_DOMAIN || '').trim();
  const port = (process.env.PUBLIC_PORT || process.env.RAILWAY_TCP_PROXY_PORT || String(VPN_PORT)).trim();
  return host ? { host, port } : null;
}

function buildLink(state) {
  const addr = publicAddress();
  const host = addr ? addr.host : 'SERVER_HOST';
  const port = addr ? addr.port : 'SERVER_PORT';
  const q = new URLSearchParams({
    encryption: 'none',
    flow: 'xtls-rprx-vision',
    security: 'reality',
    sni: SNI,
    fp: 'chrome',
    pbk: state.PUBLIC_KEY,
    sid: state.SHORT_ID,
    type: 'tcp',
  });
  return `vless://${state.UUID}@${host}:${port}?${q.toString()}#${encodeURIComponent(NODE_NAME)}`;
}

function singboxConfig(state) {
  const addr = publicAddress();
  return {
    log: { level: 'info' },
    inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: 2080 }],
    outbounds: [
      {
        type: 'vless',
        tag: 'railway-vpn',
        server: addr ? addr.host : 'SERVER_HOST',
        server_port: Number(addr ? addr.port : 0),
        uuid: state.UUID,
        flow: 'xtls-rprx-vision',
        tls: {
          enabled: true,
          server_name: SNI,
          utls: { enabled: true, fingerprint: 'chrome' },
          reality: { enabled: true, public_key: state.PUBLIC_KEY, short_id: state.SHORT_ID },
        },
      },
    ],
  };
}

function xrayAlive() {
  try {
    execFileSync('pgrep', ['-x', 'xray'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// --- sessions -------------------------------------------------------------

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

function newSessionCookie() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `panel=${exp}.${sign(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function isAuthed(req) {
  const raw = parseCookies(req.headers.cookie).panel;
  if (!raw) return false;
  const i = raw.lastIndexOf('.');
  if (i < 1) return false;
  const exp = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const expect = sign(exp);
  if (sig.length !== expect.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
  return Number(exp) > Date.now();
}

const failures = new Map();

function tooManyFailures(ip) {
  const now = Date.now();
  const rec = failures.get(ip);
  if (!rec) return false;
  if (now - rec.first > 10 * 60 * 1000) {
    failures.delete(ip);
    return false;
  }
  return rec.count >= 8;
}

function recordFailure(ip) {
  const now = Date.now();
  const rec = failures.get(ip);
  if (!rec || now - rec.first > 10 * 60 * 1000) failures.set(ip, { count: 1, first: now });
  else rec.count += 1;
}

function passwordOk(given) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// --- html -----------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--bg:#0b0f14;--panel:#111823;--line:#1f2b3a;--text:#e6edf5;--muted:#8aa0b8;--accent:#4ade80;--accent2:#38bdf8;--danger:#f87171}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent2)}
.layout{display:grid;grid-template-columns:230px 1fr;min-height:100vh}
.side{background:var(--panel);border-right:1px solid var(--line);padding:22px 16px;position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:.2px;margin-bottom:26px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px rgba(74,222,128,.15)}
.nav a{display:block;padding:10px 12px;border-radius:9px;color:var(--muted);text-decoration:none;font-weight:550}
.nav a:hover{background:#17202d;color:var(--text)}
.meta{margin-top:auto}
.side{display:flex;flex-direction:column}
.side .meta{color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px;margin-top:24px}
main{padding:26px 22px 60px;max-width:900px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 22px;font-size:13.5px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
.card h2{font-size:14px;margin:0 0 12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:600}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
pre{background:#0a0f16;border:1px solid var(--line);border-radius:10px;padding:12px;overflow:auto;margin:0 0 12px}
code.link{word-break:break-all;white-space:pre-wrap}
button,.btn{background:#1b2836;color:var(--text);border:1px solid #2a3a4d;border-radius:9px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block}
button:hover,.btn:hover{background:#22323f}
button.primary{background:var(--accent);color:#062012;border:0}
button.danger{background:transparent;border-color:#5a2a2a;color:var(--danger)}
input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--line);background:#0a0f16;color:var(--text);font:inherit}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.kv{display:grid;grid-template-columns:120px 1fr;gap:8px 12px;font-size:13.5px}
.kv span:first-child{color:var(--muted)}
.badge{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted)}
.badge b{color:var(--accent)}
.qr{background:#fff;padding:12px;border-radius:12px;display:inline-block;line-height:0}
.qr svg{width:220px;height:220px;display:block}
.alert{background:#122417;border:1px solid #1f4a2c;color:#b9f6ca;border-radius:10px;padding:11px 13px;margin-bottom:16px;font-size:13.5px}
.warn{background:#241a12;border-color:#5a3f22;color:#ffd9a8}
.hint{color:var(--muted);font-size:13px;margin:8px 0 0}
.login{max-width:380px;margin:12vh auto;padding:0 18px}
footer{color:var(--muted);font-size:12px;margin-top:26px}
@media(max-width:760px){.layout{grid-template-columns:1fr}.side{position:static;height:auto;flex-direction:row;align-items:center;gap:14px;overflow:auto;padding:14px}.side .brand{margin:0}.nav{display:flex;gap:4px}.nav a{white-space:nowrap;padding:8px 10px}.side .meta{display:none}main{padding:20px 16px 50px}.grid2{grid-template-columns:1fr}}
`;

function loginPage(error) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VPN panel</title><style>${CSS}</style></head><body>
<div class="login">
  <div class="brand"><span class="dot"></span> Railway VPN</div>
  ${error ? `<div class="alert warn">${esc(error)}</div>` : ''}
  <div class="card">
    <h2>Panel password</h2>
    <form method="post" action="/login">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
      <p class="hint">Set by the PANEL_PASSWORD variable, or printed in the deploy logs.</p>
      <div class="row" style="margin-top:14px"><button class="primary" type="submit">Unlock</button></div>
    </form>
  </div>
</div></body></html>`;
}

function dashboardPage(state, opts) {
  const link = buildLink(state);
  const addr = publicAddress();
  const alive = xrayAlive();
  const upMin = Math.floor((Date.now() - STARTED) / 60000);
  const singbox = JSON.stringify(singboxConfig(state), null, 2);
  const notice = opts.notice ? `<div class="alert">${esc(opts.notice)}</div>` : '';

  const setupCard = addr
    ? ''
    : `<div class="card"><h2>One more step</h2>
        <p style="margin:0 0 10px">No public VPN address yet. In Railway open
        <b>Settings → Networking → TCP Proxy</b>, enter port <b>${VPN_PORT}</b>, generate it, and the
        service restarts with the real link here.</p>
        <p class="hint">Then reload this page.</p></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VPN panel</title><style>${CSS}</style></head><body>
<div class="layout">
  <aside class="side">
    <div class="brand"><span class="dot"></span> Railway VPN</div>
    <nav class="nav">
      <a href="#overview">Overview</a>
      <a href="#config">Config</a>
      <a href="#clients">Clients</a>
      <a href="#keys">Keys</a>
    </nav>
    <div class="meta">
      <div class="badge" style="margin-bottom:6px">${alive ? '<b>●</b> VPN running' : '<b style="color:#f87171">●</b> VPN starting'}</div>
      <div>uptime ${upMin}m</div>
      <div>port ${VPN_PORT}</div>
      <form method="post" action="/logout" style="margin-top:10px"><button class="btn" type="submit">Sign out</button></form>
    </div>
  </aside>
  <main>
    <h1>Your VPN</h1>
    <p class="sub">VLESS + REALITY over TCP. Probes see ${esc(SNI)}; only this config connects.</p>
    ${notice}
    ${setupCard}

    <section class="card" id="overview">
      <h2>Connection</h2>
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div>
          <div class="kv">
            <span>Server</span><span class="mono">${esc(addr ? `${addr.host}:${addr.port}` : 'not exposed yet')}</span>
            <span>Protocol</span><span>VLESS + REALITY (TCP)</span>
            <span>Disguise</span><span class="mono">${esc(SNI)}</span>
            <span>Flow</span><span class="mono">xtls-rprx-vision</span>
          </div>
          <p class="hint">Scan the code with your phone, or open <b>Config</b> to copy the link.</p>
        </div>
        <div class="qr" id="qrbox">loading…</div>
      </div>
    </section>

    <section class="card" id="config">
      <h2>Import link</h2>
      <pre><code class="link mono" id="link">${esc(link)}</code></pre>
      <div class="row">
        <button onclick="copyText(document.getElementById('link').innerText,this)">Copy link</button>
        <a class="btn" href="/config.txt" download="railway-vpn.txt">Download link</a>
        <a class="btn" href="/singbox.json" download="singbox.json">sing-box config</a>
      </div>
      <h2 style="margin-top:20px">sing-box JSON</h2>
      <pre><code class="mono">${esc(singbox)}</code></pre>
    </section>

    <section class="card" id="clients">
      <h2>Client apps</h2>
      <div class="kv">
        <span>Android</span><span>v2rayNG, Hiddify, NekoBox</span>
        <span>iPhone</span><span>Streisand, Shadowrocket, Hiddify</span>
        <span>Desktop</span><span>v2rayN, Hiddify, NekoRay, sing-box</span>
        <span>Import</span><span>Scan the QR, or paste the vless:// link</span>
      </div>
    </section>

    <section class="card" id="keys">
      <h2>Keys</h2>
      <div class="kv">
        <span>UUID</span><span class="mono">${esc(state.UUID)}</span>
        <span>Public key</span><span class="mono">${esc(state.PUBLIC_KEY)}</span>
        <span>Short id</span><span class="mono">${esc(state.SHORT_ID)}</span>
      </div>
      <form method="post" action="/rotate" onsubmit="return confirm('Rotate keys? Every device must import the new link.')" style="margin-top:14px">
        <button class="danger" type="submit">Rotate keys</button>
      </form>
    </section>

    <footer>Railway VPN panel · keys are stored on this service only</footer>
  </main>
</div>
<script>
function copyText(t,btn){navigator.clipboard.writeText(t).then(()=>{btn.textContent='Copied';setTimeout(()=>btn.textContent='Copy link',1200)})}
fetch('/qr.svg').then(r=>r.text()).then(s=>{document.getElementById('qrbox').innerHTML=s}).catch(()=>{});
</script>
</body></html>`;
}

// --- http -----------------------------------------------------------------

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function redirect(res, to, headers = {}) {
  res.writeHead(303, { Location: to, 'Cache-Control': 'no-store', ...headers });
  res.end();
}

function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function qrSvg(link) {
  try {
    return execFileSync('qrencode', ['-t', 'SVG', '-l', 'M', '-o', '-', link], { encoding: 'utf8' });
  } catch {
    return '<p style="color:#333">QR unavailable</p>';
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const authed = isAuthed(req);

  if (url.pathname === '/healthz') return send(res, 200, 'ok');

  if (req.method === 'POST' && url.pathname === '/login') {
    const ip = req.socket.remoteAddress || '';
    if (tooManyFailures(ip)) return send(res, 429, loginPage('Too many attempts. Wait a few minutes.'), { 'Retry-After': '300' });
    const body = new URLSearchParams(await readBody(req));
    if (!passwordOk(body.get('password') || '')) {
      recordFailure(ip);
      return send(res, 401, loginPage('Wrong password.'));
    }
    return redirect(res, '/', { 'Set-Cookie': newSessionCookie() });
  }

  if (req.method === 'POST' && url.pathname === '/logout') {
    return redirect(res, '/', { 'Set-Cookie': 'panel=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  }

  if (!authed) {
    if (url.pathname === '/') return send(res, 200, loginPage(''));
    return send(res, 401, 'Unauthorized', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  let state;
  try {
    state = readState();
  } catch {
    return send(res, 500, 'Keys are not ready yet. Check the deploy logs.', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (url.pathname === '/') {
    const notice = url.searchParams.get('rotated') ? 'New keys generated. Import the new link on every device.' : '';
    return send(res, 200, dashboardPage(state, { notice }));
  }

  if (url.pathname === '/qr.svg') {
    return send(res, 200, qrSvg(buildLink(state)), { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
  }

  if (url.pathname === '/config.txt') {
    return send(res, 200, buildLink(state), {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="railway-vpn.txt"',
    });
  }

  if (url.pathname === '/singbox.json') {
    return send(res, 200, JSON.stringify(singboxConfig(state), null, 2), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="singbox.json"',
    });
  }

  if (req.method === 'POST' && url.pathname === '/rotate') {
    try {
      execFileSync('sh', [path.join(process.env.APP_DIR || '/app', 'genconfig.sh'), 'rotate'], { stdio: 'ignore' });
      try {
        execFileSync('pkill', ['-x', 'xray'], { stdio: 'ignore' });
      } catch {}
      await new Promise((r) => setTimeout(r, 1500));
      return redirect(res, '/?rotated=1');
    } catch {
      return send(res, 500, 'Rotation failed. Check the deploy logs.');
    }
  }

  return send(res, 404, 'Not found');
});

function listen(port) {
  if (port === VPN_PORT) return;
  const s = port === PORT ? server : http.createServer(server.listeners('request')[0]);
  s.listen(port, '0.0.0.0', () => console.log(`[panel] listening on 0.0.0.0:${port}`));
}
listen(PORT);
listen(8080);
