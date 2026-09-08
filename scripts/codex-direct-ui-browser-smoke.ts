/** Offline headless integration: captured native transcript -> real renderers.
 * No production config, server, desktop grant, or external network is used.
 * Run: node --import tsx scripts/codex-direct-ui-browser-smoke.ts */
import { createServer } from "vite";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { parseCodexRollout } from "../backend/src/agents/adapters/codex/sessionParser.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = fileURLToPath(new URL("../frontend", import.meta.url));
const fixture = fileURLToPath(new URL("../backend/src/agents/adapters/codex/__fixtures__/direct-ui-rollout.jsonl", import.meta.url));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=", "base64");
// Transform raw captured records, then run the real parser for every scenario.
// No hand-built ParsedMessages or test-only pairing implementation.
const scratch = mkdtempSync(join(tmpdir(), "callboard-ui-pairing-"));
const records = readFileSync(fixture, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const clonePair = (id: string) =>
  records.slice(0, 2).map((record) => ({
    ...record,
    payload: { ...record.payload, call_id: id },
  }));
const failed = clonePair("failed");
const imagePayload = JSON.parse(records[1].payload.output[1].text);
failed[1].payload.output = JSON.stringify({ ...imagePayload, isError: true });
const execJson = clonePair("exec-json");
execJson[0].payload.name = "exec";
delete execJson[0].payload.namespace;
execJson[1].payload.output = JSON.stringify(imagePayload);
const duplicateCalls = clonePair("duplicate-call");
const duplicateResults = clonePair("duplicate-result");
const reused = clonePair("reused");
const changedCall = (record: (typeof records)[number]) => ({
  ...record,
  payload: { ...record.payload, arguments: JSON.stringify({ url: "https://example.com/other.png" }) },
});
const changedResult = (record: (typeof records)[number]) => JSON.parse(JSON.stringify(record).replaceAll("Smoke image", "Other image"));
const extras = [
  ...failed,
  ...execJson,
  duplicateCalls[0],
  changedCall(duplicateCalls[0]),
  duplicateCalls[1],
  duplicateResults[0],
  duplicateResults[1],
  changedResult(duplicateResults[1]),
  ...reused,
  changedCall(reused[0]),
  changedResult(reused[1]),
  // Exact replay records are deduplicated by the real parser, not pairing.
  ...records,
];
const calls = records.filter((r) => !r.payload.type.endsWith("_output"));
const results = records.filter((r) => r.payload.type.endsWith("_output"));
const gap = Array.from({ length: 24 }, (_, i) => ({
  type: "response_item",
  payload: { type: "message", role: i % 2 ? "user" : "assistant", content: [{ type: i % 2 ? "input_text" : "output_text", text: "intervening " + i }] },
}));
const scenarios = {
  ordinary: [...records, ...extras],
  distant: [...calls, ...gap, ...results.slice().reverse(), ...extras],
  reversed: [...results, ...gap, ...calls, ...extras],
  uppercase: [...records, ...extras].map((r) => JSON.parse(JSON.stringify(r).replaceAll("https://example.com", "HTTPS://example.com"))),
};
for (const [name, rows] of Object.entries(scenarios)) {
  writeFileSync(join(scratch, name + ".jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
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
          if (req.url?.split("?")[0] === "/smoke") {
            res.setHeader("Content-Type", "text/html");
            res.end('<div id="root"></div><script type="module" src="/smoke.tsx"></script>');
          } else if (req.url?.startsWith("/messages?")) {
            const scenario = new URL(req.url, "http://localhost").searchParams.get("scenario") ?? "ordinary";
            if (!(scenario in scenarios)) {
              res.statusCode = 404;
              res.end();
              return;
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(parseCodexRollout(join(scratch, scenario + ".jsonl"))));
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
      import { groupToolMessages } from '/src/utils/toolGrouping.ts';
      const messages = await (await fetch('/messages' + location.search)).json();
      const items = groupToolMessages(messages);
      window.smokeItems = items;
      createRoot(document.getElementById('root')).render(<main>{items.map((item,i)=>item.kind === 'tool_group'
        ? <section key={i} data-tool={item.toolUse.toolName} data-call={item.toolUse.toolUseId}><ToolCallBubble toolUse={item.toolUse} toolResult={item.toolResult} isRunning={false}/></section>
        : <pre key={i} data-orphan={item.message.type === 'tool_result' ? item.message.toolUseId : undefined}>{item.message.content}</pre>)}</main>);

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
  await page.route("**/*", (route) => (new URL(route.request().url()).origin === base ? route.continue() : route.abort()));
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  for (const scenario of Object.keys(scenarios)) {
    await page.goto(`${base}/smoke?scenario=${scenario}`);
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
      assert.equal(await page.locator('[data-tool="exec"]').count(), 2);
      assert.equal(await page.locator("img").count(), 1);
      assert.equal(await page.locator("iframe").count(), 2);
      assert.equal(await page.locator('[data-call="failed"] img, [data-call="failed"] iframe').count(), 0);
      assert.equal(await page.locator('[data-call="failed"]').count(), 1);
      for (const id of ["duplicate-call", "duplicate-result", "reused"]) {
        assert.equal(await page.locator(`[data-call="${id}"]`).count(), id === "duplicate-result" ? 1 : 2);
        assert.equal(await page.locator(`[data-call="${id}"] img, [data-call="${id}"] iframe`).count(), 0);
        assert.equal(await page.locator(`[data-orphan="${id}"]`).count(), id === "duplicate-call" ? 1 : 2);
      }
      const pairing = await page.evaluate(() => {
        const items = (window as unknown as { smokeItems: import("../frontend/src/utils/toolGrouping.js").DisplayItem[] }).smokeItems;
        return items.filter((i) => i.kind === "tool_group").map((i) => ({ id: i.toolUse.toolUseId, indices: i.originalIndices }));
      });
      for (const id of ["call-1", "call-2", "call-3", "call-4"]) {
        const pair = pairing.find((p) => p.id === id)!;
        assert.notEqual(pair.indices[1], null);
        if (scenario === "distant") assert(pair.indices[1]! - pair.indices[0] > 9);
        if (scenario === "reversed") assert(pair.indices[1]! < pair.indices[0]);
      }
      if (load === 0) await page.reload();
    }
    // eslint-disable-next-line no-console -- standalone smoke result
    console.log(`PASS: ${scenario}: image + both canvases, generic exec/error, ambiguous orphans; initial load + reload.`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  await server.close();
  rmSync(scratch, { recursive: true, force: true });
}
