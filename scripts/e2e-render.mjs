#!/usr/bin/env node
/**
 * E2E-Render ohne Discord (Node 22+).
 *
 * 1. Server starten (Render-Pfad braucht keinen Discord-Login):
 *      SKIP_DISCORD=true PORT=10000 node src/server.js
 * 2. Dieses Skript:
 *      node scripts/e2e-render.mjs http://127.0.0.1:10000 1 render-e2e.png
 *
 * userId 1 = Builderman. Erfolg = PNG-Datei; Misserfolg = JSON + Browser-Probleme.
 *
 * In der Render-Shell (Image enthält Chromium + puppeteer-core):
 *      node scripts/e2e-render.mjs http://127.0.0.1:10000 1 /tmp/render-e2e.png
 */
import puppeteer from "puppeteer-core";

const base = process.argv[2] || "http://127.0.0.1:10000";
const userId = process.argv[3] || "1";
const out = process.argv[4] || "render-e2e.png";

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 640 });
const issues = [];
page.on("console", (m) => {
  if (m.type() === "error") issues.push(`console: ${m.text()}`);
});
page.on("pageerror", (e) => issues.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => issues.push(`requestfailed: ${r.url()} (${r.failure()?.errorText || "?"})`));

await page.goto(`${base}/render?userId=${userId}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
await page.waitForFunction(() => window.__renderState?.done === true, { polling: 1000, timeout: 480_000 });
const state = await page.evaluate(() => window.__renderState);
console.log(JSON.stringify({
  buildId: state.buildId,
  phase: state.phase,
  message: state.message,
  error: state.error,
  assetLabels: (state.assetLabels || []).slice(-10),
  // Interne Diagnose der Thumbnail-Zustandsmaschine: konkreter Teilschritt,
  // Render-Descriptor-Zähler und die zuletzt pending Instanzen.
  prepareStage: state.prepareStage,
  prepare: state.prepare || null,
  skippedAssets: (state.skippedAssets || []).slice(-10),
  skippedRenderInstances: (state.skippedRenderInstances || []).slice(-10),
}, null, 2));
if (state.error) {
  console.error("--- Browser-Probleme ---");
  for (const line of issues.slice(-30)) console.error(line);
  process.exitCode = 1;
} else {
  const canvas = await page.$("canvas");
  if (!canvas) {
    console.error("Kein <canvas> auf der Seite.");
    process.exitCode = 1;
  } else {
    await canvas.screenshot({ path: out, type: "png" });
    console.log("PNG gespeichert:", out);
  }
}
await browser.close();
