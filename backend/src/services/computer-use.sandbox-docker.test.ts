/**
 * The Sandbox desktop target against a real container, through Callboard's own
 * wiring: `sandboxDesktopDriver` reading CALLBOARD_SANDBOX_DESKTOP_URL and
 * _TOKEN_FILE, the host's `sandbox-desktop` target and `sandboxControl` policy.
 * Needs Docker:
 *
 *   CALLBOARD_DOCKER_TESTS=1 npx vitest run backend/src/services/computer-use.sandbox-docker.test.ts
 *
 * Builds packages/computer-use/docker/Dockerfile under a per-run tag (with
 * `sandboxImageBuildArgs`, so it carries the content label) — never the
 * production callboard/computer-use-desktop:local — runs it with
 * `sandboxRunArgs` (the hardened flags) on a random loopback port, on a
 * private network, under a unique name, and removes the container, the
 * network, the token file and that tag whatever happens. Set
 * CALLBOARD_DOCKER_IMAGE to test an existing image instead (left in place).
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import * as pkg from "@wolpertingerlabs/computer-use";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
import { ComputerUseHost, controlPrincipal, sandboxDesktopDriver, type RaiseHumanApproval } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";

const enabled = process.env.CALLBOARD_DOCKER_TESTS === "1";
const packageDir = join(dirname(fileURLToPath(import.meta.url)), "../../../packages/computer-use");
const suffix = randomUUID().slice(0, 8);
const reuse = process.env.CALLBOARD_DOCKER_IMAGE?.trim();
const image = reuse || `callboard/computer-use-desktop:backend-test-${suffix}`;
const name = `callboard-cu-backend-test-${suffix}`;
// Its own network, never the shared `callboard-sandbox` another chat's sandbox may be on.
const network = `callboard-sandbox-backend-test-${suffix}`;
let networkCreated = false;

function docker(args: string[], timeout = 600_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
    );
  });
}

let tokenDir: string | undefined;
let env: NodeJS.ProcessEnv = {};
let host: ComputerUseHost | undefined;

beforeAll(async () => {
  if (!enabled) return;
  if (!reuse) {
    const [, ...args] = pkg.sandboxImageBuildArgs({ context: packageDir, image });
    await docker(["build", "-q", ...args]);
  }
  tokenDir = await mkdtemp(join(tmpdir(), "callboard-cu-backend-test-"));
  await chmod(tokenDir, 0o700);
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(tokenDir, "token");
  await writeFile(tokenFile, `${token}\n`, { mode: 0o444 });
  await pkg.ensureSandboxNetwork({ name: network });
  networkCreated = true;
  await docker(pkg.sandboxRunArgs({ port: 0, tokenFile, image, name, network, labels: { "dev.callboard.test": "backend-sandbox-target" } }));
  const url = `http://${(await docker(["port", name, "7801/tcp"])).trim().split("\n")[0]}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    // The probe runs the handshake (POST /hello and its host proof).
    if ((await pkg.createRemoteDriver({ url, tokenFile }).probe()).available) break;
    if (Date.now() > deadline) throw new Error(`sandbox driver host did not come up: ${await docker(["logs", name]).catch(() => "")}`);
    await delay(250);
  }
  env = { CALLBOARD_SANDBOX_DESKTOP_URL: url, CALLBOARD_SANDBOX_DESKTOP_TOKEN_FILE: tokenFile };
}, 900_000);

afterAll(async () => {
  await host?.dispose();
  if (!enabled) return;
  // The container goes before its network.
  await docker(["rm", "-f", name]).catch(() => {});
  if (networkCreated) await docker(["network", "rm", network]).catch(() => {});
  if (tokenDir) await rm(tokenDir, { recursive: true, force: true });
  if (!reuse) await docker(["image", "rm", image]).catch(() => {});
}, 60_000);

it.skipIf(!enabled)(
  "opens, observes and acts on the sandbox target under sandboxControl alone",
  async () => {
    const sandbox = sandboxDesktopDriver(pkg, env);
    expect(sandbox).toHaveProperty("endpoint");
    // The other two targets are never reached: their axes are denied.
    const unused: Driver = {
      kind: "browser",
      probe: async () => ({ kind: "browser", available: false, capabilities: [] }),
      open: async () => {
        throw new Error("not used");
      },
    };
    const desktop: Driver = { ...unused, kind: "native-desktop", lockDomain: "backend-sandbox-test:desktop" };
    const service = new ComputerUseService({
      targets: [
        { id: "managed-browser", enabled: true, driver: unused },
        { id: "native-desktop", enabled: true, driver: desktop },
        { id: "sandbox-desktop", enabled: true, driver: sandbox },
      ],
      authorize: (request) => host!.authorize(request),
    });
    // Stands in for the human's in-chat card; nothing else can answer it.
    let answer: ((approved: boolean) => unknown) | undefined;
    const raise: RaiseHumanApproval = (_chatId, _request, onAnswer) => {
      answer = onAnswer;
      return { requestId: "card", isOpen: () => answer !== undefined, cancel: () => false };
    };
    const notices: string[] = [];
    host = new ComputerUseHost(
      service,
      { browser: unused, desktop, sandbox },
      () => ({ policy: readComputerUsePolicy({ sandboxControl: "allow" }), signature: "sandbox-only" }),
      raise,
      (_chatId, text) => notices.push(text),
    );

    const status = await host.status("chat");
    expect(status.capabilities.find((c) => c.kind === "sandbox")).toMatchObject({ available: true, permission: "allow" });
    expect(status.permission).toBe("allow");

    const session = (await host.open("chat", "sandbox")) as { id: string; generation: number; kind: string; targetLabel: string };
    expect(session).toMatchObject({ kind: "sandbox", targetLabel: expect.stringMatching(/^sandbox 127\.0\.0\.1:\d+$/) });

    const frame = await service.observe(controlPrincipal("chat", "agent"), { sessionId: session.id, generation: session.generation });
    expect(frame.frame).toMatchObject({ mimeType: "image/png", width: expect.any(Number), height: expect.any(Number) });
    expect(frame.frame.width).toBeGreaterThan(0);

    await expect(
      host.requestAgentAction("chat", session.id, session.generation, frame.frameId, { type: "click", x: 10, y: 10 }, async (actionId, action) =>
        service.act(controlPrincipal("chat", "agent"), {
          ...host!.agentLease("chat", session.id, session.generation),
          frameId: frame.frameId,
          actionId,
          action: action as never,
        }),
      ),
    ).resolves.toBeDefined();

    await host.stop("chat", session.id);
    expect((await host.status("chat")).sessions.find((s) => s.id === session.id)?.state).not.toBe("ready");

    // The agent's path: consent asked about this container instance, and the
    // session that opened is checked against it (openedInstance), not re-asked.
    await expect(host.requestControl("chat", "sandbox", "Open a downloaded file", new AbortController().signal)).resolves.toMatchObject({
      status: "consent_pending",
      kind: "sandbox",
    });
    await expect(Promise.resolve(answer!(true))).resolves.toEqual({ ok: true });
    expect(notices.at(-1)).toMatch(/sandbox desktop control enabled/);
    const enabled = (await host.status("chat")).sessions.find((s) => s.kind === "sandbox" && s.state === "ready");
    expect(enabled).toBeDefined();
    await host.stop("chat", enabled!.id);
  },
  300_000,
);
