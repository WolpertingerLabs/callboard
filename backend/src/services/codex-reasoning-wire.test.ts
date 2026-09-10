import { expect, it, vi } from "vitest";
import { Codex } from "@openai/codex-sdk";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
vi.mock("./agent-settings.js", () => ({ OPENROUTER_CODEX_BASE_URL: "http://127.0.0.1:1" }));
import { translateCodexOptions } from "../agents/adapters/codex/optionsAdapter.js";

// Codex's managed sandbox explicitly denies loopback listeners. Keep this as a
// real wire test everywhere sockets are available; skip only in that declared
// environment rather than turning an expected EPERM into an unhandled error.
it.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1")(
  "Codex config passthrough sends actual OpenRouter none/max",
  async () => {
    const requests: unknown[] = [];
    const home = await mkdtemp(tmpdir() + "/cb-probe-");
    const server = createServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [] }));
        return;
      }
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
      // Cleared native effort retains configured effort, NOT the catalog default.
      await writeFile(home + "/config.toml", 'model_reasoning_effort = "low"\n');
      const translated = translateCodexOptions({
        cwd: home,
        env: { PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: home },
        codex: { authMode: "api-key", apiKey: "fake", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: "gpt-6-astra" },
      });
      try {
        await new Codex(translated.codexOpts).startThread(translated.threadOptions).run("hello", { signal: AbortSignal.timeout(10000) });
      } catch (e) {
        expect(String(e)).toContain("loopback stop");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      // `home` is this run's CODEX_HOME, and the Codex binary keeps writing
      // into it (`.tmp/plugins-clone-*/`) for a moment after the aborted run
      // returns. A plain recursive rm races that and throws ENOTEMPTY from
      // inside this `finally`, which fails the test — a pure flake, on the
      // suite that gates `prepublishOnly`. `force` does not cover ENOTEMPTY;
      // only the retries do.
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    expect(requests).toMatchObject([{ effort: "none" }, { effort: "max" }, { effort: "medium" }, { effort: "low" }]);
  },
  30000,
);
