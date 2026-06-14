/**
 * Codex MCP-stdio shim — the standalone Node entry Codex spawns to reach a
 * callboard {@link ToolServerSpec}.
 *
 * ## Why a shim exists at all (the design crux)
 *
 * Claude Code and OpenRouter receive callboard's tools **injected in-process**
 * (`createSdkMcpServer`) — the tool handlers run inside the callboard backend
 * process, so they keep full access to live state (the per-chat SSE emitter, the
 * registered `sendMessage`, in-memory job runs, file-backed services). Codex is
 * different: it is an MCP *client*. It does not host tools; it **spawns** the MCP
 * servers named in its `mcp_servers` config and talks to them over stdio.
 *
 * If we let Codex spawn a server that *rebuilt* the spec in the child process,
 * every stateful callboard tool would break — the child has its own empty module
 * state (no SSE emitter, no `sendMessage`, a second backend boot). So instead the
 * **real MCP server runs in the callboard backend process** (see
 * {@link buildCodexToolServer} in `toolAdapter.ts`), bound to a per-spec Unix
 * domain socket, with the live handlers. This shim is the thin stdio frontend
 * Codex actually launches: it does nothing but **relay bytes** between Codex's
 * stdio and that backend socket. The MCP JSON-RPC framing (newline-delimited
 * JSON) is byte-for-byte preserved across the relay, so from Codex's point of
 * view it is talking to a normal stdio MCP server — while the handlers execute in
 * the backend with all their state intact, exactly as they do for Claude/OR.
 *
 * ## Invocation
 *
 * `node mcp-server-shim.js <socketPath>` (in production, the compiled `.js`; in
 * dev/tests, `node --import tsx mcp-server-shim.ts <socketPath>`). The backend
 * computes both the socket path and this spawn command in `toolAdapter.ts`.
 *
 * The backend socket may not be listening at the instant Codex spawns the shim,
 * so the initial connect is retried briefly. Codex's first stdin bytes (the MCP
 * `initialize` request) buffer harmlessly on the paused stdin stream until the
 * pipe is wired, so nothing is lost during the retry window.
 *
 * @see plans/codex-adapter-job.md (Step 6 tool-bridge — "Codex is an MCP client")
 * @see ./toolAdapter.ts (the in-process host this shim relays to)
 */
import net from "node:net";

const CONNECT_RETRY_DELAY_MS = 100;
const CONNECT_MAX_ATTEMPTS = 100; // ~10s of retries — covers backend listen latency

function fail(message: string, code: number): never {
  process.stderr.write(`mcp-server-shim: ${message}\n`);
  process.exit(code);
}

function connectWithRetry(socketPath: string, attempt: number): void {
  const sock = net.connect(socketPath);

  sock.once("connect", () => {
    // Bidirectional byte relay: Codex stdio ⇄ backend socket. `.pipe` resumes
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
  // shim's job is done — exit cleanly so Codex reaps the child.
  sock.once("close", () => process.exit(0));
}

function main(): void {
  const socketPath = process.argv[2];
  if (!socketPath) fail("missing required <socketPath> argument", 2);
  connectWithRetry(socketPath, 0);
}

main();
