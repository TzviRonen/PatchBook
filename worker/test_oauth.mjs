/* End-to-end OAuth round trip: /auth/login → consent → /auth/callback → vote.
 *
 *   node worker/test_oauth.mjs
 *
 * handleCallback cannot otherwise be exercised without a human at a GitHub
 * consent screen, which is exactly why it went untested for so long. Here a
 * local double stands in for github.com and api.github.com via the
 * GITHUB_AUTH_BASE / GITHUB_API_BASE deployment overrides. Everything else --
 * state signing, the code exchange, the identity lookup, session minting, and
 * the vote that follows -- is the real code path.
 */
import worker from "./src/index.js";
import http from "node:http";

const SITE = "http://127.0.0.1:3004";
const WORKER_ORIGIN = "http://127.0.0.1:3003";
const POST = "_posts/2026-08-29-cve-2026-33827-tcpip-remote-code-execution.md";

let failures = 0;
const check = (n, c, e = "") => {
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + e));
  if (!c) failures++;
};

/* ── GitHub double ──────────────────────────────────────────────────────── */

const REGISTERED_CALLBACK = `${WORKER_ORIGIN}/auth/callback`;
const GOOD_CODE = "good-code";
let lastExchange = null;

const gh = http.createServer((req, res) => {
  const url = new URL(req.url, "http://gh.test");
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  // Stand-in for the consent screen: GitHub validates redirect_uri here.
  if (url.pathname === "/login/oauth/authorize") {
    if (url.searchParams.get("redirect_uri") !== REGISTERED_CALLBACK) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end("The redirect_uri MUST match the registered callback URL.");
    }
    const back = new URL(REGISTERED_CALLBACK);
    back.searchParams.set("code", GOOD_CODE);
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  if (url.pathname === "/login/oauth/access_token") {
    let body = "";
    req.on("data", (d) => (body += d));
    return req.on("end", () => {
      lastExchange = JSON.parse(body);
      if (lastExchange.client_secret !== "dev-secret")
        return send(200, { error: "incorrect_client_credentials" });
      if (lastExchange.code === "mismatch-code")
        return send(200, {
          error: "redirect_uri_mismatch",
          error_description: "The redirect_uri MUST match the registered callback URL for this application.",
        });
      if (lastExchange.code !== GOOD_CODE)
        return send(200, { error: "bad_verification_code" });
      send(200, { access_token: "gho_test", token_type: "bearer", scope: "" });
    });
  }

  if (url.pathname === "/user") {
    if (req.headers.authorization !== "Bearer gho_test")
      return send(401, { message: "Bad credentials" });
    return send(200, { id: 4242, login: "octocat" });
  }

  send(404, { message: "not found" });
});
await new Promise((r) => gh.listen(0, "127.0.0.1", r));
const GH = `http://127.0.0.1:${gh.address().port}`;

/* ── worker env ─────────────────────────────────────────────────────────── */

const rows = [];
const DB = {
  prepare(sql) {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async all() { return { results: rows.filter((r) => r.post_id === args[0]) }; },
      async run() {
        if (/^DELETE/.test(sql.trim())) {
          const i = rows.findIndex((r) => r.post_id === args[0] && r.user_id === args[1]);
          if (i >= 0) rows.splice(i, 1);
          return;
        }
        const [post_id, user_id, login, verdict, note] = args;
        const existing = rows.find((r) => r.post_id === post_id && r.user_id === user_id);
        const at = new Date().toISOString();
        if (existing) Object.assign(existing, { login, verdict, note, updated_at: at });
        else rows.push({ post_id, user_id, login, verdict, note, updated_at: at });
      },
    };
    return api;
  },
};

const env = {
  DB,
  TOKEN_SECRET: "test-token-secret",
  GITHUB_CLIENT_ID: "dev-client-id",
  GITHUB_CLIENT_SECRET: "dev-secret",
  ALLOWED_ORIGINS: SITE,
  GITHUB_AUTH_BASE: GH,
  GITHUB_API_BASE: GH,
};

const call = (path, opts = {}) =>
  worker.fetch(new Request(WORKER_ORIGIN + path, opts), env);

/* ── the round trip ─────────────────────────────────────────────────────── */

const postUrl = `${SITE}/posts/2026-08-29-cve-2026-33827-tcpip-remote-code-execution`;

// 1. the site sends the reader to /auth/login
let r = await call("/auth/login?return=" + encodeURIComponent(postUrl));
check("login redirects", r.status === 302, r.status);
const authorizeUrl = new URL(r.headers.get("Location"));
check("redirect_uri is the worker's own callback",
  authorizeUrl.searchParams.get("redirect_uri") === REGISTERED_CALLBACK,
  authorizeUrl.searchParams.get("redirect_uri"));

// 2. GitHub's consent screen (the double validates redirect_uri like GitHub does)
let ghRes = await fetch(authorizeUrl, { redirect: "manual" });
check("GitHub accepts the authorize request", ghRes.status === 302,
  ghRes.status + " " + (await ghRes.clone().text()).slice(0, 60));

// 3. GitHub redirects back to the callback with code + state
const cbUrl = new URL(ghRes.headers.get("Location"));
check("callback carries code and state",
  !!cbUrl.searchParams.get("code") && !!cbUrl.searchParams.get("state"));

r = await call(cbUrl.pathname + cbUrl.search);
check("callback redirects back to the post", r.status === 302, r.status);

const finalUrl = new URL(r.headers.get("Location"));
check("returns to the exact page the reader came from",
  finalUrl.origin + finalUrl.pathname === postUrl, finalUrl.toString());
check("session arrives in the fragment, not the query",
  finalUrl.hash.startsWith("#pb_token=") && !finalUrl.search.includes("pb_token"),
  finalUrl.hash.slice(0, 20));

// 4. the exchange used the right credentials and echoed redirect_uri
check("exchange sent the client secret", lastExchange.client_secret === "dev-secret");
check("exchange echoed redirect_uri", lastExchange.redirect_uri === REGISTERED_CALLBACK,
  lastExchange.redirect_uri);

// 5. the minted session actually works for voting
const token = decodeURIComponent(finalUrl.hash.replace("#pb_token=", ""));
r = await call("/api/me", { headers: { Authorization: "Bearer " + token } });
check("session identifies the GitHub user", (await r.json()).login === "octocat");

r = await call("/api/vote", {
  method: "POST",
  headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify({ post: POST, verdict: "valid" }),
});
let body = await r.json();
check("vote recorded under the GitHub identity",
  r.status === 200 && body.counts.valid === 1 && body.voters[0].login === "octocat",
  JSON.stringify(body));
check("row is keyed by GitHub's numeric id", rows[0].user_id === 4242, rows[0].user_id);

/* ── negative paths ─────────────────────────────────────────────────────── */

r = await call("/auth/callback?code=" + GOOD_CODE + "&state=forged.signature");
check("forged state rejected", r.status === 400, r.status);

const goodState = authorizeUrl.searchParams.get("state");
r = await call("/auth/callback?state=" + encodeURIComponent(goodState));
check("missing code rejected", r.status === 400, r.status);

r = await call("/auth/callback?code=wrong-code&state=" + encodeURIComponent(goodState));
check("bad code fails the exchange", r.status === 502, r.status);

// A state signed with someone else's key must not be accepted.
const alienState = await (async () => {
  const e = new TextEncoder();
  const b64 = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const payload = b64(e.encode(JSON.stringify({ r: "https://evil.example/x", exp: Math.floor(Date.now() / 1000) + 600 })));
  const k = await crypto.subtle.importKey("raw", e.encode("attacker-key"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return payload + "." + b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, e.encode(payload))));
})();
r = await call("/auth/callback?code=" + GOOD_CODE + "&state=" + encodeURIComponent(alienState));
check("state signed with a foreign key rejected", r.status === 400, r.status);

// ── the failure the reader actually hits: a mis-registered callback URL ──
r = await call("/auth/callback?code=mismatch-code&state=" + encodeURIComponent(goodState));
let text = await r.text();
check("mismatch names the GitHub error code", /redirect_uri_mismatch/.test(text), text.slice(0, 90));
check("mismatch shows the redirect_uri we sent",
  text.includes(`redirect_uri=${WORKER_ORIGIN}/auth/callback`), text.slice(0, 200));
check("mismatch warns localhost != 127.0.0.1", /localhost and 127\.0\.0\.1 are different/.test(text));

// GitHub redirects here with ?error= when the reader cancels consent
r = await call("/auth/callback?error=access_denied&error_description=The+user+has+denied+access");
text = await r.text();
check("cancelled consent is reported", /access_denied/.test(text), text.slice(0, 80));

gh.close();
console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
