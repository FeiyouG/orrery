/**
 * Connect Monid — OAuth 2.0 Authorization Code + PKCE for a pure static app.
 *
 * Public client: the only credential shipped is the public client_id. No
 * client secret exists in this project — PKCE (one-time code_verifier,
 * S256 challenge) replaces it, per RFC 7636. Tokens live in the user's
 * browser only.
 */

const STAGES = {
  prod: { issuer: "https://clerk.app.monid.ai", clientId: "mFx1imRrM8bKuVPU" },
  dev: { issuer: "https://clerk.app.dev.monid.ai", clientId: "voW4BGmqEZ8ir6Gr" },
};
let stage = STAGES.prod;
export function configureOAuth({ stage: s } = {}) { if (STAGES[s]) stage = STAGES[s]; }

const TOK = "monidTokens";
const PKCE = "monidPkce";

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha256 = (s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
const redirectUri = () => location.origin + location.pathname;

/** Kick off the login redirect. `carry` survives the round-trip. */
export async function beginConnect(carry = {}) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(PKCE, JSON.stringify({ verifier, state, carry }));
  const u = new URL(stage.issuer + "/oauth/authorize");
  u.search = new URLSearchParams({
    client_id: stage.clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid profile email offline_access user:org:read",
    state,
    code_challenge: b64url(await sha256(verifier)),
    code_challenge_method: "S256",
  });
  location.href = u;
}

/**
 * Call on page load. If we just returned from the authorize redirect,
 * exchanges the code for tokens. Returns { carry } on success, null if this
 * wasn't an OAuth callback. Throws on a failed exchange.
 */
export async function completeConnect() {
  const params = new URLSearchParams(location.search);
  // the authorize endpoint can bounce back with an error instead of a code
  if (params.get("error")) {
    sessionStorage.removeItem(PKCE);
    history.replaceState(null, "", location.pathname);
    throw new Error(params.get("error_description") || params.get("error"));
  }
  const code = params.get("code");
  if (!code) return null;
  const state = params.get("state");
  const saved = JSON.parse(sessionStorage.getItem(PKCE) || "null");
  sessionStorage.removeItem(PKCE);
  history.replaceState(null, "", location.pathname); // strip ?code from the URL/history
  if (!saved || saved.state !== state) throw new Error("login state mismatch — please connect again");
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: saved.verifier,
  });
  saveTokens(tokens);
  return { carry: saved.carry ?? {} };
}

async function tokenRequest(params) {
  const res = await fetch(stage.issuer + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: stage.clientId, ...params }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error_description || body?.error || `token exchange failed (HTTP ${res.status})`);
  return body;
}

function saveTokens(t) {
  const prev = JSON.parse(localStorage.getItem(TOK) || "{}");
  localStorage.setItem(TOK, JSON.stringify({
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? prev.refresh_token ?? null,
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
  }));
}

export const connected = () => !!localStorage.getItem(TOK);
export const disconnect = () => { localStorage.removeItem(TOK); localStorage.removeItem("monidWorkspace"); };

/** Valid access token, auto-refreshed. Null when not connected / refresh failed. */
export async function accessToken() {
  const t = JSON.parse(localStorage.getItem(TOK) || "null");
  if (!t) return null;
  if (Date.now() < t.expires_at - 60_000) return t.access_token;
  if (!t.refresh_token) { disconnect(); return null; }
  try {
    saveTokens(await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token }));
    return JSON.parse(localStorage.getItem(TOK)).access_token;
  } catch {
    disconnect();
    return null;
  }
}

export async function userInfo() {
  const tok = await accessToken();
  if (!tok) return null;
  const res = await fetch(stage.issuer + "/oauth/userinfo", { headers: { Authorization: `Bearer ${tok}` } });
  return res.ok ? res.json() : null;
}
