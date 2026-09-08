/** Offline headless integration: captured native transcript -> real renderers.
 * No production config, server, desktop grant, or external network is used.
 * Run: node --import tsx scripts/codex-direct-ui-browser-smoke.ts */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { parseCodexRollout } from "../backend/src/agents/adapters/codex/sessionParser.js";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../frontend", import.meta.url));
const fixture = fileURLToPath(new URL("../backend/src/agents/adapters/codex/__fixtures__/direct-ui-rollout.jsonl", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
const server = await createServer({
  configFile: false,
  root,
  server: { host: "127.0.0.1", port: 0 },
  esbuild: { jsx: "automatic" },
  plugins: [
    {
      name: "direct-ui-smoke",
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url === "/smoke") {
            res.setHeader("Content-Type", "text/html");
            res.end('<div id="root"></div><script type="module" src="/smoke.tsx"></script>');
          } else if (req.url === "/messages") {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(parseCodexRollout(fixture)));
          } else if (req.url?.startsWith("/api/files/serve?")) {
            res.setHeader("Content-Type", "image/png");
            res.end(png);
          } else if (req.url?.startsWith("/api/canvas/smoke-canvas/")) {
            res.setHeader("Content-Type", "text/html");
            res.end(`<h1>${req.url.endsWith("/2") ? "Updated smoke canvas" : "Smoke canvas"}</h1>`);
          } else next();
        });
      },
      resolveId(id) {
        if (id === "/smoke.tsx") return id;
      },
      load(id) {
        if (id === "/smoke.tsx")
          return `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ToolCallBubble from '/src/components/ToolCallBubble.tsx';
      const messages = await (await fetch('/messages')).json();
      createRoot(document.getElementById('root')).render(<main>{messages.filter(m=>m.type==='tool_use').map((use,i)=><section key={i} data-tool={use.toolName}><ToolCallBubble toolUse={use} toolResult={messages.find(r=>r.type==='tool_result' && r.toolUseId===use.toolUseId) ?? null} isRunning={false}/></section>)}</main>);
    `;
      },
    },
  ],
});
let browser;
try {
  await server.listen();
  const address = server.httpServer!.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route("**/*", (route) => (route.request().url().startsWith(base) ? route.continue() : route.abort()));
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(`${base}/smoke`);
  for (let load = 0; load < 2; load++) {
    await page.waitForSelector('img[alt="Smoke image"]');
    await page.waitForFunction(() => {
      const image = document.querySelector('img[alt="Smoke image"]') as HTMLImageElement | null;
      return image?.complete && image.naturalWidth > 0;
    });
    assert.equal(await page.locator('iframe[title="Smoke canvas"]').count(), 2);
    assert.equal(await page.frameLocator('iframe[src$="/1"]').locator("h1").textContent(), "Smoke canvas");
    assert.equal(await page.frameLocator('iframe[src$="/2"]').locator("h1").textContent(), "Updated smoke canvas");
    assert.equal(await page.locator('[data-tool="exec"] img, [data-tool="exec"] iframe').count(), 0);
    assert.equal(await page.locator('[data-tool="exec"]').count(), 1);
    if (load === 0) await page.reload();
  }
  assert.deepEqual(errors, []);
  console.log("PASS: native image + both canvas snapshots render; exec stays generic; identical after reload.");
} finally {
  await browser?.close();
  await server.close();
}
