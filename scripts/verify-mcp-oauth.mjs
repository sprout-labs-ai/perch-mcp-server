#!/usr/bin/env node
/**
 * Dev verification helper: run the assistant OAuth flow (authorization_code +
 * PKCE) against an Auth0 tenant for the Perch MCP audience, open the browser for
 * the user to log in + consent, capture the access token, and print it (decoded
 * header/payload) so you can confirm:
 *   - the 4 read scopes survive (validates DCR strict/permissive behavior)
 *   - the `<audience>/integration` claim is stamped (validates the attribution Action)
 *
 * No dependencies. Stands in for ChatGPT/Claude's OAuth client.
 *
 * Usage:
 *   node scripts/verify-mcp-oauth.mjs \
 *     --domain auth-dev.theperch.app \
 *     --client-id <DCR_CLIENT_ID> \
 *     --audience https://mcp-dev.theperch.app \
 *     [--port 8484]
 *
 * The DCR client must include this redirect_uri:  http://localhost:<port>/callback
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const DOMAIN = arg('domain', 'auth-dev.theperch.app');
const CLIENT_ID = arg('client-id');
const AUDIENCE = arg('audience', 'https://mcp-dev.theperch.app');
const PORT = Number(arg('port', '8484'));
const SCOPES = arg('scopes', 'openid read:accounts read:series read:schedule read:forecast');
const REDIRECT = `http://localhost:${PORT}/callback`;

if (!CLIENT_ID) {
  console.error('Missing --client-id (the DCR-registered client id). See --help in the file header.');
  process.exit(1);
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

const authUrl =
  `https://${DOMAIN}/authorize?` +
  new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    scope: SCOPES,
    audience: AUDIENCE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

function decodeJwt(token) {
  const [h, p] = token.split('.');
  const dec = (s) => JSON.parse(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  return { header: dec(h), payload: dec(p) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Perch — connected</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#000; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#1a1a1a; }
  .card { background:#fff; border-radius:20px; padding:40px 48px; max-width:420px; text-align:center;
          box-shadow:0 12px 40px rgba(0,0,0,.35); }
  .check { width:64px; height:64px; border-radius:16px; margin:0 auto 20px;
           background:#FF8A6A; display:flex; align-items:center; justify-content:center; }
  .check svg { width:34px; height:34px; stroke:#fff; stroke-width:3; fill:none; }
  h1 { font-size:22px; margin:0 0 8px; }
  p { color:#666; font-size:15px; line-height:1.5; margin:0; }
</style></head>
<body><div class="card">
  <div class="check"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
  <h1>You're all set</h1>
  <p>Perch is connected. You can close this tab and return to the terminal.</p>
</div></body></html>`);
  if (err) { console.error('Authorize error:', err, url.searchParams.get('error_description')); server.close(); process.exit(1); }

  const tokenRes = await fetch(`https://${DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code_verifier: verifier,
      code,
      redirect_uri: REDIRECT,
    }),
  });
  const body = await tokenRes.json();
  if (!tokenRes.ok) { console.error('Token error:', JSON.stringify(body, null, 2)); server.close(); process.exit(1); }

  const at = body.access_token;
  const { header, payload } = decodeJwt(at);
  console.log('\n=== ACCESS TOKEN (paste this back to Claude) ===\n' + at);
  console.log('\n=== decoded header ===\n' + JSON.stringify(header, null, 2));
  console.log('\n=== decoded payload (key claims) ===');
  console.log('aud       =', JSON.stringify(payload.aud));
  console.log('azp       =', payload.azp);
  console.log('scope     =', payload.scope, '   <-- expect the 4 read scopes; if only "openid", permissive DCR dropped them');
  console.log(`integration claim (${AUDIENCE}/integration) =`, payload[`${AUDIENCE}/integration`], '   <-- expect "chatgpt"; null means the Action did not fire/match');
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT}`);
  console.log('Opening browser to log in + consent...\n' + authUrl);
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${opener} "${authUrl}"`);
});
