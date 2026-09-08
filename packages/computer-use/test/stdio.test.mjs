import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
async function withClient(args, fn) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, ...args], stderr: "pipe" });
  const client = new Client({ name: "stdio-test", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (b) => (stderr += b));
  try {
    await client.connect(transport);
    await fn(client);
    assert.equal(stderr, "");
  } finally {
    await client.close();
  }
}
const code = (result) => JSON.parse(result.content[0].text).error;

test("standalone stdio discovery: no config means no targets", async () => {
  await withClient([], async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    const result = await client.callTool({ name: "computer_open", arguments: { targetId: "personal-desktop" } });
    assert.equal(result.isError, true);
    assert.equal(code(result), "not_found");
  });
});

test("standalone stdio fails closed: an enabled target with no authorizer denies open and never opens the driver", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "computer-use-stdio-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, "config.mjs");
  // A trusted operator config with a real target but the default (absent) authorizer.
  // The driver records any open into a file so the test can prove it never launched.
  await writeFile(
    config,
    `import { writeFile } from "node:fs/promises";
     export const options = {
       targets: [{ id: "fake-browser", enabled: true, driver: {
         kind: "browser",
         probe: async () => ({ available: true, kind: "browser", capabilities: [] }),
         open: async () => { await writeFile(${JSON.stringify(join(dir, "opened"))}, "opened"); return { observe: async () => { throw new Error("never"); }, act: async () => {}, releaseInput: async () => {}, close: async () => {} }; },
       } }],
     };`,
  );
  await withClient(["--config", config], async (client) => {
    const probe = await client.callTool({ name: "computer_probe", arguments: { targetId: "fake-browser" } });
    assert.equal(probe.isError, true);
    assert.equal(code(probe), "denied");
    const opened = await client.callTool({ name: "computer_open", arguments: { targetId: "fake-browser" } });
    assert.equal(opened.isError, true);
    assert.equal(code(opened), "denied");
    assert.deepEqual(await client.callTool({ name: "computer_status", arguments: {} }).then((r) => JSON.parse(r.content[0].text)), []);
  });
  await assert.rejects(import("node:fs/promises").then(({ access }) => access(join(dir, "opened"))), { code: "ENOENT" });
});
