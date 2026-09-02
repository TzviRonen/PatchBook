/* Layout and pointer behaviour, in a real browser.
 *
 *   python3 serve.py 3004 &
 *   npx playwright install --with-deps chromium && npm install playwright
 *   node test/browser.test.mjs
 *
 * Optional — the other suites run anywhere Node does. This one exists because
 * jsdom does no layout and no cascade, and shipped three bugs it could not see:
 * an SVG that collapsed to zero height, filtered cards that stayed on screen
 * because a class rule outranked [hidden], and a template that never loaded its
 * own script. All three were invisible to every other test and obvious the
 * moment a browser drew the page.
 */
import pw from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS = path.join(HERE, "..", "_reports");
const SITE = process.env.SITE || "http://127.0.0.1:3004";

const FIXTURES = [
  ["2026-03-14", "CVE-2026-12001", "9.8"],
  ["2026-05-19", "CVE-2026-12002", "4.3"],
  ["2026-06-27", "CVE-2026-12003", null],
  ["2026-08-04", "CVE-2026-12004", "9.1"],
];
const written = [];
for (const [date, cve, cvss] of FIXTURES) {
  const file = path.join(REPORTS, `${date}-${cve.toLowerCase()}-browserfixture.md`);
  const fm = ["---", "layout: report", `title: "${cve}: browser fixture"`, `date: ${date}`, `cve_id: ${cve}`];
  if (cvss) fm.push(`cvss: ${cvss}`);
  fm.push("---", "", "Fixture body.", "");
  fs.writeFileSync(file, fm.join("\n"));
  written.push(file);
}
const cleanup = () => written.forEach((f) => { try { fs.unlinkSync(f); } catch {} });
process.on("exit", cleanup);

let bad = 0;
const ok = (n, c, e = "") => { console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + e)); if (!c) bad++; };

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${SITE}/windows/`, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

// The script has to actually load, or the page is inert and every other
// assertion here would be testing static HTML.
ok("patchbook.js is loaded and evaluated",
   await page.evaluate(() => typeof window.PatchBookReports === "object"));

const svg = await page.locator("[data-chart-svg]").boundingBox();
ok("the chart has real height", svg !== null && svg.height > 100, svg && `${svg.width}x${svg.height}`);

const dot = await page.locator(".chart-dot").first().boundingBox();
ok("dots are round, not stretched", dot && Math.abs(dot.width - dot.height) < 1,
   dot && `${dot.width}x${dot.height}`);

// Opens on Jan 1, or on the earliest report when everything is newer — the
// default is a starting selection, not a floor.
ok("default range opens at the earliest report, ending today",
   (await page.locator("[data-filter-from]").inputValue()) === "2026-03-14" &&
   (await page.locator("[data-filter-to]").inputValue()) === new Date().toISOString().slice(0, 10),
   await page.locator("[data-filter-from]").inputValue());

const before = { cards: await page.locator(".report-card:visible").count(),
                 dots: await page.locator(".chart-point").count() };
ok("every fixture is in range by default", before.cards >= 4 && before.dots >= 3, JSON.stringify(before));

// Drag the start handle along the track — the interaction the whole control
// exists for.
const track = await page.locator("[data-range-track]").boundingBox();
const handle = await page.locator('[data-range-handle="from"]').boundingBox();
await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
await page.mouse.down();
await page.mouse.move(track.x + track.width * 0.6, handle.y + handle.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(250);

const dragged = await page.locator("[data-filter-from]").inputValue();
ok("dragging the start handle moves the start date", dragged !== "2026-01-01", dragged);

const after = { cards: await page.locator(".report-card:visible").count(),
                dots: await page.locator(".chart-point").count() };
ok("the list shrinks with the range", after.cards < before.cards, `${before.cards} → ${after.cards}`);
ok("the plot redraws with the range", after.dots < before.dots, `${before.dots} → ${after.dots}`);

// Keyboard parity: the handle is a slider, so arrows must work.
await page.locator('[data-range-handle="to"]').focus();
const toBefore = await page.locator("[data-filter-to]").inputValue();
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(150);
ok("arrow keys move a focused handle",
   (await page.locator("[data-filter-to]").inputValue()) !== toBefore, toBefore);

await page.locator("[data-filter-reset]").click();
await page.waitForTimeout(200);
ok("reset returns to the default range",
   (await page.locator("[data-filter-from]").inputValue()) === "2026-03-14");
ok("reset restores the full list",
   (await page.locator(".report-card:visible").count()) === before.cards);

// Clicking a dot must open its report.
await page.locator(".chart-point").first().click();
await page.waitForLoadState("networkidle");
ok("clicking a dot opens the report", page.url().includes("/reports/"), page.url());

ok("no page errors", errors.length === 0, errors.join(" | "));


/* ── Publish form ───────────────────────────────────────────────────────── */
// The clipboard is the whole handover mechanism and cannot be tested anywhere
// but here: jsdom has no clipboard, no permissions model and no layout.
{
  const ctx = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 1100, height: 900 },
  });
  const pub = await ctx.newPage();
  const pubErrors = [];
  pub.on("pageerror", (e) => pubErrors.push(e.message));
  await pub.goto(`${SITE}/publish`, { waitUntil: "networkidle" });
  await pub.waitForTimeout(300);

  ok("publish page loads its script", await pub.evaluate(() => typeof window.PatchBookPublish === "object"));
  ok("nav offers all three tabs", (await pub.locator("nav .nav-links a").count()) === 3);
  ok("the body starts from the section skeleton",
     (await pub.locator('[name="body"]').inputValue()).startsWith("## TL;DR"));

  // The native date input is a real picker only in a browser.
  await pub.fill('[name="date"]', "2026-07-04");
  ok("native date input yields an ISO date", (await pub.locator('[name="date"]').inputValue()) === "2026-07-04");

  await pub.fill('[name="cvss"]', "9.4");
  await pub.waitForTimeout(120);
  ok("severity badge previews the band live",
     (await pub.locator("[data-cvss-preview]").getAttribute("class")).includes("red"),
     await pub.locator("[data-cvss-preview]").getAttribute("class"));

  // An invalid form must not open a tab or reveal the output panel.
  await pub.fill('[name="cve_id"]', "nope");
  await pub.click("[data-publish-submit]");
  await pub.waitForTimeout(200);
  ok("an invalid report is blocked before anything opens", await pub.locator("[data-publish-output]").isHidden());

  await pub.fill('[name="cve_id"]', "cve-2026-44444");
  await pub.fill('[name="title"]', 'Pool overflow in "afd.sys"');
  await pub.locator('[name="cve_id"]').blur();
  await pub.waitForTimeout(150);
  ok("the filename is shown before submitting",
     (await pub.locator("[data-publish-filename]").textContent()).includes("cve-2026-44444"));

  const [popup] = await Promise.all([
    pub.waitForEvent("popup").catch(() => null),
    pub.click("[data-publish-submit]"),
  ]);
  await pub.waitForTimeout(500);

  const clip = await pub.evaluate(() => navigator.clipboard.readText());
  ok("the report reaches the clipboard", clip.startsWith("---\nlayout: report"), clip.slice(0, 30));
  ok("clipboard and on-screen file agree", clip === (await pub.locator("[data-publish-file]").inputValue()));
  ok("GitHub's new-file editor is opened",
     popup !== null && /github\.com/.test(popup.url()) && popup.url().includes("filename"), popup && popup.url().slice(0, 60));
  ok("a download is offered as well", !!(await pub.locator("[data-publish-download]").getAttribute("href")));
  ok("no page errors on the publish page", pubErrors.length === 0, pubErrors.join(" | "));

  // Narrow viewport: the form must not overflow.
  await pub.setViewportSize({ width: 390, height: 800 });
  await pub.waitForTimeout(200);
  ok("publish form does not overflow at 390px",
     (await pub.evaluate(() => document.documentElement.scrollWidth)) <= 400);
  await ctx.close();
}

// The clipboard-denied path is the entire flow for anyone who refuses the
// permission or browses over plain http, so it has to actually work.
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const pub = await ctx.newPage();
  await pub.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { get: () => undefined });
  });
  await pub.goto(`${SITE}/publish`, { waitUntil: "networkidle" });
  await pub.fill('[name="cve_id"]', "CVE-2026-55555");
  await pub.fill('[name="date"]', "2026-02-02");
  await pub.fill('[name="cvss"]', "3.1");
  await pub.fill('[name="title"]', "Info leak in cng.sys");
  await pub.click("[data-publish-submit]");
  await pub.waitForTimeout(400);

  ok("without a clipboard the file is still shown",
     (await pub.locator("[data-publish-file]").inputValue()).startsWith("---"));
  ok("the failure is explained, not silent",
     /clipboard/i.test(await pub.locator("[data-publish-status]").textContent()));
  ok("the text is pre-selected for a manual copy",
     await pub.evaluate(() => {
       const t = document.querySelector("[data-publish-file]");
       return t.selectionEnd - t.selectionStart > 50;
     }));
  ok("the editor can still be opened by hand",
     (await pub.locator("[data-publish-open]").getAttribute("href")).includes("/new/"));
  const box = await pub.locator(".publish-output").boundingBox();
  ok("the fallback panel has real size", box !== null && box.height > 100, box && box.height);
  await ctx.close();
}

await browser.close();
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
