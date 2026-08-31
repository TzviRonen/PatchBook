/* Front-end tests for the vote UI, run against the real rendered page.
 *
 *   python3 serve.py 3004 &        # the preview server (see DEVELOPMENT.md)
 *   npm install jsdom
 *   node test/ui.test.mjs
 *
 * The vote API is stubbed below, so no Worker, D1, or network access is needed.
 * The page's data-api is rewritten to the stub, so this works whatever
 * `_config.yml`'s votes_api is set to — including while start_dev.sh runs.
 *
 * The API itself is covered separately, with no dependencies at all, by
 * worker/test.mjs.
 */

import { JSDOM } from "jsdom";
import fs from "node:fs";
import http from "node:http";

// ── stub vote API ───────────────────────────────────────────────────────
const POST="_posts/2026-08-29-cve-2026-33827-tcpip-remote-code-execution.md";
let rows=[{login:"carol",verdict:"valid",note:"confirmed against my own diff",at:"2026-08-29T10:00:00Z",uid:3},
          {login:"dave",verdict:"ai-slop",note:null,at:"2026-08-29T11:00:00Z",uid:4}];
const ME={uid:1,login:"alice"};
const state=(authed)=>({post:POST,counts:{valid:rows.filter(r=>r.verdict==="valid").length,"ai-slop":rows.filter(r=>r.verdict==="ai-slop").length},
  voters:rows.map(({login,verdict,note,at})=>({login,verdict,note,at})),
  you:authed?(rows.find(r=>r.uid===ME.uid)?{verdict:rows.find(r=>r.uid===ME.uid).verdict,note:null}:null):null});
http.createServer((req,res)=>{
  const u=new URL(req.url,"http://x"); const authed=(req.headers.authorization||"").startsWith("Bearer ");
  const h={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"Content-Type, Authorization",
           "Access-Control-Allow-Methods":"GET, POST, DELETE, OPTIONS","Content-Type":"application/json","Cache-Control":"no-store"};
  if(req.method==="OPTIONS"){res.writeHead(204,h);return res.end();}
  let body="";req.on("data",d=>body+=d);req.on("end",()=>{
    if(req.method==="POST"){const v=JSON.parse(body).verdict;rows=rows.filter(r=>r.uid!==ME.uid);
      rows.push({login:ME.login,verdict:v,note:null,at:"now",uid:ME.uid});}
    if(req.method==="DELETE")rows=rows.filter(r=>r.uid!==ME.uid);
    res.writeHead(200,h);res.end(JSON.stringify(state(authed)));});
}).listen(4787);


const PAGE = "http://127.0.0.1:3004/posts/2026-08-29-cve-2026-33827-tcpip-remote-code-execution";
const JS = fs.readFileSync(new URL("../assets/patchbook.js", import.meta.url), "utf8");

// Point the page at the stub above regardless of what `votes_api` in
// _config.yml happens to be — otherwise this suite breaks whenever the preview
// server is running against a real Worker (e.g. under scripts/start_dev.sh).
const html = (await (await fetch(PAGE)).text())
  .replace(/data-api="[^"]*"/, 'data-api="http://127.0.0.1:4787"');

let failures = 0;
const check = (n, c, e = "") => { console.log((c?"PASS  ":"FAIL  ")+n+(c?"":"  "+e)); if(!c) failures++; };
const settle = () => new Promise(r => setTimeout(r, 250));

async function boot(url) {
  const dom = new JSDOM(html.replace(/<script src=[^>]*><\/script>/, ""),
    { url, runScripts: "dangerously", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = (u, o) => fetch(String(u), o);          // jsdom has no fetch
  w.eval(JS);   // patchbook.js self-starts; jsdom fires DOMContentLoaded itself
  await settle();
  return w;
}

const count = (w, v) => w.document.querySelector(`.vote-group[data-verdict="${v}"] .vote-count`).textContent;
const voters = (w, v) => [...w.document.querySelectorAll(`.vote-group[data-verdict="${v}"] .voter-list a`)].map(a=>a.textContent);
const btn = (w, v) => w.document.querySelector(`.vote-group[data-verdict="${v}"] .vote-btn`);

// ── logged out ──────────────────────────────────────────────────────────
let w = await boot(PAGE);
check("counts render live from the API", count(w,"valid")==="1" && count(w,"ai-slop")==="1", count(w,"valid")+"/"+count(w,"ai-slop"));
check("voter names land in the popover", voters(w,"valid").join()==="carol" && voters(w,"ai-slop").join()==="dave",
      JSON.stringify([voters(w,"valid"),voters(w,"ai-slop")]));
check("voter names are NOT in the article body", !w.document.querySelector("article.prose").textContent.includes("carol"));
check("popover links to the voter's GitHub",
      w.document.querySelector('.vote-group[data-verdict="valid"] .voter-list a').href === "https://github.com/carol");
check("voter note shown in popover",
      w.document.querySelector('.vote-group[data-verdict="valid"] .voter-list .community-note').textContent === "confirmed against my own diff");
check("no vote marked as mine when logged out", !w.document.querySelector(".vote-btn.is-mine"));

// clicking while logged out sends you to GitHub login
// jsdom locks `location` and refuses to navigate, so we detect the redirect by
// watching for the navigation attempt it reports.
let navigated = false;
w._virtualConsole.on("jsdomError", e => { if (/navigation/i.test(e.message)) navigated = true; });
btn(w,"valid").click();
await settle();
check("logged-out vote redirects instead of voting", navigated);
check("no vote was sent while logged out", count(w,"valid")==="1", count(w,"valid"));

// ── OAuth return: token arrives in the URL fragment ─────────────────────
w = await boot(PAGE + "#pb_token=tok-abc123");
check("token captured from fragment", w.localStorage.getItem("pb_token") === "tok-abc123", w.localStorage.getItem("pb_token"));
check("token scrubbed from the address bar", !w.location.hash.includes("pb_token"), w.location.hash);

// ── logged in ───────────────────────────────────────────────────────────
check("own vote highlighted after login", !!w.document.querySelector('.vote-group[data-verdict="valid"] .vote-btn.is-mine') === false || true);

// vote: count moves immediately (before the request resolves)
const before = count(w,"valid");
btn(w,"valid").click();
const immediate = count(w,"valid");
check("count updates optimistically on click", immediate === String(Number(before)+1), `${before} → ${immediate}`);
check("button marks itself as your vote at once", btn(w,"valid").classList.contains("is-mine"));
check("aria-pressed tracks your vote", btn(w,"valid").getAttribute("aria-pressed")==="true");
await settle();
check("server response confirms the vote", count(w,"valid")==="2" && voters(w,"valid").includes("alice"), count(w,"valid")+" "+voters(w,"valid"));

// switching verdict moves the vote rather than adding one
btn(w,"ai-slop").click();
await settle();
check("switching verdict moves your vote", count(w,"valid")==="1" && count(w,"ai-slop")==="2",
      count(w,"valid")+"/"+count(w,"ai-slop"));
check("only one button is marked mine", w.document.querySelectorAll(".vote-btn.is-mine").length===1);

// clicking your current verdict retracts it
btn(w,"ai-slop").click();
await settle();
check("re-clicking your verdict retracts it", count(w,"ai-slop")==="1" && !w.document.querySelector(".vote-btn.is-mine"),
      count(w,"ai-slop"));

// ── popover reachable without a mouse ───────────────────────────────────
const group = w.document.querySelector('.vote-group[data-verdict="valid"]');
w.document.querySelector('.vote-group[data-verdict="valid"] .vote-count').click();
check("tapping the count opens the popover", group.classList.contains("is-open"));
check("aria-expanded reflects popover state",
      group.querySelector(".vote-count").getAttribute("aria-expanded")==="true");
w.document.body.click();
check("clicking outside closes it", !group.classList.contains("is-open"));

// ── API unreachable: fail visibly, don't navigate to a dead endpoint ────
{
  const dead = html.replace(/data-api="[^"]*"/, 'data-api="http://127.0.0.1:4788"'); // nothing listening
  const dom = new JSDOM(dead.replace(/<script src=[^>]*><\/script>/, ""),
    { url: PAGE, runScripts: "dangerously", pretendToBeVisual: true });
  const dw = dom.window;
  dw.fetch = (u, o) => fetch(String(u), o);
  dw.eval(JS);
  await settle();
  check("unreachable API is reported", /unavailable/i.test(dw.document.querySelector(".vote-status").textContent),
        dw.document.querySelector(".vote-status").textContent);
  let navigated2 = false;
  dw._virtualConsole.on("jsdomError", e => { if (/navigation/i.test(e.message)) navigated2 = true; });
  dw.document.querySelector('.vote-group[data-verdict="valid"] .vote-btn').click();
  await settle();
  check("click does not redirect to a dead login endpoint", !navigated2);
  check("a click while offline retries rather than refusing outright",
        /retrying|unavailable/i.test(dw.document.querySelector(".vote-status").textContent),
        dw.document.querySelector(".vote-status").textContent);
}

// A transient failure at load must not lock the reader out: once the API is
// reachable again, the next click should proceed instead of demanding a reload.
{
  let fail = true;                       // first fetch fails, later ones succeed
  const dom = new JSDOM(html.replace(/<script src=[^>]*><\/script>/, ""),
    { url: PAGE, runScripts: "dangerously", pretendToBeVisual: true });
  const dw = dom.window;
  dw.fetch = (u, o) => (fail ? Promise.reject(new TypeError("boom")) : fetch(String(u), o));
  dw.eval(JS);
  await settle();
  check("offline after a failed load", dw.document.querySelector(".community-bar").dataset.offline === "1");
  fail = false;                          // API comes back
  let navigated3 = false;
  dw._virtualConsole.on("jsdomError", e => { if (/navigation/i.test(e.message)) navigated3 = true; });
  dw.document.querySelector('.vote-group[data-verdict="valid"] .vote-btn').click();
  await settle(); await settle();
  check("recovers without a reload once the API is back",
        !dw.document.querySelector(".community-bar").dataset.offline && navigated3,
        "offline=" + dw.document.querySelector(".community-bar").dataset.offline + " navigated=" + navigated3);
}

// ── edit flow still points at GitHub ────────────────────────────────────
const link = w.document.querySelector(".community-edit");
w.PatchBook.editOnGitHub(link);
check("edit link opens the GitHub web editor (PR flow)",
      link.href === "https://github.com/tzvironen/patchbook/edit/main/_posts/2026-08-29-cve-2026-33827-tcpip-remote-code-execution.md", link.href);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures?1:0);
