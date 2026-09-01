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

ok("default range is Jan 1 → today",
   (await page.locator("[data-filter-from]").inputValue()) === "2026-01-01" &&
   (await page.locator("[data-filter-to]").inputValue()) === new Date().toISOString().slice(0, 10));

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
   (await page.locator("[data-filter-from]").inputValue()) === "2026-01-01");
ok("reset restores the full list",
   (await page.locator(".report-card:visible").count()) === before.cards);

// Clicking a dot must open its report.
await page.locator(".chart-point").first().click();
await page.waitForLoadState("networkidle");
ok("clicking a dot opens the report", page.url().includes("/reports/"), page.url());

ok("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
