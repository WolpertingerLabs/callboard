/**
 * Agent-built Sandbox desktop profiles against real Docker, end to end:
 *
 *   CALLBOARD_DOCKER_TESTS=1 npx vitest run backend/src/services/sandbox-profile-proposals.docker.test.ts
 *
 * 1. The agent proposes a small recipe (x11-apps) through the proposal
 *    manager; it is stored as version 1 and a human-only card is raised with
 *    the real `openHumanApproval`.
 * 2. The human approves it through the same path `/respond` takes
 *    (`respondToPermission` with the card's request id); the build is queued
 *    pinned to the digest, requested by the agent's chat, and built for real.
 * 3. A session starts from it through `requestControl` and consent, on the
 *    exact image that was built, and xeyes is there.
 * 4. The agent re-proposes a changed recipe: the card diffs it against
 *    version 1, the digest is new, and once approved and built the image is
 *    labelled with the new digest.
 *
 * Builds the base under a per-run tag (layers come from the build cache)
 * and the profile in a per-run repository, and removes both, their
 * containers and networks afterwards. Never the production
 * `callboard/computer-use-desktop:local` or `callboard/computer-use-profile`.
 * CALLBOARD_DOCKER_MANAGED_IMAGE reuses a base image (and its `-builder` tag)
 * instead of building one.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerUseService, PROFILE_LABELS, type Driver } from "@wolpertingerlabs/computer-use";
import { recipeLineDiff, type SandboxProfileProposalCardInput } from "shared/types/index.js";
import { ComputerUseHost, controlPrincipal, sandboxTargetDriver, type HostPolicy, type RaiseHumanApproval } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { MANAGED_LABEL, OWNER_LABEL, SandboxContainerManager, managedSandboxDriver } from "./sandbox-containers.js";
import { resolveSandboxSettings, type ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import { buildSandboxImage, execDocker, sandboxBuilderImage } from "./sandbox-image.js";
import { profileForConsent } from "./sandbox-profile-consent.js";
import { buildProfileImage, defaultSources, listProfiles, resolveProfile, resolveProfileId, workspaceScopeKey } from "./sandbox-profiles.js";
import { SandboxBuilds } from "./sandbox-builds.js";
import { ProfileStore } from "./sandbox-profile-store.js";
import { SandboxProfileProposals } from "./sandbox-profile-proposals.js";
import { clearOpenApprovalsForTest, getPendingRequest, openHumanApproval, respondToPermission } from "./pending-requests.js";

const enabled = process.env.CALLBOARD_DOCKER_TESTS === "1";
const suffix = randomUUID().slice(0, 8);
const reuse = process.env.CALLBOARD_DOCKER_MANAGED_IMAGE?.trim();
if (reuse === "callboard/computer-use-desktop:local") throw new Error("Refusing to reuse the production base image");
const image = reuse || `callboard/computer-use-desktop:atest-${suffix}`;
const repository = `callboard/computer-use-profile-atest-${suffix}`;
const networks = { internet: `callboard-sandbox-atest-${suffix}`, none: `callboard-sandbox-atest-${suffix}-int` };
const log = (...parts: unknown[]) => console.log("[agent-profiles-docker]", ...parts);

function docker(args: string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("docker", args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
    ),
  );
}
const imageIdOf = async (ref: string) => (await docker(["image", "inspect", "--format", "{{.Id}}", ref])).trim();

let dataDir = "";
let previousRepository: string | undefined;
const chatId = `chat-agent-${suffix}`;
const settings: ResolvedSandboxSettings = { ...resolveSandboxSettings({}), maxConcurrent: 2 };
const policy: HostPolicy = { policy: readComputerUsePolicy({ browserControl: "deny", computerControl: "deny", sandboxControl: "allow" }), signature: "s" };
const imagesBuilt = new Set<string>();
const managers: SandboxContainerManager[] = [];
const hosts: ComputerUseHost[] = [];
let proposals: SandboxProfileProposals | undefined;

const recipe = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  name: "agent-eyes",
  description: "xeyes, proposed by an agent in a Callboard test",
  packages: ["x11-apps"],
  limits: { cpus: 1, memoryMb: 1024, homeMb: 256, sessionMinutes: 10 },
  ...over,
});

beforeAll(async () => {
  if (!enabled) return;
  dataDir = await mkdtemp(join(tmpdir(), "callboard-agent-profiles-docker-"));
  previousRepository = process.env.CALLBOARD_SANDBOX_PROFILE_REPOSITORY;
  process.env.CALLBOARD_SANDBOX_PROFILE_REPOSITORY = repository;
  if (!reuse) {
    log(`building ${image} and ${sandboxBuilderImage(image)} from the shipped context`);
    const started = Date.now();
    await buildSandboxImage({ image });
    log(`base built in ${Math.round((Date.now() - started) / 1000)}s`);
  }
}, 1_800_000);

afterAll(async () => {
  if (!enabled) return;
  proposals?.dispose();
  clearOpenApprovalsForTest();
  await Promise.all(hosts.map((host) => host.dispose().catch(() => {})));
  await Promise.all(managers.map((manager) => manager.dispose().catch(() => {})));
  for (const manager of managers)
    for (const id of (
      await docker(["ps", "--all", "--quiet", "--filter", `label=${MANAGED_LABEL}=1`, "--filter", `label=${OWNER_LABEL}=${manager.owner}`]).catch(() => "")
    )
      .split("\n")
      .filter(Boolean))
      await docker(["rm", "--force", id]).catch(() => {});
  for (const name of Object.values(networks)) await docker(["network", "rm", name]).catch(() => {});
  // Every image this run built, by tag and by ID (version 1's image lost its tag to version 2's).
  for (const ref of imagesBuilt) await docker(["image", "rm", "--force", ref]).catch(() => {});
  if (!reuse) for (const tag of [image, sandboxBuilderImage(image)]) await docker(["image", "rm", tag]).catch(() => {});
  if (previousRepository === undefined) delete process.env.CALLBOARD_SANDBOX_PROFILE_REPOSITORY;
  else process.env.CALLBOARD_SANDBOX_PROFILE_REPOSITORY = previousRepository;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}, 300_000);

it.skipIf(!enabled)(
  "an agent proposes a recipe, a human approves it, it builds, a session starts from it; a re-proposal diffs and rebuilds under a new digest",
  async () => {
    const store = new ProfileStore(join(dataDir, "profiles"));
    const sources = () => defaultSources(store);
    const chat = { folder: join(dataDir, "work") };
    const scope = workspaceScopeKey(chat)!;
    const notices: { text: string; wake: boolean }[] = [];
    const outputs = new Map<string, string>();
    const builds = new SandboxBuilds({
      dir: join(dataDir, "builds"),
      run: async (target, onOutput, signal) => {
        if (target.kind !== "profile") throw new Error("only profile builds here");
        const entry = resolveProfileId(target.id, sources());
        if (!entry || (target.digest && entry.digest !== target.digest)) throw new Error("not the approved recipe");
        await buildProfileImage({
          entry,
          docker: execDocker(),
          dataDir,
          baseImage: image,
          signal,
          onOutput: (chunk) => {
            onOutput(chunk);
            outputs.set(target.id, ((outputs.get(target.id) ?? "") + chunk).slice(-20_000));
          },
        });
        imagesBuilt.add(entry.image);
        imagesBuilt.add(await imageIdOf(entry.image));
      },
      onFinished: (record) => proposals?.onBuildFinished(record),
    });
    proposals = new SandboxProfileProposals({
      readPolicy: () => policy,
      raiseApproval: openHumanApproval,
      notify: (_chat, text, options) => notices.push({ text, wake: options?.wake !== false }),
      store: () => store,
      settings: () => settings,
      mode: () => "managed",
      chatScope: () => chat,
      ownerLabel: () => `the folder ${chat.folder}`,
      visibleProfiles: () => listProfiles(chat, sources()),
      globalNames: () => new Set(listProfiles({}, sources()).map((e) => e.recipe.name)),
      builds: () => builds,
    });
    // The human answers the card as `/respond` does: by the prompt identity the card carries.
    const approveCard = async () => {
      const pending = getPendingRequest(chatId)!;
      expect(pending).toMatchObject({ humanOnly: true, toolName: "mcp__computer_use__sandbox_profile_propose" });
      const answered = respondToPermission(chatId, true, undefined, undefined, pending.requestId);
      expect(answered.ok).toBe(true);
      expect(await answered.completion).toEqual({ ok: true });
      return pending.input as unknown as SandboxProfileProposalCardInput;
    };
    const untilBuilt = async (version: number) => {
      const started = Date.now();
      await builds.idle();
      const build = builds.list().find((b) => b.version === version)!;
      if (build.phase !== "succeeded") console.log(outputs.get(build.profile!) ?? "");
      expect(build.phase).toBe("succeeded");
      log(`version ${version} built in ${Math.round((Date.now() - started) / 1000)}s`);
      return build;
    };

    // 1–2. Propose, approve through the human path, build.
    const first = proposals.propose(chatId, { name: "agent-eyes", recipe: recipe(), note: "for a test" });
    expect(first).toMatchObject({ status: "approval_pending", version: 1, scope: "folder" });
    const card1 = await approveCard();
    expect(card1.previous).toBeUndefined();
    const build1 = await untilBuilt(1);
    expect(build1).toMatchObject({ digest: first.digest, requestedBy: { kind: "agent", chatId, approvalId: first.requestId } });
    expect(notices.map((n) => n.wake)).toEqual([false, true]);
    expect(notices[1]!.text).toContain(`Build ${build1.id} of your sandbox profile proposal ${first.requestId} (version 1) succeeded`);
    const entry1 = resolveProfile("agent-eyes", chat, sources())!;
    expect(entry1).toMatchObject({ source: "agent", scope, digest: first.digest, version: 1 });
    expect(entry1.image).toBe(`${repository}:${scope}-agent-eyes`);
    const labels1 = JSON.parse(await docker(["image", "inspect", "--format", "{{json .Config.Labels}}", entry1.image])) as Record<string, string>;
    expect(labels1[PROFILE_LABELS.recipe]).toBe(first.digest);
    expect(labels1[PROFILE_LABELS.scope]).toBe(scope);

    // 3. Test it: an ordinary consented session, on exactly the image that was built.
    const exec = execDocker();
    const manager = new SandboxContainerManager({
      docker: exec,
      dataDir,
      settings: () => settings,
      image,
      networks,
      profile: (ref) => resolveProfileId(ref.id, sources()),
    });
    managers.push(manager);
    const none: Driver = {
      kind: "browser",
      probe: async () => ({ available: false, kind: "browser", capabilities: [] }),
      open: async () => {
        throw new Error("unused");
      },
    };
    const desktop: Driver = { ...none, kind: "native-desktop", lockDomain: `atest-desktop-${suffix}` };
    const sandbox = sandboxTargetDriver({
      mode: () => "managed",
      managed: managedSandboxDriver(manager),
      endpoint: { ...desktop, lockDomain: `atest-endpoint-${suffix}` },
      containerState: (sessionId) => manager.containerState(sessionId),
      profileForConsent: (name) =>
        profileForConsent(name, {
          mode: "managed",
          docker: exec,
          baseImage: image,
          settings,
          resolve: (n) => resolveProfile(n, chat, sources()),
          names: () => listProfiles(chat, sources()).map((e) => e.recipe.name),
        }),
      sessionProfile: (sessionId) => manager.profileOf(sessionId),
    });
    const consents: { answer: (approved: boolean) => unknown }[] = [];
    const raise: RaiseHumanApproval = (_chatId, _request, answer) => {
      consents.push({ answer: answer as (approved: boolean) => unknown });
      return { requestId: `consent-${consents.length}`, isOpen: () => true, cancel: () => true };
    };
    const service = new ComputerUseService({
      targets: [
        { id: "managed-browser", enabled: true, driver: none },
        { id: "native-desktop", enabled: true, driver: desktop },
        { id: "sandbox-desktop", enabled: true, driver: sandbox },
      ],
      authorize: (request) => host.authorize(request),
      maxSessionTtlMs: 8 * 60 * 60_000,
    });
    const host: ComputerUseHost = new ComputerUseHost(
      service,
      { browser: none, desktop, sandbox },
      () => policy,
      raise,
      () => {},
    );
    hosts.push(host);
    expect(await host.requestControl(chatId, "sandbox", "test the agent's profile", new AbortController().signal, { profile: "agent-eyes" })).toMatchObject({
      status: "consent_pending",
    });
    await consents[0]!.answer(true);
    const session = service.status(controlPrincipal(chatId, "agent")).find((s) => s.state === "ready")!;
    expect(session).toBeDefined();
    const container = manager.nameOf(session.sessionId);
    const [info] = JSON.parse(await docker(["inspect", container]));
    expect(info.Config.Image).toBe(await imageIdOf(entry1.image));
    expect((await docker(["exec", "-u", "desktop", container, "sh", "-c", "command -v xeyes"])).trim()).toMatch(/xeyes$/);
    await host.stop(chatId, session.sessionId);
    await delay(500);

    // 4. Iterate: the agent re-proposes a changed recipe.
    const second = proposals.propose(chatId, {
      name: "agent-eyes",
      recipe: recipe({ description: "xeyes and xclock, version 2", setup: ["mkdir -p /opt/profile/bin", "echo v2 > /opt/profile/version"] }),
    });
    expect(second.version).toBe(2);
    expect(second.digest).not.toBe(first.digest);
    const card2 = await approveCard();
    expect(card2.previous).toMatchObject({ version: 1, digest: first.digest, state: "approved" });
    const diff = recipeLineDiff(card2.previous!.recipe, card2.recipe);
    expect(diff.filter((l) => l.op === "remove").map((l) => l.text.trim())).toEqual(
      expect.arrayContaining(['"description": "xeyes, proposed by an agent in a Callboard test",', '"setup": "",']),
    );
    expect(diff.filter((l) => l.op === "add").map((l) => l.text.trim())).toEqual(
      expect.arrayContaining(['"description": "xeyes and xclock, version 2",', '"setup": "mkdir -p /opt/profile/bin\\necho v2 > /opt/profile/version\\n",']),
    );
    await untilBuilt(2);
    const entry2 = resolveProfile("agent-eyes", chat, sources())!;
    expect(entry2).toMatchObject({ digest: second.digest, version: 2 });
    const labels2 = JSON.parse(await docker(["image", "inspect", "--format", "{{json .Config.Labels}}", entry2.image])) as Record<string, string>;
    expect(labels2[PROFILE_LABELS.recipe]).toBe(second.digest);
    expect(store.read(scope, "agent-eyes")!.versions.map((v) => [v.version, v.state])).toEqual([
      [1, "superseded"],
      [2, "approved"],
    ]);
  },
  1_800_000,
);
