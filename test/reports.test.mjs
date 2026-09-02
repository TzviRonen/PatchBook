/* Windows report list: date filter, range slider, severity plot.
 *
 *   python3 serve.py 3004 &
 *   npm install jsdom
 *   node test/reports.test.mjs
 *
 * Runs against the real rendered page with fixture reports written into
 * _reports/ for the duration of the run, so the filter and the chart are
 * exercised with realistic spread rather than the single published report.
 * No API involved — this page makes no vote calls.
 */
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS = path.join(HERE, "..", "_reports");
const SITE = process.env.SITE || "http://127.0.0.1:3004";

// date, cve, cvss (null = unscored), title
const FIXTURES = [
  ["2026-03-14", "CVE-2026-11001", "9.8", "Remote code execution in srv2.sys SMB compression"],
  ["2026-04-02", "CVE-2026-11002", "7.8", "Elevation of privilege via win32k window class confusion"],
  ["2026-05-19", "CVE-2026-11003", "4.3", "Kernel pool address disclosure in nsiproxy"],
  ["2026-06-08", "CVE-2026-11004", "8.1", "Use-after-free in afd.sys polling path"],
  ["2026-06-27", "CVE-2026-11005", null,  "Unscored regression in ndis.sys filter attach"],
  ["2026-07-15", "CVE-2026-11006", "6.5", "Race in tcpip.sys reassembly queue"],
  ["2026-08-04", "CVE-2026-11007", "9.1", "Double free in dxgkrnl escape handler"],
  ["2026-08-21", "CVE-2026-11008", "3.3", "Info leak in cng.sys entropy pool"],
];

const written = [];
for (const [date, cve, cvss, title] of FIXTURES) {
  const file = path.join(REPORTS, `${date}-${cve.toLowerCase()}-fixture.md`);
  const fm = ["---", "layout: report", `title: "${cve}: ${title}"`, `date: ${date}`, `cve_id: ${cve}`];
  if (cvss) fm.push(`cvss: ${cvss}`);
  fm.push('excerpt: "Fixture report used to exercise the date filter and severity plot."', "---", "", `# ${cve}: ${title}`, "", "Fixture body.", "");
  fs.writeFileSync(file, fm.join("\n"));
  written.push(file);
}
const cleanup = () => written.forEach((f) => { try { fs.unlinkSync(f); } catch {} });
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

const JS = fs.readFileSync(path.join(HERE, "..", "assets", "patchbook.js"), "utf8");
const html = await (await fetch(`${SITE}/windows/`)).text();
const dom = new JSDOM(html.replace(/<script src=[^>]*><\/script>/g, ""),
  { url: `${SITE}/windows/`, runScripts: "dangerously", pretendToBeVisual: true });
const w = dom.window;
w.fetch = () => Promise.reject(new TypeError("no api on this page"));
w.eval(JS);
await new Promise((r) => setTimeout(r, 300));

let bad = 0; const ok=(n,c,e="")=>{console.log((c?"PASS  ":"FAIL  ")+n+(c?"":"  "+e)); if(!c)bad++;};
const $=s=>w.document.querySelector(s);
const cards=()=>[...w.document.querySelectorAll(".report-card")];
const shown=()=>cards().filter(c=>!c.hidden).length;
const dots=()=>w.document.querySelectorAll(".chart-point").length;

ok("all 9 reports listed initially", cards().length===9, cards().length);
// The range opens on Jan 1, or on the earliest report when every report is
// newer than that — the default is a starting selection, not a floor.
ok("default range opens at the earliest report, ending today",
   $("[data-filter-from]").value==="2026-03-14" &&
   $("[data-filter-to]").value===new Date().toISOString().slice(0,10),
   $("[data-filter-from]").value+" → "+$("[data-filter-to]").value);
ok("the track starts at the earliest report, not an empty stretch",
   $("[data-range-min]").textContent==="2026-03-14", $("[data-range-min]").textContent);
ok("every fixture falls inside the default range", shown()===9, shown());
ok("chart is visible", !$("[data-severity-chart]").hidden);
ok("8 dots — the unscored report is not plotted", dots()===8, dots());
ok("note counts the unscored one", /1 without a CVSS/.test($("[data-chart-note]").textContent), $("[data-chart-note]").textContent);
ok("summary shows the total", /9 report/.test($("[data-filter-summary]").textContent), $("[data-filter-summary]").textContent);
ok("dots link to reports", [...w.document.querySelectorAll(".chart-point")].every(a=>a.getAttribute("href")?.includes("/reports/")));
ok("dot has an accessible label", /CVSS/.test(w.document.querySelector(".chart-point").getAttribute("aria-label")));
ok("hit target is bigger than the dot",
   +w.document.querySelector(".chart-hit").getAttribute("r") >= 12 &&
   +w.document.querySelector(".chart-dot").getAttribute("r") >= 4);

// narrow the range via the date inputs
const from=$("[data-filter-from]"), to=$("[data-filter-to]");
from.value="2026-06-01"; from.dispatchEvent(new w.Event("change"));
to.value="2026-08-10";   to.dispatchEvent(new w.Event("change"));
await new Promise(r=>setTimeout(r,50));
ok("date filter narrows the list", shown()===4, shown()+" visible");
ok("chart redraws when the range changes", dots()===3, dots()+" dots");
ok("summary reflects the subset", /4 of 9/.test($("[data-filter-summary]").textContent), $("[data-filter-summary]").textContent);

// the slider is two handles on one track, not native inputs
ok("no native range inputs remain", w.document.querySelectorAll('input[type="range"]').length===0);
ok("two handles on one track", w.document.querySelectorAll(".range-handle").length===2 &&
   w.document.querySelectorAll("[data-range-track]").length===1);
ok("handles expose their date to assistive tech",
   $('[data-range-handle="from"]').getAttribute("aria-valuenow")==="2026-06-01",
   $('[data-range-handle="from"]').getAttribute("aria-valuenow"));
ok("handles move with the range", $('[data-range-handle="from"]').style.left !== "",
   $('[data-range-handle="from"]').style.left);
ok("fill spans between the handles", $("[data-range-fill]").style.width !== "");

// keyboard: each handle is operable without a pointer
{
  const h = $('[data-range-handle="from"]');
  const before = $("[data-filter-from]").value;
  h.dispatchEvent(new w.KeyboardEvent("keydown", { key:"ArrowRight", bubbles:true, cancelable:true }));
  ok("arrow key nudges the start date", $("[data-filter-from]").value !== before,
     before+" → "+$("[data-filter-from]").value);
  h.dispatchEvent(new w.KeyboardEvent("keydown", { key:"Home", bubbles:true, cancelable:true }));
  ok("Home jumps to the domain start", $("[data-filter-from]").value === $("[data-range-min]").textContent,
     $("[data-filter-from]").value);
  // put it back for the checks that follow
  from.value="2026-06-01"; from.dispatchEvent(new w.Event("change"));
}

// Dates outside the data clamp to its bounds, so an empty range is only
// reachable in a gap between reports (04-02 … 05-19 here).
// The domain starts at the earliest report, so anything before that clamps to
// it — there is nothing older to find.
from.value="2025-05-05"; from.dispatchEvent(new w.Event("change"));
ok("a date before the earliest report clamps to it", from.value==="2026-03-14", from.value);
from.value="2026-04-03"; from.dispatchEvent(new w.Event("change"));
to.value="2026-05-18";   to.dispatchEvent(new w.Event("change"));
await new Promise(r=>setTimeout(r,50));
ok("empty range hides every card", shown()===0, shown());
ok("empty-state message shown", !$("[data-filter-empty]").hidden);
ok("chart hidden when nothing is scored", $("[data-severity-chart]").hidden);

// reset
$("[data-filter-reset]").click(); await new Promise(r=>setTimeout(r,50));
$("[data-filter-reset]").click();
ok("reset returns to the full range", $("[data-filter-from]").value==="2026-03-14", $("[data-filter-from]").value);
ok("reset restores everything", shown()===9 && dots()===8, shown()+"/"+dots());
ok("tooltip fires on keyboard focus", (()=>{ const p=w.document.querySelector(".chart-point"); p.dispatchEvent(new w.Event("focus")); return !$("[data-chart-tip]").hidden; })());
ok("tooltip leads with the value", /^CVSS /.test($(".chart-tip-value").textContent), $(".chart-tip-value").textContent);

// Geometry: the validator checks colour, not layout — assert nothing escapes
// the plot area and the dots scale uniformly (a stretched viewBox turns them
// into ovals).
{
  const svg = $("[data-chart-svg]");
  const dots = [...svg.querySelectorAll(".chart-dot")].map((d) => ({ x: +d.getAttribute("cx"), y: +d.getAttribute("cy") }));
  ok("no mark escapes the plot area",
     dots.every((d) => d.x >= 34 && d.x <= 944 && d.y >= 14 && d.y <= 192));
  ok("aspect ratio is not stretched", svg.getAttribute("preserveAspectRatio") === null);
  const css = fs.readFileSync(path.join(HERE, "..", "assets", "main.css"), "utf8");
  // `height: auto` alone collapses a viewBox-only SVG to zero height in a real
  // browser — the chart renders but is invisible, and no jsdom test can see it.
  ok("svg height is pinned by aspect-ratio", /\.severity-chart svg\s*\{[^}]*aspect-ratio/.test(css));
  // `.report-card { display: block }` outranks the UA's `[hidden]` rule, so
  // filtered-out cards stay on screen without this. Invisible to jsdom, which
  // reads the property and not the cascade.
  ok("hidden cards are actually hidden by the cascade",
     /\.report-card\[hidden\]/.test(css) && /\.severity-chart\[hidden\]/.test(css));
  // Two renderers, one behaviour: the page is inert without the script, and
  // serve.py has its own copy of the template.
  ok("the page loads patchbook.js", /assets\/patchbook\.js/.test(html), "no script tag in the served HTML");
  ok("grid is a hairline set, not per-point", svg.querySelectorAll(".chart-grid").length === 5);
}


// ── round trip: a file the Publish form generated must actually render ────
// The generator is unit-tested in publish.test.mjs, but only this proves its
// output survives serve.py's hand-rolled frontmatter parser and both H1
// strippers. A quote or newline in the wrong place shows up here and nowhere
// else.
{
  const vm = await import("node:vm");
  const g = {
    console, navigator: {},
    document: { readyState: "complete", addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
    location: { hash: "", pathname: "/", search: "", href: "http://localhost/" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { replaceState() {} },
  };
  g.window = g;
  vm.createContext(g);
  vm.runInContext(JS, g);
  const P = g.window.PatchBookPublish;

  const values = {
    cve: "CVE-2026-77777", date: "2026-05-05", cvss: "9.3",
    title: 'Pool overflow in "afd.sys": a *nasty* one',
    binary: "afd.sys", kb: "KB5099999",
    excerpt: "first line\nsecond line", body: "",
  };
  const name = P.filenameFor(values).replace(/^_reports\//, "");
  const file = path.join(REPORTS, name);
  fs.writeFileSync(file, P.fileFor(values));
  written.push(file);

  const slug = name.replace(/\.md$/, "");
  const res = await fetch(`${SITE}/reports/${slug}`);
  const page = await res.text();
  ok("generated report renders", res.status === 200, res.status);

  // Two legitimate occurrences: <title> and the styled header. A third means
  // the body's H1 was not stripped — both renderers are brittle about that,
  // and this is what catches it.
  const titles = (page.match(/Pool overflow in/g) || []).length;
  ok("generated report's title is not duplicated", titles === 2, titles + " occurrences");
  ok("no stray H1 survives in the article", !/<article[^>]*>[\s\S]*?<h1/.test(page));

  // Double quotes are deliberately downgraded to single ones: serve.py does
  // `.strip('"')` with no escape handling, so a double quote cannot survive
  // inside a quoted value.
  ok("quotes were downgraded, not mangled", /Pool overflow in &#39;afd\.sys&#39;/.test(page), "title mangled");
  ok("severity badge picked the right band", /badge red/.test(page));
  ok("metadata bullets rendered", /Affected binary/.test(page));

  const list = await (await fetch(`${SITE}/windows/`)).text();
  ok("generated report appears in the Windows list",
     list.includes(`data-date="2026-05-05"`) && list.includes(`data-cvss="9.3"`));
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
