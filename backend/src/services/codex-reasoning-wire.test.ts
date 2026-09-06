import { expect, it, vi } from "vitest";
import { Codex } from "@openai/codex-sdk";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
vi.mock("./agent-settings.js", () => ({ OPENROUTER_CODEX_BASE_URL: "http://127.0.0.1:1" }));
import { translateCodexOptions } from "../agents/adapters/codex/optionsAdapter.js";
it("Codex config passthrough sends actual OpenRouter none/max", async () => {
  const requests: unknown[] = [];
  const home = await mkdtemp(tmpdir() + "/cb-probe-");
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    requests.push(JSON.parse(body).reasoning);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "loopback stop" } }));
  });
  try {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    for (const effort of ["none", "max", undefined]) {
      const translated = translateCodexOptions({
        cwd: home,
        env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home, OPENROUTER_API_KEY: "fake" },
        codex: {
          useOpenRouter: true,
          model: "openai/gpt-5.5",
          reasoningEffort: effort,
          openRouterBaseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        },
      });
      const codex = new Codex(translated.codexOpts);
      try {
        await codex.startThread(translated.threadOptions).run("hello", { signal: AbortSignal.timeout(10000) });
      } catch (e) {
        expect(String(e)).toContain("loopback stop");
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(home, { recursive: true, force: true });
  }
  expect(requests).toMatchObject([{ effort: "none" }, { effort: "max" }, { effort: "medium" }]);
}, 30000);
