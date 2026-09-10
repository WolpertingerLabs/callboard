/* global document, window */
/**
 * Disposable real-browser regression for the sidebar selection bar's height.
 * No backend, no target, no user browser. Run after npm ci:
 *   node scripts/test-selection-bar-clearance.mjs
 *
 * Why a browser and not vitest: jsdom measures nothing — every `offsetHeight`
 * is 0 — so a jsdom test can only ever assert the clearance constant against
 * itself, which is how a 76px constant shipped under a bar that is 84px at the
 * minimum sidebar width. The bar's height is a function of the sidebar's width
 * and of what the labels say: the desktop row is `flexWrap: nowrap`, so a
 * narrow column makes each LABEL wrap inside its own button rather than moving
 * a button to a second line.
 *
 * `ChatList` measures the bar at runtime (SelectionBar's `onMeasure` →
 * ResizeObserver), so the number this file guards is the FALLBACK the list
 * pads by until that measurement lands — the one value a browser cannot
 * correct for us. It also prints the real heights, which is where the numbers
 * quoted in ChatList.tsx come from.
 *
 * Same shape as scripts/test-expanded-watch.mjs: vite serves a throwaway entry
 * that mounts the real component with the real stylesheet.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../frontend");

/** The fallback, read out of ChatList.tsx so this cannot drift from the source. */
const source = await readFile(path.join(root, "src/pages/ChatList.tsx"), "utf8");
const fallback = Number(/const SELECTION_BAR_FALLBACK_CLEARANCE = (\d+)/.exec(source)?.[1]);
assert.ok(Number.isFinite(fallback), "could not read SELECTION_BAR_FALLBACK_CLEARANCE out of ChatList.tsx");

/**
 * The widths that matter. 350 is SIDEBAR_MIN_WIDTH (SplitLayout), 360 the
 * default, 390 a common phone (where the list is the whole screen), 320 the
 * narrowest phone still worth supporting.
 */
const WIDTHS = [320, 350, 360, 390, 520];

/**
 * The worst case the chat list can put in the bar: the archive verb with the
 * longer of its two words, a delete, and the mobile "Select all" — which is
 * the extra control that also forces `flexWrap: wrap`.
 */
const CASES = [
  { name: "desktop, archived scope", selectAll: false, actions: ["Unarchive 12 cards", "Delete 40 chats"] },
  { name: "mobile, archived scope", selectAll: true, actions: ["Unarchive 12 cards", "Delete 40 chats"] },
];

const dir = await mkdtemp(path.join(root, ".selection-bar-smoke-"));
let server, browser;
try {
  await writeFile(path.join(dir, "index.html"), '<div id="root"></div><script type="module" src="./main.tsx"></script>');
  await writeFile(
    path.join(dir, "main.tsx"),
    `
import React from "react";
import { createRoot } from "react-dom/client";
import SelectionBar from "../src/components/SelectionBar";
import "../src/index.css";
const params = new URLSearchParams(location.search);
const actions = JSON.parse(params.get("actions"));
const selectAll = params.get("selectAll") === "1";
window.measured = null;
// The sidebar column, as SplitLayout builds it: a fixed-width flex column with
// the list root (position: relative) inside it. The bar is absolute against
// that root, so the column's width is what makes its labels wrap.
function App() {
  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      <div style={{ width: "100%", flexShrink: 0, display: "flex", flexDirection: "column", background: "var(--bg-sidebar)" }}>
        <div style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column" }}>
          <div style={{ flex: 1, overflow: "auto" }} />
          <SelectionBar
            position="absolute"
            count={40}
            noun="chats selected"
            onSelectAll={selectAll ? () => {} : undefined}
            actions={actions.map((label, i) => ({ key: String(i), label, onRun: () => {}, danger: i > 0 }))}
            onCancel={() => {}}
            onMeasure={(h) => { window.measured = h; }}
          />
        </div>
      </div>
    </div>
  );
}
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

  for (const testCase of CASES) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`${url}?selectAll=${testCase.selectAll ? 1 : 0}&actions=${encodeURIComponent(JSON.stringify(testCase.actions))}`);
      await page.getByText("40 chats selected").waitFor();
      const { height, reported } = await page.evaluate(() => {
        const bar = document.querySelector('[aria-live="polite"]').parentElement;
        return { height: bar.offsetHeight, reported: window.measured };
      });
      console.log(`${String(width).padStart(4)}px  ${testCase.name.padEnd(26)} bar=${String(height).padStart(3)}px  reported=${reported}`);

      // 1. The bar tells the list its real height, so the list's padding
      //    follows the wrap instead of a constant.
      assert.equal(reported, height, `onMeasure reported ${reported} for a ${height}px bar at ${width}px (${testCase.name})`);
      // 2. And the fallback the list uses until that arrives is big enough
      //    that even the un-measured first paint does not cover the last row.
      assert.ok(
        height <= fallback,
        `bar is ${height}px at ${width}px (${testCase.name}) but SELECTION_BAR_FALLBACK_CLEARANCE is ${fallback}px — the last row would be covered`,
      );
    }
  }
  assert.deepEqual(errors, [], `page errors: ${errors.join("; ")}`);
  console.log(`\nOK — every bar fits within the ${fallback}px fallback clearance, and reports its own height.`);
} finally {
  await browser?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
}
