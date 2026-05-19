/**
 * Codex SDK validation script.
 *
 * Exploratory only — confirms:
 *   1. @openai/codex-sdk loads and the bundled Rust binary spawns
 *   2. A simple thread streams events end-to-end
 *   3. Actual event/item shapes match the type declarations
 *
 * Run:
 *   npx tsx scripts/codex-validate.ts
 *
 * Uses ~/.codex/auth.json automatically when no apiKey is provided.
 * Will be deleted (or moved into a real test) once Phase 1 lands.
 */

import { Codex } from "@openai/codex-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Reasoning-heavy prompt to try to trigger reasoning items + item.updated streaming.
const PROMPT =
  process.argv[2] ??
  [
    "Carefully reason through these in detail before answering:",
    "Step 1: List 3 distinct edge cases for parsing JSONL files.",
    "Step 2: For each, write a 2-sentence explanation in a long, deliberate paragraph.",
    "Step 3: Conclude with 'codex sdk validation ok'.",
  ].join("\n");

async function main() {
  console.log("=== codex-sdk validation ===");
  console.log("cwd:", process.cwd());
  console.log("prompt:", JSON.stringify(PROMPT));

  const codex = new Codex({
    // No apiKey → SDK falls back to ~/.codex/auth.json
  });

  // Use a writable scratch dir so workspace-write/read-only sandbox don't matter.
  const scratch = path.join(os.tmpdir(), "codex-validate-scratch");
  fs.mkdirSync(scratch, { recursive: true });
  console.log("scratch:", scratch);

  const thread = codex.startThread({
    skipGitRepoCheck: true,
    workingDirectory: scratch,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
  });

  console.log("thread.id (pre-run):", thread.id);

  const started = Date.now();
  let eventCount = 0;
  const itemTypesSeen = new Set<string>();
  const eventTypesSeen = new Set<string>();

  try {
    const { events } = await thread.runStreamed(PROMPT);

    for await (const evt of events) {
      eventCount += 1;
      eventTypesSeen.add(evt.type);
      if ("item" in evt && evt.item && typeof evt.item === "object") {
        const itemType = (evt.item as { type?: string }).type;
        if (itemType) itemTypesSeen.add(itemType);
      }

      // Print compact line + full JSON for shape inspection.
      console.log(`\n[#${eventCount}] type=${evt.type}`);
      console.log(JSON.stringify(evt, null, 2));
    }
  } catch (err) {
    console.error("\n!!! stream threw:", err);
    process.exitCode = 1;
  }

  console.log("\n=== summary ===");
  console.log("thread.id (post-run):", thread.id);
  console.log("events:", eventCount);
  console.log("event.type values seen:", [...eventTypesSeen].sort());
  console.log("item.type values seen:", [...itemTypesSeen].sort());
  console.log("duration:", Date.now() - started, "ms");
}

main().catch((err) => {
  console.error("validation script failed:", err);
  process.exit(1);
});
