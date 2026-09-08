/** Opt-in, billable native SDK smoke. Never uses a running Callboard daemon.
 * Run: umask 022; node --import tsx scripts/codex-direct-ui-smoke.ts
 * Requires a local Codex subscription login. All state/auth copies are private
 * and removed at exit. Only allowlisted, synthetic evidence is retained. */
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import { z } from "zod";

async function main() {
  const authHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const scratch = mkdtempSync(join(tmpdir(), "cb-direct-ui-smoke-"));
  const evidence = mkdtempSync(join(tmpdir(), "cb-direct-ui-evidence-"));
  try {
    process.env.CALLBOARD_DATA_DIR = join(scratch, "data");
    process.env.CODEX_HOME = scratch;
    copyFileSync(join(authHome, "auth.json"), join(scratch, "auth.json"));
    writeFileSync(join(scratch, "config.toml"), '[features.code_mode]\nenabled = true\ndirect_only_tool_namespaces = ["existing-user-namespace"]\n');

    // Match backend startup import order for the existing claude/tools cycle.
    await import("../backend/src/services/claude.js");
    const { buildCallboardToolsSpec } = await import("../backend/src/services/callboard-tools.js");
    const { buildCodexToolServer } = await import("../backend/src/agents/adapters/codex/toolAdapter.js");
    const { translateCodexOptions } = await import("../backend/src/agents/adapters/codex/optionsAdapter.js");
    const { resolveCodexExecutionRoute } = await import("../backend/src/services/codex-execution-route.js");
    const { CALLBOARD_UI_TOOLS } = await import("../shared/types/callboard-ui-tools.js");
    const spec = buildCallboardToolsSpec();
    spec.tools = spec.tools.filter((tool) => (CALLBOARD_UI_TOOLS as readonly string[]).includes(tool.name));
    spec.tools.push({
      name: "echo",
      description: "Return a smoke-test marker",
      inputSchema: { value: z.string() },
      handler: async (args) => ({ content: [{ type: "text", text: args.value }] }),
    });
    const calls: Record<string, number> = {};
    let canvasId = "";
    for (const tool of spec.tools) {
      const handler = tool.handler;
      tool.handler = async (args, context) => {
        calls[tool.name] = (calls[tool.name] ?? 0) + 1;
        const result = await handler(args, context);
        if (tool.name === "create_canvas") canvasId = JSON.parse((result.content[0] as { text: string }).text).canvas_id;
        return result;
      };
    }
    const handle = buildCodexToolServer(spec);
    let instructions: string | null = null;
    try {
      const route = await resolveCodexExecutionRoute({ codexHome: scratch }, process.cwd());
      if (!route.directUiNamespaces?.includes("existing-user-namespace")) throw new Error("Native config capability/list probe failed");
      const translated = translateCodexOptions({
        cwd: process.cwd(),
        systemPrompt:
          "You are executing a bounded development tool test. Follow the user's steps exactly. Do not use shell, network, desktop, collaboration, or other tools. No filesystem operations except the requested canvas tools.",
        mcpServers: { "callboard-tools": handle },
        codex: {
          model: "gpt-5.6-sol",
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
          directUiNamespaces: route.directUiNamespaces,
          directUiPolicy: route.directUiPolicy,
          uiAliasPresence: route.uiAliasPresence,
        },
      });
      instructions = translated.instructionsFilePath;
      const client = new Codex(translated.codexOpts);
      const thread = client.startThread(translated.threadOptions);
      const events: ThreadEvent[] = [];
      for await (const event of (
        await thread.runStreamed(
          "Use the native direct render_file tool once for https://example.com/smoke.png with caption Smoke image. Use native direct create_canvas once with name Smoke canvas, content_type html and content <h1>Smoke canvas</h1>. Then invoke functions.exec with this exact code: text(await tools.mcp__callboard_tools__echo({value: 'normal-exec-ok'})); text('CALLBOARD_UI_IN_EXEC=' + ALL_TOOLS.some(({name}) => name.includes('render_file') || name.includes('create_canvas') || name.includes('update_canvas'))); Finish. Never call UI tools via exec.",
          { signal: AbortSignal.timeout(90000) },
        )
      ).events)
        events.push(event);
      if (!canvasId || !thread.id) throw new Error("Initial native calls missing");
      // Actual SDK resume, same handler ownership; no user or production session.
      for await (const event of (
        await client
          .resumeThread(thread.id, translated.threadOptions)
          .runStreamed(`Use native direct update_canvas once for canvas_id ${canvasId} with content <h1>Updated smoke canvas</h1>. Finish.`, {
            signal: AbortSignal.timeout(90000),
          })
      ).events)
        events.push(event);
      for (const name of [...CALLBOARD_UI_TOOLS, "echo"]) if (calls[name] !== 1) throw new Error(`Expected one ${name} handler invocation, got ${calls[name]}`);
      const findRollout = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory() ? findRollout(join(dir, entry.name)) : entry.name.endsWith(".jsonl") ? [join(dir, entry.name)] : [],
        );
      const records = findRollout(join(scratch, "sessions")).flatMap((path) =>
        readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      );
      const payloads = records.filter(
        (record) =>
          record.type === "response_item" &&
          ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(record.payload?.type),
      );
      for (const name of CALLBOARD_UI_TOOLS) {
        if (
          !payloads.some(
            (record) => record.payload.type === "function_call" && record.payload.namespace === "mcp__callboard_ui" && record.payload.name === name,
          )
        )
          throw new Error(`Missing native direct ${name}`);
      }
      if (!payloads.some((record) => record.payload.type === "custom_tool_call" && record.payload.name === "exec")) throw new Error("Ordinary exec missing");
      if (
        !payloads.some(
          (record) =>
            record.payload.type === "custom_tool_call_output" &&
            record.payload.output?.some((block: { text?: string }) => block.text?.includes("CALLBOARD_UI_IN_EXEC=false")),
        )
      )
        throw new Error("UI tools were not proven absent from exec");
      // Retain ONLY tool records from this synthetic run; no session_meta prompt,
      // authentication, source paths, or unrelated messages. Normalize generated IDs.
      const ids = new Map<string, string>();
      const sanitize = (value: unknown): unknown => {
        if (typeof value === "string") {
          if (value === canvasId) return "smoke-canvas";
          return value.replaceAll(canvasId, "smoke-canvas").replaceAll(scratch, "<scratch>").replaceAll(process.cwd(), "<worktree>");
        }
        if (Array.isArray(value)) return value.map(sanitize);
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !["internal_chat_message_metadata_passthrough", "id", "timestamp"].includes(key))
            .map(([key, val]) => {
              if (key === "call_id" && typeof val === "string") {
                if (!ids.has(val)) ids.set(val, `call-${ids.size + 1}`);
                return [key, ids.get(val)];
              }
              return [key, sanitize(val)];
            }),
        );
      };
      writeFileSync(join(evidence, "rollout.jsonl"), payloads.map((record) => JSON.stringify(sanitize(record))).join("\n") + "\n");
      // Keep SDK item IDs: these are stable within this stream, distinct from the
      // rollout's call_ids. Never invent equivalence between the two ID domains.
      const sdk = events.filter((event) => "item" in event && event.item.type === "mcp_tool_call");
      writeFileSync(join(evidence, "sdk.json"), JSON.stringify(sdk, null, 2).replaceAll(canvasId, "smoke-canvas") + "\n");
      console.log(
        JSON.stringify({
          evidence,
          calls,
          config: { directOnlyNamespaces: translated.codexOpts.config?.["features.code_mode.direct_only_tool_namespaces"] },
          resumed: true,
        }),
      );
    } finally {
      await handle.close();
      if (instructions) rmSync(dirname(instructions), { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
