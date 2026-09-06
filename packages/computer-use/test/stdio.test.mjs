import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("standalone stdio discovery and fail-closed default config", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../dist/cli.js", import.meta.url))], stderr: "pipe" });
  const client = new Client({ name: "stdio-test", version: "1" });
  let stderr = "";
  transport.stderr?.on("data", (b) => (stderr += b));
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 7);
    const result = await client.callTool({ name: "computer_open", arguments: { targetId: "personal-desktop" } });
    assert.equal(result.isError, true);
    assert.equal(stderr, "");
  } finally {
    await client.close();
  }
});
