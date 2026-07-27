/**
 * ACP MCP-stdio shim — the standalone Node entry an ACP agent spawns to reach a
 * callboard {@link ToolServerSpec}.
 *
 * ## Why a shim exists at all
 *
 * Claude Code and OpenRouter receive callboard's tools **injected in-process**,
 * so handlers keep access to live backend state (the per-chat SSE emitter, the
 * registered `sendMessage`, in-memory job runs). ACP agents are MCP *clients*:
 * `session/new` takes an `McpServer[]`, and for the stdio transport the agent
 * **spawns** each server itself.
 *
 * Letting the agent spawn a child that rebuilt the spec would sever every
 * stateful callboard tool from the backend — the child boots its own empty
 * module state. So the real MCP server runs **in the backend process** on a
 * private socket (see {@link buildAcpToolServer}), and this shim is the thin
 * stdio frontend the agent launches: it relays bytes, preserving MCP's
 * newline-delimited JSON framing byte-for-byte. The agent sees an ordinary stdio
 * MCP server; the handlers run in the backend with their state intact.
 *
 * ## Relationship to the Codex shim
 *
 * `adapters/codex/mcp-server-shim.ts` solves the identical problem, because
 * Codex is also an MCP client. This is a near-copy rather than a shared module
 * on purpose: factoring the two together means editing the Codex adapter, which
 * is explicitly out of scope for this change. The duplication is flagged in the
 * Phase 1 report as the right first cleanup once both are settled — it should
 * become one neutral `agents/mcp-bridge/` used by both.
 *
 * ## Invocation
 *
 * `node mcp-server-shim.js <socketPath>` (compiled `.js` in production;
 * `node --import tsx mcp-server-shim.ts <socketPath>` under dev/vitest). Both the
 * socket path and the spawn command are computed by `toolAdapter.ts`.
 *
 * The backend socket may not be listening when the agent spawns the shim, so the
 * first connect is retried. The agent's initial MCP `initialize` bytes buffer on
 * the paused stdin stream until the pipe is wired, so nothing is lost.
 *
 * @see ./toolAdapter.ts (the in-process host this shim relays to)
 */
import net from "node:net";

const CONNECT_RETRY_DELAY_MS = 100;
const CONNECT_MAX_ATTEMPTS = 100; // ~10s — covers backend listen latency

function fail(message: string, code: number): never {
  process.stderr.write(`acp-mcp-server-shim: ${message}\n`);
  process.exit(code);
}

function connectWithRetry(socketPath: string, attempt: number): void {
  const sock = net.connect(socketPath);

  sock.once("connect", () => {
    // Bidirectional byte relay: agent stdio ⇄ backend socket. `.pipe` resumes
    // the paused stdin stream, flushing anything buffered during retries.
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
  });

  sock.on("error", (err: NodeJS.ErrnoException) => {
    const retriable = err.code === "ENOENT" || err.code === "ECONNREFUSED";
    if (retriable && attempt < CONNECT_MAX_ATTEMPTS) {
      setTimeout(() => connectWithRetry(socketPath, attempt + 1), CONNECT_RETRY_DELAY_MS);
      return;
    }
    fail(`cannot connect to ${socketPath}: ${err.message}`, 1);
  });

  // Backend closed the socket (turn over) → the shim's job is done.
  sock.once("close", () => process.exit(0));
}

function main(): void {
  const socketPath = process.argv[2];
  if (!socketPath) fail("missing required <socketPath> argument", 2);
  connectWithRetry(socketPath, 0);
}

main();
