/* global document, window, innerHeight, innerWidth, getComputedStyle */
/** Disposable real-browser regression. No backend, target, or user browser.
 * Run after npm ci: node scripts/test-expanded-watch.mjs */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../frontend");
const dir = await mkdtemp(path.join(root, ".expanded-smoke-"));
let server, browser;
try {
  await writeFile(path.join(dir, "index.html"), '<div id="root"></div><script type="module" src="./main.tsx"></script>');
  await writeFile(
    path.join(dir, "main.tsx"),
    `
import React from "react";
import { createRoot } from "react-dom/client";
import Panel from "../src/components/ComputerUsePanel";
import { useComputerUseController } from "../src/hooks/useComputerUseController";
import { computerUseClient as client } from "../src/api/computerUse";
import "../src/index.css";
const kind = new URLSearchParams(location.search).get("kind") || "browser";
const canvas = document.createElement("canvas");
canvas.width = kind === "native" ? 1080 : 1280; canvas.height = kind === "native" ? 1920 : 800;
const ctx = canvas.getContext("2d")!;
ctx.fillStyle = "#124"; ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.strokeStyle = "lime"; ctx.lineWidth = 24; ctx.strokeRect(12, 12, canvas.width - 24, canvas.height - 24);
const state = { permission: "allow", capabilities: [{ kind, available: true }], sessions: [{ id: "mock", kind, state: "active", controller: "human", generation: 1, targetLabel: "Disposable mocked target" }] };
window.counts = { observe: 0, action: 0, control: 0, open: 0, status: 0 };
client.status = async () => { window.counts.status++; return state; };
client.observe = async () => { window.counts.observe++; return { generation: 1, frameId: "mock", frame: { mimeType: "image/png", data: canvas.toDataURL().split(",")[1], width: canvas.width, height: canvas.height } }; };
client.action = async () => { window.counts.action++; return {}; };
client.control = async () => { window.counts.control++; return {}; };
client.open = async () => { window.counts.open++; throw Error("must not open"); };
function App() { const controller = useComputerUseController("smoke", { viewOpen: true }); return <div style={{height: "100dvh"}}><Panel chatId="smoke" permission="allow" controller={controller}/></div>; }
createRoot(document.getElementById("root")!).render(<App/>);
`,
  );
  server = await createServer({ configFile: false, root, esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = server.resolvedUrls.local[0] + path.basename(dir) + "/index.html";
  for (const kind of ["browser", "native"]) {
    for (const [width, height] of [
      [1440, 900],
      [1280, 600],
      [390, 844],
      [844, 390],
      [320, 568],
      [568, 320],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(url + "?kind=" + kind);
      await page.getByRole("button", { name: "Refresh screenshot", exact: true }).click();
      const expand = page.getByRole("button", { name: "Expand view", exact: true });
      await expand.waitFor();
      const before = await page.evaluate(() => ({ ...window.counts }));
      await expand.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Expanded watch view" });
      await dialog.waitFor();
      assert.equal(await page.getByRole("button", { name: "Close expanded view" }).evaluate((e) => e === document.activeElement), true);
      const geometry = await dialog.evaluate((d) => {
        const image = d.querySelector("img");
        const r = image.getBoundingClientRect();
        const dr = d.getBoundingClientRect();
        const toolbar = d.querySelector(".computer-use-expanded-toolbar").getBoundingClientRect();
        return {
          x: dr.x,
          y: dr.y,
          w: dr.width,
          h: dr.height,
          image: { x: r.x, y: r.y, w: r.width, h: r.height },
          toolbarBottom: toolbar.bottom,
          fit: getComputedStyle(image).objectFit,
          naturalWidth: image.naturalWidth,
        };
      });
      assert.equal(geometry.w, width);
      assert.equal(geometry.h, height);
      assert.equal(geometry.x, 0);
      assert.equal(geometry.y, 0);
      assert.equal(geometry.fit, "contain");
      assert.ok(geometry.naturalWidth > 0);
      assert.ok(geometry.image.h > height * 0.35);
      assert.ok(geometry.image.y >= geometry.toolbarBottom);
      assert.ok(geometry.image.y + geometry.image.h <= height + 1);
      for (const name of ["Close expanded view", "Live", "Stop computer control"]) {
        const target = page.getByRole("button", { name, exact: true });
        assert.equal(
          await target.evaluate((e) => {
            const r = e.getBoundingClientRect();
            return (
              r.height >= 44 &&
              r.width >= 44 &&
              r.top >= 0 &&
              r.bottom <= innerHeight &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
          true,
          name + " visible hit target",
        );
      }
      // Top-layer modal makes even programmatic background focus ineffective.
      await expand.evaluate((e) => e.focus());
      assert.equal(await dialog.evaluate((d) => d.contains(document.activeElement)), true);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        assert.equal(await dialog.evaluate((d) => d.contains(document.activeElement)), true);
      }
      await dialog.locator("img").click();
      await page.keyboard.press("Escape");
      assert.equal(await dialog.count(), 0);
      assert.equal(await expand.evaluate((e) => e === document.activeElement), true);
      const after = await page.evaluate(() => window.counts);
      for (const key of ["observe", "action", "control", "open"]) assert.equal(after[key], before[key]);
      console.log("PASS", kind, width + "x" + height, "fit, hit targets, focus isolation/restoration, no side effects");
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}
