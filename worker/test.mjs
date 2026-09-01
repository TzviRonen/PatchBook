/* Vote API tests. No wrangler or network needed — the D1 binding is stubbed,
 * so this runs anywhere Node does:  node worker/test.mjs
 */
import worker from "./src/index.js";
import fs from "node:fs";

// Minimal in-memory stand-in for the D1 binding: enough to exercise the two
// statements the Worker issues (select-by-report, upsert, delete).
const rows = [];
const DB = {
  prepare(sql) {
    let args = [];
    const api = {
      bind(...a) { args = a; return api; },
      async all() {
        const [report] = args;
        return { results: rows.filter(r => r.report_id === report) };
      },
      async run() {
        if (/^DELETE/.test(sql.trim())) {
          const [report, uid] = args;
          const i = rows.findIndex(r => r.report_id === report && r.user_id === uid);
          if (i >= 0) rows.splice(i, 1);
          return;
        }
        const [report_id, user_id, login, verdict, note] = args;
        const at = new Date().toISOString().replace(/\.\d+Z$/, "Z");
        const existing = rows.find(r => r.report_id === report_id && r.user_id === user_id);
        if (existing) Object.assign(existing, { login, verdict, note, updated_at: at });
        else rows.push({ report_id, user_id, login, verdict, note, updated_at: at });
      },
    };
    return api;
  },
};

const ORIGIN = "https://tzvironen.github.io";
const env = {
  DB,
  TOKEN_SECRET: "test-secret-value",
  GITHUB_CLIENT_ID: "cid",
  GITHUB_CLIENT_SECRET: "csecret",
  ALLOWED_ORIGINS: ORIGIN + ",http://127.0.0.1:4000",
};
const REPORT = "_reports/2026-08-29-cve-2026-33827-tcpip-remote-code-execution.md";

const call = (path, opts = {}) =>
  worker.fetch(new Request("https://api.example.workers.dev" + path, {
    ...opts, headers: { Origin: ORIGIN, ...(opts.headers || {}) },
  }), env);

// Mint a session token the same way /auth/callback does.
const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...b)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
async function mint(uid, login, exp = Math.floor(Date.now()/1000)+3600) {
  const body = b64(enc.encode(JSON.stringify({ uid, login, exp })));
  const key = await crypto.subtle.importKey("raw", enc.encode(env.TOKEN_SECRET), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return body + "." + b64(new Uint8Array(sig));
}
const auth = t => ({ Authorization: "Bearer " + t, "Content-Type": "application/json" });

let failures = 0;
const check = (name, cond, extra="") => {
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  " + extra));
  if (!cond) failures++;
};

const alice = await mint(1, "alice");
const bob = await mint(2, "bob");

// 1. empty state, anonymous read
let r = await call(`/api/votes?report=${encodeURIComponent(REPORT)}`);
let j = await r.json();
check("anonymous read works", r.status === 200 && j.counts.valid === 0 && j.you === null, JSON.stringify(j));
check("CORS echoes allowed origin", r.headers.get("Access-Control-Allow-Origin") === ORIGIN);
check("counts are never cached", r.headers.get("Cache-Control") === "no-store");

// 2. voting requires login
r = await call("/api/vote", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({report:REPORT, verdict:"valid"}) });
check("anonymous vote rejected", r.status === 401);

// 3. alice votes valid
r = await call("/api/vote", { method:"POST", headers: auth(alice), body: JSON.stringify({report:REPORT, verdict:"valid", note:"  checked   the  offsets \n"}) });
j = await r.json();
check("vote recorded", j.counts.valid === 1 && j.you.verdict === "valid", JSON.stringify(j));
check("note is whitespace-collapsed", j.voters[0].note === "checked the offsets", JSON.stringify(j.voters[0]));

// 4. alice votes again -> replaces, never double-counts
r = await call("/api/vote", { method:"POST", headers: auth(alice), body: JSON.stringify({report:REPORT, verdict:"ai-slop"}) });
j = await r.json();
check("re-vote replaces, no double count", j.counts.valid === 0 && j.counts["ai-slop"] === 1, JSON.stringify(j.counts));

// 5. bob votes -> voter list has both names
await call("/api/vote", { method:"POST", headers: auth(bob), body: JSON.stringify({report:REPORT, verdict:"valid"}) });
r = await call(`/api/votes?report=${encodeURIComponent(REPORT)}`, { headers: { Authorization: "Bearer " + alice } });
j = await r.json();
check("voter names returned live", j.voters.map(v=>v.login).sort().join(",") === "alice,bob", JSON.stringify(j.voters));
check("`you` reflects the caller", j.you.verdict === "ai-slop");

// 6. retract
r = await call(`/api/vote?report=${encodeURIComponent(REPORT)}`, { method:"DELETE", headers: auth(alice) });
j = await r.json();
check("retract removes only your vote", j.counts["ai-slop"] === 0 && j.counts.valid === 1 && j.you === null, JSON.stringify(j));

// 7. input validation
r = await call("/api/vote", { method:"POST", headers: auth(alice), body: JSON.stringify({report:"../../etc/passwd", verdict:"valid"}) });
check("path traversal rejected", r.status === 400);
r = await call("/api/vote", { method:"POST", headers: auth(alice), body: JSON.stringify({report:REPORT, verdict:"spam"}) });
check("bad verdict rejected", r.status === 400);
r = await call("/api/vote", { method:"POST", headers: auth(alice), body: "not json" });
check("malformed body rejected", r.status === 400);

// 8. token forgery / expiry
r = await call("/api/vote", { method:"POST", headers: auth((await mint(9,"mallory")).replace(/.$/, "A")), body: JSON.stringify({report:REPORT, verdict:"valid"}) });
check("tampered signature rejected", r.status === 401);
r = await call("/api/vote", { method:"POST", headers: auth(await mint(9,"mallory", Math.floor(Date.now()/1000)-10)), body: JSON.stringify({report:REPORT, verdict:"valid"}) });
check("expired token rejected", r.status === 401);

// 9. open-redirect guard on OAuth
r = await call("/auth/login?return=" + encodeURIComponent("https://evil.example/steal"));
check("foreign return URL rejected", r.status === 400);
r = await call("/auth/login?return=" + encodeURIComponent(ORIGIN + "/PatchBook/reports/x/"));
check("own-origin return URL accepted", r.status === 302 && r.headers.get("Location").startsWith("https://github.com/login/oauth/authorize"), r.status);

// 10. CORS from a foreign origin gets no allow header
r = await worker.fetch(new Request("https://api.example.workers.dev/api/votes?report=" + encodeURIComponent(REPORT), { headers: { Origin: "https://evil.example" } }), env);
check("foreign origin gets no CORS grant", r.headers.get("Access-Control-Allow-Origin") === null);

// 11. the deployed origin allowlist itself — this is the setting that keeps
// /auth/login from being an open redirect, so pin it against drift.
const toml = fs.readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
const src  = fs.readFileSync(new URL("./src/index.js", import.meta.url), "utf8");
const prodVars = toml.split(/^\[env\./m)[0];          // everything before [env.dev...]
const prodOrigins = /ALLOWED_ORIGINS\s*=\s*"([^"]*)"/.exec(prodVars)[1].split(",").map(s=>s.trim());
check("production allowlist has no wildcard", !prodOrigins.includes("*"), prodOrigins.join());
check("production allowlist has no localhost",
      !prodOrigins.some(o=>/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(o)), prodOrigins.join());
check("production allowlist is https-only",
      prodOrigins.every(o=>o.startsWith("https://")), prodOrigins.join());

// The GitHub endpoint overrides exist so test_oauth.mjs can stand a double in
// front of the OAuth flow. If either ever appeared in deployment config, the
// live Worker would authenticate against something other than GitHub.
check("no GitHub endpoint override in wrangler.toml", !/GITHUB_(AUTH|API)_BASE/.test(toml));
check("GitHub bases default to the real thing",
      /GITHUB_AUTH_BASE \|\| "https:\/\/github\.com"/.test(src) &&
      /GITHUB_API_BASE \|\| "https:\/\/api\.github\.com"/.test(src));


// 12. Filenames the Publish form generates must be accepted here. If the slug
// rules ever emit a character outside REPORT_RE, every vote on that report
// 400s — and by then it is a merged file that needs a rename to fix.
for (const name of [
  "_reports/2026-08-29-cve-2026-33827-use-after-free-in-tcpip-sys.md",
  "_reports/2026-05-05-cve-2026-77777-pool-overflow-in-afd-sys-a-nasty-one.md",
  "_reports/2026-01-01-cve-2026-00001-report.md",
]) {
  const res = await call(`/api/votes?report=${encodeURIComponent(name)}`);
  check("vote API accepts a generated filename", res.status === 200, name + " → " + res.status);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
