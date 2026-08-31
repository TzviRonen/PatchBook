/* PatchBook vote API — Cloudflare Worker + D1.
 *
 * Why this exists: post *content* lives in git and changes only through merged
 * pull requests, but votes need to be instant, capped at one per user, and
 * attributable by name. That's read/write-hot state, so it lives here instead
 * of in post frontmatter. See ARCHITECTURE.md.
 *
 * Endpoints
 *   GET    /api/votes?post=<path>   → { counts, voters, you }        (public)
 *   POST   /api/vote                → cast/change a vote             (auth)
 *   DELETE /api/vote?post=<path>    → retract your vote              (auth)
 *   GET    /api/me                  → { login } for the current token
 *   GET    /auth/login?return=<url> → 302 to GitHub's consent screen
 *   GET    /auth/callback           → 302 back to <url>#pb_token=…
 *
 * Auth is GitHub OAuth. The session token is handed back in the URL *fragment*
 * (never sent to a server) and kept in localStorage, not a cookie: this Worker
 * is a different origin from the Pages site, and Safari/Chrome block
 * third-party cookies outright.
 *
 * Secrets (wrangler secret put): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
 * TOKEN_SECRET. Vars (wrangler.toml): ALLOWED_ORIGINS.
 */

const VERDICTS = ["valid", "ai-slop"];
const POST_RE = /^_posts\/[A-Za-z0-9._-]+\.md$/;
const TOKEN_TTL = 60 * 60 * 24 * 30; // 30 days
const STATE_TTL = 60 * 10; // 10 minutes to complete the OAuth round trip
const NOTE_MAX = 500;

/* ── helpers ──────────────────────────────────────────────────────────── */

const enc = new TextEncoder();

function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

// Compact signed blob: base64url(JSON payload) "." base64url(HMAC-SHA256).
// Used for both the session token and the OAuth `state` parameter.
async function sign(payload, secret) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return body + "." + b64urlEncode(new Uint8Array(sig));
}

async function verify(token, secret) {
  if (typeof token !== "string") return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  let ok;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(token.slice(dot + 1)),
      enc.encode(body)
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const h = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && allowedOrigins(env).includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
  }
  return h;
}

function json(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      // Counts must never be served stale — that's the whole point of the API.
      "Cache-Control": "no-store",
    },
  });
}

// Only allow redirecting back to a page on our own site. Without this check the
// `return` parameter would be an open redirect that leaks the session token.
function safeReturnUrl(raw, env) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return allowedOrigins(env).includes(url.origin) ? url : null;
}

async function currentUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return null;
  const payload = await verify(auth.slice(7), env.TOKEN_SECRET);
  if (!payload || !payload.uid || !payload.login) return null;
  return { id: payload.uid, login: payload.login };
}

/* ── OAuth ────────────────────────────────────────────────────────────── */

async function handleLogin(request, env) {
  const url = new URL(request.url);
  const back = safeReturnUrl(url.searchParams.get("return") || "", env);
  if (!back) return new Response("Bad return URL", { status: 400 });

  const state = await sign(
    { r: back.toString(), exp: Math.floor(Date.now() / 1000) + STATE_TTL },
    env.TOKEN_SECRET
  );

  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  gh.searchParams.set("redirect_uri", url.origin + "/auth/callback");
  // No scopes: we only need the user's public identity, so the consent screen
  // asks for nothing beyond that and we never gain access to their repos.
  gh.searchParams.set("scope", "");
  gh.searchParams.set("state", state);
  return Response.redirect(gh.toString(), 302);
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = await verify(url.searchParams.get("state") || "", env.TOKEN_SECRET);
  if (!code || !state) return new Response("Bad OAuth state", { status: 400 });
  const back = safeReturnUrl(state.r, env);
  if (!back) return new Response("Bad return URL", { status: 400 });

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: url.origin + "/auth/callback",
    }),
  });
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenBody.access_token) return new Response("OAuth exchange failed", { status: 502 });

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: "Bearer " + tokenBody.access_token,
      Accept: "application/vnd.github+json",
      "User-Agent": "patchbook-votes",
    },
  });
  const user = await userRes.json().catch(() => ({}));
  if (!user || !user.id || !user.login) return new Response("GitHub user lookup failed", { status: 502 });

  // GitHub's own access token is deliberately discarded here — we never store
  // it. All we keep is our own signed assertion of who this reader is.
  const session = await sign(
    { uid: user.id, login: user.login, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL },
    env.TOKEN_SECRET
  );

  // Fragment, not query: it never reaches a server or a referrer header.
  back.hash = "pb_token=" + encodeURIComponent(session);
  return Response.redirect(back.toString(), 302);
}

/* ── votes ────────────────────────────────────────────────────────────── */

async function readVotes(request, env, postId, me) {
  const { results } = await env.DB.prepare(
    "SELECT login, verdict, note, updated_at, user_id FROM votes WHERE post_id = ? ORDER BY updated_at ASC"
  )
    .bind(postId)
    .all();

  const rows = results || [];
  const counts = { valid: 0, "ai-slop": 0 };
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;

  const mine = me ? rows.find((r) => r.user_id === me.id) : null;
  return {
    post: postId,
    counts,
    voters: rows.map((r) => ({
      login: r.login,
      verdict: r.verdict,
      note: r.note || null,
      at: r.updated_at,
    })),
    you: mine ? { verdict: mine.verdict, note: mine.note || null } : null,
  };
}

async function handleGetVotes(request, env) {
  const postId = new URL(request.url).searchParams.get("post") || "";
  if (!POST_RE.test(postId)) return json(request, env, { error: "bad post id" }, 400);
  const me = await currentUser(request, env); // optional — shapes `you` only
  return json(request, env, await readVotes(request, env, postId, me));
}

async function handlePostVote(request, env) {
  const me = await currentUser(request, env);
  if (!me) return json(request, env, { error: "login required" }, 401);

  const body = await request.json().catch(() => null);
  if (!body) return json(request, env, { error: "bad body" }, 400);

  const postId = String(body.post || "");
  const verdict = String(body.verdict || "");
  if (!POST_RE.test(postId)) return json(request, env, { error: "bad post id" }, 400);
  if (!VERDICTS.includes(verdict)) return json(request, env, { error: "bad verdict" }, 400);

  const note = body.note ? String(body.note).replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) : null;

  // The (post_id, user_id) primary key is the one-vote-per-user rule: a repeat
  // vote overwrites the reader's previous verdict instead of adding to a tally.
  await env.DB.prepare(
    `INSERT INTO votes (post_id, user_id, login, verdict, note)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (post_id, user_id) DO UPDATE SET
       login      = excluded.login,
       verdict    = excluded.verdict,
       note       = excluded.note,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`
  )
    .bind(postId, me.id, me.login, verdict, note)
    .run();

  return json(request, env, await readVotes(request, env, postId, me));
}

async function handleDeleteVote(request, env) {
  const me = await currentUser(request, env);
  if (!me) return json(request, env, { error: "login required" }, 401);
  const postId = new URL(request.url).searchParams.get("post") || "";
  if (!POST_RE.test(postId)) return json(request, env, { error: "bad post id" }, 400);

  await env.DB.prepare("DELETE FROM votes WHERE post_id = ? AND user_id = ?")
    .bind(postId, me.id)
    .run();

  return json(request, env, await readVotes(request, env, postId, me));
}

/* ── router ───────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (pathname === "/auth/login" && method === "GET") return handleLogin(request, env);
      if (pathname === "/auth/callback" && method === "GET") return handleCallback(request, env);

      if (pathname === "/api/me" && method === "GET") {
        const me = await currentUser(request, env);
        return json(request, env, me ? { login: me.login } : { login: null });
      }

      if (pathname === "/api/votes" && method === "GET") return handleGetVotes(request, env);
      if (pathname === "/api/vote" && method === "POST") return handlePostVote(request, env);
      if (pathname === "/api/vote" && method === "DELETE") return handleDeleteVote(request, env);

      return json(request, env, { error: "not found" }, 404);
    } catch (err) {
      return json(request, env, { error: "internal error", detail: String(err && err.message) }, 500);
    }
  },
};
