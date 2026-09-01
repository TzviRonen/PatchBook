/* The Publish form's generator: filenames, sanitising, validation.
 *
 *   node test/publish.test.mjs        (no server, no jsdom, no network)
 *
 * The generator is pure, so it is exercised directly in a VM rather than
 * through a page. Interaction and the clipboard are covered by
 * test/browser.test.mjs; the round trip through the real renderers is covered
 * by test/reports.test.mjs.
 */
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, "..", "assets", "patchbook.js"), "utf8");

// Minimal browser surface: patchbook.js self-starts and touches these on load.
const g = {
  console,
  navigator: {},
  document: { readyState: "complete", addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
  location: { hash: "", pathname: "/", search: "", href: "http://localhost/" },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  history: { replaceState() {} },
};
g.window = g;
vm.createContext(g);
vm.runInContext(src, g);
const P = g.window.PatchBookPublish;

let bad = 0;
const ok = (n, c, e = "") => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + e)); if (!c) bad++; };

const base = { cve: "CVE-2026-33827", date: "2026-08-29", cvss: "8.1", title: "Use-After-Free in tcpip.sys", binary: "tcpip.sys", kb: "", excerpt: "", body: "" };
const withTitle = (title) => Object.assign({}, base, { title });

/* ── filename ───────────────────────────────────────────────────────────── */

ok("filename matches the pipeline's convention",
   P.filenameFor(base) === "_reports/2026-08-29-cve-2026-33827-use-after-free-in-tcpip-sys.md",
   P.filenameFor(base));

// Every one of these must stay inside REPORT_RE (worker/src/index.js). A
// filename outside it makes every vote on the merged report 400.
[
  ["plain", "Use-After-Free in the IPv4 Path"],
  ["slashes and plus", "a/b+c d"],
  ["accents", "Überlauf im Kernel — Größe"],
  ["non-latin script", "日本語のみ"],
  ["punctuation only", "...."],
  ["quotes", 'He said "boom"'],
  ["very long", "x".repeat(200)],
  ["leading dots", "..hidden"],
  ["newlines", "first\nsecond"],
].forEach(([label, title]) => {
  const name = P.filenameFor(withTitle(title));
  ok("filename stays REPORT_RE-valid: " + label, P.REPORT_RE.test(name), name);
});

ok("a CVE prefix in the title is not repeated in the slug",
   P.filenameFor(withTitle("CVE-2026-33827: Use-After-Free")) ===
   "_reports/2026-08-29-cve-2026-33827-use-after-free.md",
   P.filenameFor(withTitle("CVE-2026-33827: Use-After-Free")));

ok("an unusable title falls back rather than producing a bare name",
   P.slugify("日本語のみ") === "report", P.slugify("日本語のみ"));

ok("slug is capped", P.slugify("x".repeat(200)).length <= 60, P.slugify("x".repeat(200)).length);

/* ── frontmatter sanitising ─────────────────────────────────────────────── */
// serve.py's parser is line-oriented, does `.strip('"')` and nothing else, and
// supports no multi-line values at all (serve.py:24-46).

const nasty = P.fileFor(Object.assign({}, base, {
  title: 'He said "boom": a *use-after-free*',
  excerpt: "line one\nline two\twith  a  tab",
  kb: "KB5082052",
}));
const frontmatter = nasty.split("\n---\n")[0];

ok("file starts with the fence on line 1", nasty.startsWith("---\n"));
ok("no carriage returns survive", !/\r/.test(P.fileFor(Object.assign({}, base, { body: "a\r\nb" }))));
ok("every frontmatter line is a single key: value",
   frontmatter.split("\n").slice(1).every((l) => /^[a-z_]+: .+$/.test(l)), frontmatter);
ok("inner double quotes are downgraded, not escaped",
   /^title: "He said 'boom': a \*use-after-free\*"$/m.test(frontmatter),
   frontmatter.split("\n").find((l) => l.startsWith("title:")));
ok("newlines and tabs in the excerpt collapse to one line",
   /^excerpt: "line one line two with a tab"$/m.test(frontmatter),
   frontmatter.split("\n").find((l) => l.startsWith("excerpt:")));
ok("frontmatter key order matches the pipeline",
   frontmatter.split("\n").slice(1).map((l) => l.split(":")[0]).join(",") ===
   "layout,title,date,cve_id,cvss,excerpt",
   frontmatter);

// `.strip('"')` would eat the reader's own outer quotes.
ok("the author's own leading/trailing quotes do not unbalance the value",
   /^title: "quoted"$/m.test(P.fileFor(withTitle('"quoted"'))),
   P.fileFor(withTitle('"quoted"')).split("\n").find((l) => l.startsWith("title:")));

// Single quotes are NOT stripped by serve.py, so they must survive untouched.
ok("single quotes are left alone",
   /^title: "it's fine"$/m.test(P.fileFor(withTitle("it's fine"))));

ok("excerpt is capped at 300 characters",
   P.fileFor(Object.assign({}, base, { excerpt: "y".repeat(400) }))
    .split("\n").find((l) => l.startsWith("excerpt:")).length <= 300 + 12);

ok("an empty excerpt is omitted entirely",
   !/^excerpt:/m.test(P.fileFor(base)));

/* ── body ───────────────────────────────────────────────────────────────── */
// Both renderers strip a leading H1, and both are brittle: report.html only
// strips when the rendered body begins <h1, serve.py needs "# " with a space.

const body = nasty.split("\n---\n")[1];
ok("body opens with exactly one blank line then the H1",
   /^\n# CVE-2026-33827: /.test(body), JSON.stringify(body.slice(0, 40)));
ok("H1 has a space after the hash", /\n# [^#]/.test(body));
ok("markdown is escaped in the H1 only",
   /# CVE-2026-33827: He said "boom": a \\\*use-after-free\\\*/.test(body));
ok("house-style metadata bullets are present",
   /- \*\*Affected binary:\*\*/.test(body) && /- \*\*CVSS:\*\* 8\.1/.test(body));
ok("the skeleton is used when no body is given", /## TL;DR/.test(P.fileFor(base)));
ok("file ends with a single newline", /[^\n]\n$/.test(nasty));

/* ── severity bands ─────────────────────────────────────────────────────── */
[[3.9,"muted"],[4,"yellow"],[6.9,"yellow"],[7,"orange"],[8.9,"orange"],[9,"red"],[10,"red"]]
  .forEach(([v, cls]) => ok("CVSS " + v + " → " + cls, P.severityClass(String(v)) === cls, P.severityClass(String(v))));
ok("a missing score is muted", P.severityClass("") === "muted");
ok("cvss is emitted with one decimal", /^cvss: 8\.0$/m.test(P.fileFor(Object.assign({}, base, { cvss: "8" }))));

/* ── validation ─────────────────────────────────────────────────────────── */
ok("a good report validates", P.validate(base) === null, P.validate(base));
ok("lowercase cve is accepted once uppercased",
   P.validate(Object.assign({}, base, { cve: "CVE-2026-1234" })) === null);
[["not a cve","NOPE"],["too few digits","CVE-2026-1"],["trailing junk","CVE-2026-33827x"]]
  .forEach(([label, cve]) => ok("rejects " + label, P.validate(Object.assign({}, base, { cve })) !== null));
ok("rejects a missing date", P.validate(Object.assign({}, base, { date: "" })) !== null);
ok("rejects an out-of-range score", P.validate(Object.assign({}, base, { cvss: "11" })) !== null);
ok("rejects an empty title", P.validate(withTitle("   ")) !== null);

/* ── the GitHub URL ─────────────────────────────────────────────────────── */
// ?value= cannot carry a report: GitHub 500s at ~7,000 URL chars and 414s at
// ~8,200, while a real report percent-encodes to ~21,000. Only ?filename= is
// sent, and this pins that so nobody "helpfully" adds a prefill later.
const url = P.newFileUrl({ dataset: { repo: "TzviRonen/PatchBook", branch: "main" } },
                         P.filenameFor(base));
ok("url targets the new-file editor on the right branch",
   url.startsWith("https://github.com/TzviRonen/PatchBook/new/main?filename="), url);
ok("url carries no prefilled value", !/[?&]value=/.test(url));
ok("url stays far below GitHub's limit", url.length < 2000, url.length);

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
