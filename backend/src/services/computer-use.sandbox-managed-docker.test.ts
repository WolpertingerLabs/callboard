/**
 * Managed Sandbox desktops against real Docker, through Callboard's own
 * wiring: the host enables the sandbox target, the manager starts a labelled
 * container on the sandbox network, the agent acts on it, Stop removes it and
 * its token, a crashed daemon's leftovers are reaped by the next one, and a
 * container with another owner's label survives every reap. Also: the `none`
 * network (an `--internal` network, no published port, no internet). Needs
 * Docker and a built packages/computer-use/dist:
 *
 *   CALLBOARD_DOCKER_TESTS=1 npx vitest run backend/src/services/computer-use.sandbox-managed-docker.test.ts
 *
 * Builds the image from the shipped Docker context (dist/ + docker/, exactly
 * what `callboard sandbox build` does) under a unique tag, and removes that
 * tag, its containers, networks and data directory afterwards. Set
 * CALLBOARD_DOCKER_MANAGED_IMAGE to reuse an image instead (left in place).
 * Everything it creates carries a per-run name or owner, so it never touches
 * another chat's sandboxes, networks or the shared `:local` image.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerUseService, sandboxRunArgs, type Driver } from "@wolpertingerlabs/computer-use";
import { ComputerUseHost, controlPrincipal, sandboxTargetDriver, type HostPolicy } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { MANAGED_LABEL, OWNER_LABEL, SESSION_LABEL, CHAT_LABEL, SandboxContainerManager, managedSandboxDriver } from "./sandbox-containers.js";
import { resolveSandboxSettings, type ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import { SANDBOX_CONTENT_LABEL, buildSandboxImage, execDocker, sandboxContentDigest } from "./sandbox-image.js";

const enabled = process.env.CALLBOARD_DOCKER_TESTS === "1";
const suffix = randomUUID().slice(0, 8);
const reuse = process.env.CALLBOARD_DOCKER_MANAGED_IMAGE?.trim();
const image = reuse || `callboard/computer-use-desktop:managed-test-${suffix}`;
const networks = { internet: `callboard-sandbox-mtest-${suffix}`, none: `callboard-sandbox-mtest-${suffix}-int` };
const foreignOwner = "f0f0f0f0f0f0f0f0";
const foreignName = `callboard-mtest-foreign-${suffix}`;

function docker(args: string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("docker", args, { encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
    ),
  );
}
const log = (...parts: unknown[]) => console.log("[managed-docker]", ...parts);

let dataDir = "";
let settings: ResolvedSandboxSettings;
const managers: SandboxContainerManager[] = [];
const hosts: ComputerUseHost[] = [];
const owners = new Set<string>();

function wire() {
  const manager = new SandboxContainerManager({ docker: execDocker(), dataDir, settings: () => settings, image, networks });
  managers.push(manager);
  owners.add(manager.owner);
  const none: Driver = {
    kind: "browser",
    probe: async () => ({ available: false, kind: "browser", capabilities: [] }),
    open: async () => {
      throw new Error("unused");
    },
  };
  const desktop: Driver = { ...none, kind: "native-desktop", lockDomain: `mtest-desktop-${suffix}` };
  const sandbox = sandboxTargetDriver({
    mode: () => "managed",
    managed: managedSandboxDriver(manager),
    endpoint: { ...desktop, lockDomain: `mtest-endpoint-${suffix}` },
    containerState: (sessionId) => manager.containerState(sessionId),
  });
  const policy: HostPolicy = { policy: readComputerUsePolicy({ browserControl: "deny", computerControl: "deny", sandboxControl: "allow" }), signature: "s" };
  const service = new ComputerUseService({
    targets: [
      { id: "managed-browser", enabled: true, driver: none },
      { id: "native-desktop", enabled: true, driver: desktop },
      { id: "sandbox-desktop", enabled: true, driver: sandbox },
    ],
    authorize: (request) => host.authorize(request),
  });
  const host: ComputerUseHost = new ComputerUseHost(
    service,
    { browser: none, desktop, sandbox },
    () => policy,
    () => {
      throw new Error("no prompts in this test");
    },
    () => {},
  );
  hosts.push(host);
  return { manager, service, host };
}

const mine = async (owner: string) =>
  (await docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `label=${MANAGED_LABEL}=1`, "--filter", `label=${OWNER_LABEL}=${owner}`]))
    .split("\n")
    .filter(Boolean);
async function until(check: () => Promise<boolean>, what: string, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(200);
  }
}

beforeAll(async () => {
  if (!enabled) return;
  dataDir = await mkdtemp(join(tmpdir(), "callboard-managed-docker-"));
  settings = { ...resolveSandboxSettings({}), maxConcurrent: 2 };
  if (!reuse) {
    log(`building ${image} from the shipped context`);
    const started = Date.now();
    await buildSandboxImage({ image });
    log(`built in ${Math.round((Date.now() - started) / 1000)}s`);
  }
}, 900_000);

afterAll(async () => {
  if (!enabled) return;
  await Promise.all(hosts.map((host) => host.dispose().catch(() => {})));
  await Promise.all(managers.map((manager) => manager.dispose().catch(() => {})));
  for (const owner of [...owners, foreignOwner]) for (const id of await mine(owner).catch(() => [])) await docker(["rm", "--force", id]).catch(() => {});
  await docker(["rm", "--force", foreignName]).catch(() => {});
  for (const name of Object.values(networks)) await docker(["network", "rm", name]).catch(() => {});
  if (!reuse) await docker(["image", "rm", image]).catch(() => {});
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}, 120_000);

it.skipIf(!enabled)(
  "enable → labelled container on the sandbox network → act → stop removes container and token → reaper after a crash → another owner survives",
  async () => {
    const chatId = `chat-${suffix}`;
    const { manager, service, host } = wire();

    // 0. The image carries the digest of what it was built from, so it reads as current.
    const [imageInfo] = JSON.parse(await docker(["image", "inspect", image]));
    expect(imageInfo.Config.Labels[SANDBOX_CONTENT_LABEL]).toBe(reuse ? imageInfo.Config.Labels[SANDBOX_CONTENT_LABEL] : sandboxContentDigest());
    if (!reuse) expect((await manager.diagnostics()).image).toMatchObject({ present: true, compatible: true, current: true });

    // 1. Enable the sandbox target (the human's Enable click, under Allow).
    let started = Date.now();
    const opened = (await host.open(chatId, "sandbox")) as { id: string; generation: number; state: string };
    log(`enabled in ${Date.now() - started}ms: session ${opened.id} ${opened.state}`);
    expect(opened.state).toBe("ready");

    // 2. One container, with our labels, on the sandbox network, loopback-published, hardened.
    const ids = await mine(manager.owner);
    expect(ids).toHaveLength(1);
    const [info] = JSON.parse(await docker(["inspect", ids[0]]));
    expect(info.Config.Labels).toMatchObject({ [MANAGED_LABEL]: "1", [OWNER_LABEL]: manager.owner, [CHAT_LABEL]: chatId, [SESSION_LABEL]: opened.id });
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([networks.internet]);
    // Requested as 127.0.0.1::7801 (Docker picks the port), and published on loopback only.
    expect(info.HostConfig.PortBindings["7801/tcp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: "" }]);
    expect(info.NetworkSettings.Ports["7801/tcp"]).toEqual([{ HostIp: "127.0.0.1", HostPort: expect.stringMatching(/^\d+$/) }]);
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
    expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(JSON.stringify(info.Config.Env)).not.toMatch(/TOKEN=/);
    const [network] = JSON.parse(await docker(["network", "inspect", networks.internet]));
    expect(network.Options["com.docker.network.bridge.enable_icc"]).toBe("false");
    const tokenDir = join(manager.sessionsDir, opened.id);
    expect(existsSync(join(tokenDir, "token"))).toBe(true);
    log(`container ${ids[0].slice(0, 12)} labelled, on ${networks.internet}, port 127.0.0.1:${info.NetworkSettings.Ports["7801/tcp"][0].HostPort}`);

    // 3. Act, as the agent does: observe, type, observe a changed frame.
    const agent = controlPrincipal(chatId, "agent");
    const first = await service.observe(agent, { sessionId: opened.id, generation: opened.generation });
    expect([first.frame.width, first.frame.height]).toEqual([1280, 800]);
    const act = async (action: Record<string, unknown>) => {
      const frame = await service.observe(agent, { sessionId: opened.id, generation: opened.generation });
      const lease = host.agentLease(chatId, opened.id, opened.generation);
      await host.requestAgentAction(chatId, opened.id, opened.generation, frame.frameId, action, (actionId, approved) =>
        service.act(agent, { ...lease, frameId: frame.frameId, actionId, action: approved as never }),
      );
    };
    await act({ type: "type", text: "echo managed-sandbox-ok" });
    await act({ type: "key", key: "Enter" });
    await delay(500);
    const after = await service.observe(agent, { sessionId: opened.id, generation: opened.generation });
    expect(after.frame.data).not.toBe(first.frame.data);
    log("observed, typed and pressed Enter; the frame changed");

    // 4. Stop: the drain hook runs first, against the still-running container
    // (what PR 4's outbox sync needs: list, then get by digest), and then the
    // container and its token file are gone.
    const payload = "drained before destroy\n";
    await docker([
      "exec",
      "-u",
      "desktop",
      ids[0],
      "sh",
      "-c",
      `mkdir -p /home/desktop/outbox && printf '%s' '${payload.trim()}' > /home/desktop/outbox/.r.part && mv /home/desktop/outbox/.r.part /home/desktop/outbox/result.txt`,
    ]);
    await delay(1_200); // past the host's settle window, so the listing carries a digest
    const drained: { chatId: string; instanceId: string; names: string[]; body?: string; stillRunning: boolean }[] = [];
    manager.drainBeforeDestroy = async (sandbox, signal) => {
      const entries = await sandbox.driver.listOutbox(signal);
      const entry = entries.find((e) => e.name === "result.txt");
      const file = entry?.sha256 ? await sandbox.driver.downloadOutboxFile(entry.name, signal, { expectedSha256: entry.sha256 }) : undefined;
      drained.push({
        chatId: sandbox.chatId,
        instanceId: sandbox.instanceId,
        names: entries.map((e) => e.name),
        body: file?.data.toString("utf8"),
        stillRunning: (await mine(manager.owner)).length === 1,
      });
    };
    started = Date.now();
    await host.stop(chatId, opened.id);
    await until(async () => (await mine(manager.owner)).length === 0 && !existsSync(tokenDir), "container and token removal");
    expect(drained).toEqual([{ chatId, instanceId: expect.any(String), names: ["result.txt"], body: payload.trim(), stillRunning: true }]);
    manager.drainBeforeDestroy = async () => {};
    log(`stopped; drain listed and fetched result.txt by digest, then container and token removed in ${Date.now() - started}ms`);

    // 6 (set up first). A container with another owner's label, started the same way.
    const foreignToken = join(dataDir, "foreign-token");
    await writeFile(foreignToken, `${randomUUID()}${randomUUID()}\n`, { mode: 0o444 });
    await chmod(foreignToken, 0o444);
    await docker(
      sandboxRunArgs({
        port: 0,
        tokenFile: foreignToken,
        image,
        name: foreignName,
        network: networks.internet,
        labels: { [MANAGED_LABEL]: "1", [OWNER_LABEL]: foreignOwner, [SESSION_LABEL]: randomUUID() },
      }),
    );

    // 5. Kill the daemon-side state: a session is live, then the daemon "dies"
    // (its manager and host are abandoned, never disposed). The next daemon on
    // the same data directory reaps the leftover at startup.
    // It is drained first, from the metadata persisted beside its token.
    const crashed = await host.open(`${chatId}-2`, "sandbox");
    expect((crashed as { state: string }).state).toBe("ready");
    const [orphanId] = await mine(manager.owner);
    expect(orphanId).toBeTruthy();
    await docker([
      "exec",
      "-u",
      "desktop",
      orphanId,
      "sh",
      "-c",
      "mkdir -p /home/desktop/outbox && printf orphaned > /home/desktop/outbox/.o.part && mv /home/desktop/outbox/.o.part /home/desktop/outbox/orphan.txt",
    ]);
    await delay(1_200);
    const next = wire().manager;
    expect(next.owner).toBe(manager.owner);
    const orphanDrains: { cause: string; chatId: string; body?: string }[] = [];
    next.drainBeforeDestroy = async (sandbox, signal) => {
      const entry = (await sandbox.driver.listOutbox(signal)).find((e) => e.name === "orphan.txt");
      const file = entry?.sha256 ? await sandbox.driver.downloadOutboxFile(entry.name, signal, { expectedSha256: entry.sha256 }) : undefined;
      orphanDrains.push({ cause: sandbox.cause, chatId: sandbox.chatId, body: file?.data.toString("utf8") });
    };
    const reaped = await next.reap();
    log(`reaper after the crash drained ${orphanDrains.length} and removed ${reaped.length} container(s)`);
    expect(reaped).toHaveLength(1);
    expect(orphanDrains).toEqual([{ cause: "orphan", chatId: `${chatId}-2`, body: "orphaned" }]);
    await until(async () => (await mine(manager.owner)).length === 0, "the orphan's removal");
    expect(await readdir(manager.sessionsDir)).toEqual([]);

    // 6. The other owner's container survived that reap, and survives another.
    await next.reap();
    expect(await mine(foreignOwner)).toHaveLength(1);
    log("a container with another owner's label survived both reaps");
  },
  900_000,
);

it.skipIf(!enabled)(
  "network none: an --internal network, no published port, reached at its bridge address, no internet",
  async () => {
    settings = { ...settings, network: "none" };
    const { manager, host } = wire();
    const chatId = `chat-none-${suffix}`;
    const opened = (await host.open(chatId, "sandbox")) as { id: string; state: string };
    expect(opened.state).toBe("ready");
    const ofSession = async () =>
      (
        await docker([
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `label=${OWNER_LABEL}=${manager.owner}`,
          "--filter",
          `label=${SESSION_LABEL}=${opened.id}`,
        ])
      )
        .split("\n")
        .filter(Boolean);
    const [id] = await ofSession();
    const [info] = JSON.parse(await docker(["inspect", id]));
    expect(Object.keys(info.NetworkSettings.Networks)).toEqual([networks.none]);
    expect(info.HostConfig.PortBindings ?? {}).toEqual({});
    const [network] = JSON.parse(await docker(["network", "inspect", networks.none]));
    expect(network.Internal).toBe(true);
    expect(network.Options["com.docker.network.bridge.enable_icc"]).toBe("false");
    // Egress: no route off the bridge.
    const egress = await docker([
      "exec",
      id,
      "node",
      "-e",
      "require('net').connect({host:'1.1.1.1',port:443,timeout:3000}).on('connect',()=>console.log('connected')).on('error',e=>console.log(e.code)).on('timeout',()=>console.log('timeout'))",
    ]).catch((error: { stdout?: string }) => error.stdout ?? "exec failed");
    log(`egress from the internal network: ${egress.trim()}`);
    expect(egress.trim()).not.toBe("connected");
    await host.stop(chatId, opened.id);
    await until(async () => (await ofSession()).length === 0, "removal");
    settings = { ...settings, network: "internet" };
  },
  300_000,
);
