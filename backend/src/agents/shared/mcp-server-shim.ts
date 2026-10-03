/**
 * MCP-stdio shim — the standalone Node entry an MCP-*client* agent (Codex, any
 * ACP agent) spawns to reach a callboard {@link ToolServerSpec}.
 *
 * ## Why a shim exists at all (the design crux)
 *
 * Claude Code and OpenRouter receive callboard's tools **injected in-process**
 * (`createSdkMcpServer`) — the tool handlers run inside the callboard backend
 * process, so they keep full access to live state (the per-chat SSE emitter, the
 * registered `sendMessage`, in-memory job runs, file-backed services). Codex and
 * ACP agents are different: they are MCP *clients*. They do not host tools; they
 * **spawn** the MCP servers named in their config (Codex's `mcp_servers`, ACP's
 * `session/new` `McpServer[]`) and talk to them over stdio.
 *
 * If we let the agent spawn a server that *rebuilt* the spec in the child
 * process, every stateful callboard tool would break — the child has its own
 * empty module state (no SSE emitter, no `sendMessage`, a second backend boot).
 * So instead the **real MCP server runs in the callboard backend process** (see
 * {@link buildSocketToolServer} in `socketToolServer.ts`), bound to a per-spec
 * Unix domain socket, with the live handlers. This shim is the thin stdio
 * frontend the agent actually launches: it does nothing but **relay bytes**
 * between the agent's stdio and that backend socket. The MCP JSON-RPC framing
 * (newline-delimited JSON) is byte-for-byte preserved across the relay, so from
 * the agent's point of view it is talking to a normal stdio MCP server — while
 * the handlers execute in the backend with all their state intact, exactly as
 * they do for Claude/OR.
 *
 * ## Invocation
 *
 * `node mcp-server-shim.js [--label=<name>] <socketPath>` (in production, the
 * compiled `.js`; in dev/tests, `node --import tsx mcp-server-shim.ts …`). The
 * backend computes both the socket path and this spawn command in
 * `socketToolServer.ts`. `--label` only sets the stderr prefix, so a failure in
 * the agent's logs says which provider's shim it was.
 *
 * The backend socket may not be listening at the instant the agent spawns the
 * shim, so the initial connect is retried briefly. The agent's first stdin bytes
 * (the MCP `initialize` request) buffer harmlessly on the paused stdin stream
 * until the pipe is wired, so nothing is lost during the retry window.
 *
 * @see plans/codex-adapter-job.md (Step 6 tool-bridge — "Codex is an MCP client")
 * @see ./socketToolServer.ts (the in-process host this shim relays to)
 */
import net from "node:net";

const CONNECT_RETRY_DELAY_MS = 100;
const CONNECT_MAX_ATTEMPTS = 100; // ~10s of retries — covers backend listen latency

const LABEL_FLAG = "--label=";
const labelArg = process.argv.slice(2).find((a) => a.startsWith(LABEL_FLAG));
const label = labelArg ? labelArg.slice(LABEL_FLAG.length) : "mcp-server-shim";

function fail(message: string, code: number): never {
  process.stderr.write(`${label}: ${message}\n`);
  process.exit(code);
}

function connectWithRetry(socketPath: string, attempt: number): void {
  const sock = net.connect(socketPath);

  sock.once("connect", () => {
    // Bidirectional byte relay: agent stdio ⇄ backend socket. `.pipe` resumes
    // the (paused) stdin stream, flushing any MCP bytes buffered during retries.
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
  });

  sock.on("error", (err: NodeJS.ErrnoException) => {
    // ENOENT/ECONNREFUSED before the backend is listening → retry; anything else
    // (or exhausted retries) is fatal.
    const retriable = err.code === "ENOENT" || err.code === "ECONNREFUSED";
    if (retriable && attempt < CONNECT_MAX_ATTEMPTS) {
      setTimeout(() => connectWithRetry(socketPath, attempt + 1), CONNECT_RETRY_DELAY_MS);
      return;
    }
    fail(`cannot connect to ${socketPath}: ${err.message}`, 1);
  });

  // When the backend closes the socket (turn finished / server torn down) the
  // shim's job is done — exit cleanly so the agent reaps the child.
  sock.once("close", () => process.exit(0));
}

function main(): void {
  const socketPath = process.argv.slice(2).find((a) => !a.startsWith(LABEL_FLAG));
  if (!socketPath) fail("missing required <socketPath> argument", 2);
  connectWithRetry(socketPath, 0);
}

main();
