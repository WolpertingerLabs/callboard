/**
 * Sandbox desktop profiles, without Docker: the registry of built-in recipes
 * (scopes, entry ids, variants), how a profile image is judged (current, out
 * of date, refused), the download address policy, the Settings caps, and the
 * whole consent → open path through the real host, service and container
 * manager on an in-memory Docker — the profile's image and clamped limits
 * reach `docker run` with the base hardening unchanged, its session length
 * reaches the service as a per-session TTL, an image not built from the
 * consented recipe never starts, and the Computer view and cu_status show it.
 * The downloads themselves (redirects, DNS, pinning) are tested against a
 * local TLS server in sandbox-profiles.download.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComputerUseService,
  PROFILE_LABELS,
  PROFILE_SECURITY_FLOOR,
  parseProfileRecipe,
  profileCompilerDigest,
  sandboxRunArgs,
  type Driver,
} from "@wolpertingerlabs/computer-use";
import { SANDBOX_DESKTOP_BOUNDS, type SandboxDesktopMode } from "shared/types/index.js";
import { ComputerUseHost, controlPrincipal, sandboxTargetDriver, sessionProfileName, type HostPolicy, type RaiseHumanApproval } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { SandboxContainerManager, managedSandboxDriver, PROFILE_LABEL } from "./sandbox-containers.js";
import { effectiveProfileLimits, normalizeSandboxSettings, resolveSandboxSettings, type ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import { profileForConsent } from "./sandbox-profile-consent.js";
import {
  addressProblem,
  architectureProblem,
  entryIdOf,
  inspectProfileImage,
  listProfiles,
  loadBuiltinProfiles,
  makeEntry,
  parseProfileVariant,
  profileVariant,
  resolveProfile,
  resolveProfileId,
  scopesFor,
  workspaceScopeKey,
  type ProfileEntry,
  type ProfileSource,
} from "./sandbox-profiles.js";
import { sandboxContentDigest } from "./sandbox-image.js";
import { fakeDocker, fakeRemote } from "./__fixtures__/sandbox-docker.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const builtins = () => loadBuiltinProfiles().entries;
const testProfile = () => builtins().find((entry) => entry.recipe.name === "test")!;
const BASE_ID = `sha256:${"0".repeat(64)}`;
/** The labels a current build of `entry` carries. */
const currentLabels = (entry: ProfileEntry, overrides: Record<string, string> = {}) => ({
  "dev.callboard.computer-use.protocol": "2.0",
  "dev.callboard.computer-use.security-floor": "1",
  [PROFILE_LABELS.name]: entry.recipe.name,
  [PROFILE_LABELS.scope]: entry.scope,
  [PROFILE_LABELS.recipe]: entry.digest,
  [PROFILE_LABELS.compiler]: profileCompilerDigest(),
  [PROFILE_LABELS.baseImage]: BASE_ID,
  [PROFILE_LABELS.baseContent]: sandboxContentDigest(),
  [PROFILE_LABELS.gl]: entry.recipe.gl,
  [PROFILE_LABELS.floor]: String(PROFILE_SECURITY_FLOOR),
  ...overrides,
});

describe("the registry", () => {
  it("ships blender and test in the global scope, valid, tagged by entry id", () => {
    const { entries, errors } = loadBuiltinProfiles();
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.id, e.scope, e.image, e.source])).toEqual([
      ["global/blender", "global", "callboard/computer-use-profile:blender", "builtin"],
      ["global/test", "global", "callboard/computer-use-profile:test", "builtin"],
    ]);
    expect(resolveProfile("blender")?.recipe.architectures).toEqual(["amd64"]);
    expect(resolveProfileId("global/test")?.recipe.name).toBe("test");
    for (const name of ["base", "nope", "../test", "Test"]) expect(resolveProfile(name)).toBeUndefined();
    expect(entryIdOf("blender")).toBe("global/blender");
    for (const [profile, scope] of [
      ["Blender", "global"],
      ["blender", "w123"],
      ["blender", "../x"],
    ])
      expect(entryIdOf(profile, scope)).toBeUndefined();
  });

  it("scopes: a chat sees global and its own workspace's (keyed on workspaceId, else folder); a global name is never shadowed", () => {
    const ws = workspaceScopeKey({ workspaceId: "w1", folder: "/a" })!;
    expect(ws).toMatch(/^w[0-9a-f]{12}$/);
    // The workspace id decides when there is one; the folder only without it.
    expect(workspaceScopeKey({ workspaceId: "w1", folder: "/b" })).toBe(ws);
    expect(workspaceScopeKey({ folder: "/a" })).not.toBe(ws);
    expect(scopesFor({})).toEqual(["global"]);
    // A folder is resolved first, as the deliverables key it; a relative one has no scope.
    expect(workspaceScopeKey({ folder: "/a/b/../c/" })).toBe(workspaceScopeKey({ folder: "/a/c" }));
    expect(workspaceScopeKey({ folder: "relative/dir" })).toBeUndefined();
    // A chat sees global, its workspace's and its folder's: gaining a workspace record does not hide the folder's profiles.
    const folderOnly = workspaceScopeKey({ folder: "/a" })!;
    expect(scopesFor({ workspaceId: "w1", folder: "/a" })).toEqual(["global", ws, folderOnly]);
    const mine = makeEntry(parseProfileRecipe(JSON.stringify({ schema: 1, name: "mine", description: "A workspace profile" })), ws, "builtin");
    expect([mine.id, mine.image]).toEqual([`${ws}/mine`, `callboard/computer-use-profile:${ws}-mine`]);
    const shadow = makeEntry(testProfile().recipe, ws, "builtin");
    const sources: ProfileSource[] = [
      { kind: "builtin", scope: "global", list: builtins },
      { kind: "builtin", scope: ws, list: () => [shadow, mine] },
    ];
    const seen = listProfiles({ workspaceId: "w1" }, sources);
    expect(seen.find((e) => e.recipe.name === "test")?.id).toBe("global/test");
    expect(seen.map((e) => e.id)).toContain(`${ws}/mine`);
    // Another workspace sees neither.
    expect(listProfiles({ workspaceId: "w2" }, sources).map((e) => e.id)).not.toContain(`${ws}/mine`);
  });

  it("a variant binds a scope, a name and a recipe digest", () => {
    const entry = testProfile();
    const variant = profileVariant(entry);
    expect(variant).toBe(`global:test@${entry.digest.slice(0, 16)}`);
    expect(parseProfileVariant(variant)).toEqual({ scope: "global", name: "test", id: "global/test", digest: entry.digest.slice(0, 16) });
    expect(sessionProfileName(variant)).toBe("test");
    for (const bad of [
      "test",
      "test@0123456789abcdef",
      "global:test@xyz",
      "global:base@0123456789abcdef",
      "w12:test@0123456789abcdef",
      "global:Test@0123456789abcdef",
    ])
      expect(parseProfileVariant(bad)).toBeUndefined();
  });

  it("an architecture the recipe does not list is a problem; no list means any", () => {
    const blender = resolveProfile("blender")!;
    expect(architectureProblem(blender, "amd64")).toBeUndefined();
    expect(architectureProblem(blender, "arm64")).toBe("Profile blender builds only on amd64, and this Docker host is arm64.");
    expect(architectureProblem(testProfile(), "arm64")).toBeUndefined();
  });
});

describe("judging a profile image", () => {
  const judge = async (labels: Record<string, string> | null, base = { imageId: BASE_ID, content: sandboxContentDigest() }) => {
    const docker = fakeDocker();
    const entry = testProfile();
    if (labels) docker.state.images.set(entry.image, { id: `sha256:${"1".repeat(64)}`, labels });
    return inspectProfileImage(docker.run, entry, base);
  };
  it("missing; current; out of date (still startable) only when the base content or the compiler changed", async () => {
    const entry = testProfile();
    expect((await judge(null)).state).toBe("missing");
    expect(await judge(currentLabels(entry))).toMatchObject({ state: "current", id: `sha256:${"1".repeat(64)}`, sizeBytes: 123456789 });
    expect(await judge(currentLabels(entry, { [PROFILE_LABELS.baseContent]: "older" }))).toMatchObject({ state: "outdated", outdatedBy: ["base"] });
    expect(await judge(currentLabels(entry, { [PROFILE_LABELS.compiler]: "older" }))).toMatchObject({ state: "outdated", outdatedBy: ["compiler"] });
    const outdated = await judge(currentLabels(entry, { [PROFILE_LABELS.baseContent]: "older" }));
    expect(outdated.detail).toMatch(/runs the driver host and hardening of the build it came from/);
    // A base rebuilt from identical files (a new image ID) changes nothing a profile depends on.
    expect((await judge(currentLabels(entry), { imageId: `sha256:${"2".repeat(64)}`, content: sandboxContentDigest() })).state).toBe("current");
  });
  it("refused: another recipe (rebuild-required), unlabelled, below either floor, another protocol major", async () => {
    const entry = testProfile();
    expect(await judge(currentLabels(entry, { [PROFILE_LABELS.recipe]: "f".repeat(64) }))).toMatchObject({ state: "rebuild-required", recipe: "f".repeat(64) });
    expect((await judge(currentLabels(entry, { [PROFILE_LABELS.name]: "blender" }))).state).toBe("unlabelled");
    expect((await judge(currentLabels(entry, { [PROFILE_LABELS.scope]: "w0123456789ab" }))).state).toBe("unlabelled");
    const { [PROFILE_LABELS.name]: _name, ...anonymous } = currentLabels(entry);
    expect((await judge(anonymous)).state).toBe("unlabelled");
    expect((await judge(currentLabels(entry, { "dev.callboard.computer-use.security-floor": "0" }))).state).toBe("insecure");
    expect((await judge(currentLabels(entry, { [PROFILE_LABELS.floor]: "0" }))).state).toBe("insecure");
    expect((await judge(currentLabels(entry, { "dev.callboard.computer-use.protocol": "3.0" }))).state).toBe("incompatible");
  });
});

describe("the download address policy", () => {
  it("refuses this machine, private, link-local, CGNAT, ULA, multicast, reserved and tunnelled addresses", () => {
    for (const address of [
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "169.254.169.254",
      "172.17.0.1",
      "192.168.1.1",
      "192.0.2.1",
      "198.18.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "64:ff9b::a00:1",
      "2002:a00:1::1",
      "2001:db8::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
    ])
      expect(addressProblem(address), address).toBeDefined();
    // IPv4-compatible (::/96), IPv4-translated (::ffff:0:0:0/96) and IPv4-mapped (::ffff:0:0/96), whatever they embed.
    for (const address of ["::5db8:d70e", "::ffff:0:5db8:d70e", "::ffff:93.184.215.14", "0:0:0:0:0:ffff:5db8:d70e"])
      expect(addressProblem(address), address).toBeDefined();
    for (const address of ["93.184.215.14", "151.101.1.69", "2606:4700::6810:84e5"]) expect(addressProblem(address), address).toBeUndefined();
    expect(addressProblem("example.com")).toBe("is not an IP address");
  });
});

describe("the Settings caps", () => {
  it("validate strictly, default sanely, and clamp a recipe's request (the home within memory)", () => {
    expect(() => normalizeSandboxSettings({ profileMaxCpus: 64 }, true)).toThrow("profileMaxCpus must be a number from 0.5 to 32, in steps of 0.01");
    expect(() => normalizeSandboxSettings({ profileMaxSessionMinutes: 1000 }, true)).toThrow(
      "profileMaxSessionMinutes must be a whole number of minutes from 5 to 480",
    );
    expect(normalizeSandboxSettings({ profileMaxMemoryMb: 100 }, false)).toEqual({});
    const settings = resolveSandboxSettings({});
    expect(settings.profileCaps).toEqual({
      cpus: SANDBOX_DESKTOP_BOUNDS.profileMaxCpus.default,
      memoryMb: SANDBOX_DESKTOP_BOUNDS.profileMaxMemoryMb.default,
      homeMb: SANDBOX_DESKTOP_BOUNDS.profileMaxHomeMb.default,
      sessionMinutes: SANDBOX_DESKTOP_BOUNDS.profileMaxSessionMinutes.default,
    });
    const blender = resolveProfile("blender")!.recipe;
    expect(effectiveProfileLimits(blender, settings)).toEqual({ cpus: 4, memoryMb: 4096, homeMb: 2048, sessionMinutes: 60 });
    const tight = resolveSandboxSettings({ profileMaxCpus: 2, profileMaxSessionMinutes: 30 });
    expect(effectiveProfileLimits(blender, tight)).toEqual({ cpus: 2, memoryMb: 4096, homeMb: 2048, sessionMinutes: 30, clamped: ["cpus", "sessionMinutes"] });
    // A memory cap below the request shrinks the home with it: the home is memory, and the desktop keeps its headroom.
    const lowMemory = resolveSandboxSettings({ profileMaxMemoryMb: 2048 });
    expect(effectiveProfileLimits(blender, lowMemory)).toEqual({ cpus: 4, memoryMb: 2048, homeMb: 1536, sessionMinutes: 60, clamped: ["memoryMb", "homeMb"] });
    // Nothing requested: the base sandbox's own values (a 512 MiB home within 1 GiB leaves the desktop 512 MiB).
    expect(effectiveProfileLimits({ limits: {} }, settings)).toEqual({ cpus: 1, memoryMb: 1024, homeMb: 512, sessionMinutes: 15 });
  });
});

describe("before the human is asked", () => {
  const deps = (overrides: Partial<Parameters<typeof profileForConsent>[1]> = {}) => {
    const docker = fakeDocker();
    const entry = testProfile();
    docker.state.images.set(entry.image, { id: `sha256:${"1".repeat(64)}`, labels: currentLabels(entry) });
    return {
      docker,
      deps: {
        mode: "managed" as SandboxDesktopMode,
        docker: docker.run,
        baseImage: "callboard/computer-use-desktop:local",
        settings: resolveSandboxSettings({}),
        resolve: (name: string) => resolveProfile(name),
        names: () => builtins().map((e) => e.recipe.name),
        ...overrides,
      },
    };
  };
  it("names the profile, its clamped limits and the variant that binds the consent", async () => {
    const { deps: d } = deps({ settings: resolveSandboxSettings({ profileMaxSessionMinutes: 5 }) });
    expect(await profileForConsent("test", d)).toEqual({
      name: "test",
      description: testProfile().recipe.description,
      gl: "software",
      limits: { cpus: 1, memoryMb: 1024, homeMb: 256, sessionMinutes: 5 },
      variant: profileVariant(testProfile()),
    });
  });
  it("refuses outside managed mode, an unknown name (listing the real ones), another architecture, and an image not built or refused", async () => {
    await expect(profileForConsent("test", deps({ mode: "endpoint" }).deps)).rejects.toMatchObject({ code: "unsupported", message: /need managed mode/ });
    await expect(profileForConsent("maya", deps().deps)).rejects.toMatchObject({ code: "invalid_request", message: /Available: blender, test/ });
    await expect(profileForConsent("blender", deps().deps)).rejects.toMatchObject({ code: "unsupported", message: /is not built.*building is theirs/ });
    await expect(profileForConsent("blender", deps({ arch: async () => "arm64" }).deps)).rejects.toMatchObject({
      code: "unsupported",
      message: /builds only on amd64, and this Docker host is arm64/,
    });
    for (const labels of [{ [PROFILE_LABELS.floor]: "0" }, { [PROFILE_LABELS.recipe]: "f".repeat(64) }] as Record<string, string>[]) {
      const { docker, deps: d } = deps();
      docker.state.images.set(testProfile().image, { id: `sha256:${"1".repeat(64)}`, labels: currentLabels(testProfile(), labels) });
      await expect(profileForConsent("test", d)).rejects.toMatchObject({ code: "unsupported", message: /must be rebuilt/ });
    }
  });
});

const policy: HostPolicy = { policy: readComputerUsePolicy({ browserControl: "allow", computerControl: "deny", sandboxControl: "allow" }), signature: "s" };

async function fixture(options: { settings?: Partial<ResolvedSandboxSettings>; mode?: SandboxDesktopMode; entry?: () => ProfileEntry | undefined } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "cb-sandbox-profiles-"));
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }));
  const docker = fakeDocker();
  const entry = testProfile();
  docker.state.images.set(entry.image, { id: `sha256:${"1".repeat(64)}`, labels: currentLabels(entry) });
  const remote = fakeRemote();
  const settings: ResolvedSandboxSettings = { ...resolveSandboxSettings({}), ...options.settings };
  const resolveEntry = options.entry ?? (() => entry);
  const manager = new SandboxContainerManager({
    docker: docker.run,
    dataDir,
    settings: () => settings,
    createRemoteDriver: remote.factory,
    helloIntervalMs: 5,
    helloTimeoutMs: 5_000,
    preflightCacheMs: 0,
    profile: (ref) => (ref.id === "global/test" ? resolveEntry() : undefined),
  });
  let mode: SandboxDesktopMode = options.mode ?? "managed";
  const never: Driver = {
    kind: "browser",
    probe: async () => ({ available: true, kind: "browser", capabilities: [] }),
    open: async () => ({ observe: async () => ({}) as never, act: async () => {}, releaseInput: async () => {}, close: async () => {} }),
  };
  const desktop: Driver = { ...never, kind: "native-desktop", lockDomain: "profiles-test:desktop" };
  const endpointOpen = vi.fn(async () => {
    throw new Error("the endpoint must never be opened with a profile");
  });
  const sandbox = sandboxTargetDriver({
    mode: () => mode,
    managed: managedSandboxDriver(manager),
    endpoint: {
      kind: "native-desktop",
      lockDomain: "profiles-test:endpoint",
      probe: async () => ({ available: true, kind: "native-desktop", capabilities: [] }),
      open: endpointOpen,
    },
    info: () => ({ mode }),
    containerState: (sessionId) => manager.containerState(sessionId),
    profileForConsent: (name) =>
      profileForConsent(name, {
        mode,
        docker: docker.run,
        baseImage: manager.image,
        settings,
        resolve: (n) => (n === "test" ? entry : resolveProfile(n)),
        names: () => ["blender", "test"],
      }),
    sessionProfile: (sessionId) => manager.profileOf(sessionId),
  });
  const cards: { input: Record<string, unknown>; answer: (approved: boolean) => unknown }[] = [];
  const raise = vi.fn<RaiseHumanApproval>((_chatId, request, answer) => {
    cards.push({ input: request.input, answer: answer as (approved: boolean) => unknown });
    return { requestId: `prompt-${cards.length}`, isOpen: () => true, cancel: () => true };
  });
  const notices: string[] = [];
  const service = new ComputerUseService({
    targets: [
      { id: "managed-browser", enabled: true, driver: never },
      { id: "native-desktop", enabled: true, driver: desktop },
      { id: "sandbox-desktop", enabled: true, driver: sandbox },
    ],
    authorize: (request) => host.authorize(request),
    maxSessionTtlMs: 8 * 60 * 60_000,
  });
  const host: ComputerUseHost = new ComputerUseHost(
    service,
    { browser: never, desktop, sandbox },
    () => policy,
    raise,
    (_chatId, text) => notices.push(text),
  );
  cleanups.push(async () => {
    await host.dispose();
    await manager.dispose();
  });
  const runArgs = () => docker.state.calls.filter((call) => call[0] === "run");
  return { host, service, manager, docker, cards, notices, runArgs, endpointOpen, setMode: (next: SandboxDesktopMode) => (mode = next) };
}
const signal = () => new AbortController().signal;

describe("consent → open on a profile", () => {
  it("asks with the profile and its limits, then runs its image with the base hardening and its own limits and session length", async () => {
    const f = await fixture();
    const pending = await f.host.requestControl("chat-p", "sandbox", "Model a teapot", signal(), { profile: "test" });
    expect(pending).toMatchObject({ status: "consent_pending" });
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]!.input).toMatchObject({
      kind: "sandbox",
      durationMinutes: 10,
      profile: {
        name: "test",
        description: testProfile().recipe.description,
        gl: "software",
        limits: { cpus: 1, memoryMb: 1024, homeMb: 256, sessionMinutes: 10 },
      },
    });
    expect(JSON.stringify(f.cards[0]!.input)).not.toContain("variant");
    await f.cards[0]!.answer(true);
    const [args] = f.runArgs();
    expect(args).toBeDefined();
    // Run by the ID of the image that was inspected, never the tag again: a retag in between cannot start an unchecked image.
    expect(args!.at(-1)).toBe(`sha256:${"1".repeat(64)}`);
    expect(args).toEqual(expect.arrayContaining(["--cpus=1", "--memory=1024m", "--memory-swap=1024m", `--label`, `${PROFILE_LABEL}=test`]));
    expect(args).toContain("/home/desktop:rw,nosuid,nodev,size=256m,uid=10001,gid=10001,mode=0755");
    // Exactly sandboxRunArgs' hardening: the same argv as a base run but for the image, limits and labels.
    const tokenFile = args![args!.indexOf("--mount") + 1]!.split(",")[1]!.slice("source=".length);
    const base = sandboxRunArgs({ port: 0, tokenFile, name: args![args!.indexOf("--name") + 1], network: "callboard-sandbox" });
    const strip = (a: string[]) =>
      a.filter(
        (arg, i) =>
          !arg.startsWith("--cpus") &&
          !arg.startsWith("--memory") &&
          !arg.startsWith("/home/desktop:") &&
          arg !== "--label" &&
          a[i - 1] !== "--label" &&
          !arg.includes("computer-use-") &&
          !arg.startsWith("sha256:"),
      );
    expect(strip(args!)).toEqual(strip(base));
    const session = f.service.status(controlPrincipal("chat-p", "agent"))[0]!;
    expect(session).toMatchObject({ state: "ready", variant: profileVariant(testProfile()) });
    expect(Math.abs(session.expiresAt - Date.now() - 10 * 60_000)).toBeLessThan(5_000);
    expect(f.notices.at(-1)).toMatch(/on sandbox profile test is ready and agent-controlled for up to 10 minutes/);
    // The Computer view shows it; no recipe text but the description reaches it.
    const status = await f.host.status("chat-p");
    expect(status.sessions[0]).toMatchObject({
      profile: { name: "test", gl: "software", limits: { cpus: 1, memoryMb: 1024, homeMb: 256, sessionMinutes: 10 } },
    });
  });

  it("clamps to the Settings caps, and the session length follows", async () => {
    const f = await fixture({ settings: { profileCaps: { cpus: 0.5, memoryMb: 512, homeMb: 256, sessionMinutes: 5 } } });
    await f.host.requestControl("chat-c", "sandbox", "x", signal(), { profile: "test" });
    expect(f.cards[0]!.input).toMatchObject({ durationMinutes: 5, profile: { limits: { cpus: 0.5, memoryMb: 512, homeMb: 256, sessionMinutes: 5 } } });
    await f.cards[0]!.answer(true);
    expect(f.runArgs()[0]).toEqual(expect.arrayContaining(["--cpus=0.5", "--memory=512m"]));
    const session = f.service.status(controlPrincipal("chat-c", "agent"))[0]!;
    expect(Math.abs(session.expiresAt - Date.now() - 5 * 60_000)).toBeLessThan(5_000);
  });

  it("without a profile (or with 'base') nothing changes: the base image, 15 minutes", async () => {
    const f = await fixture();
    await f.host.requestControl("chat-b", "sandbox", "x", signal(), { profile: "base" });
    expect(f.cards[0]!.input).toMatchObject({ durationMinutes: 15 });
    expect(f.cards[0]!.input.profile).toBeUndefined();
    await f.cards[0]!.answer(true);
    expect(f.runArgs()[0]!.at(-1)).toBe("callboard/computer-use-desktop:local");
    const session = f.service.status(controlPrincipal("chat-b", "agent"))[0]!;
    expect(session.variant).toBeUndefined();
    expect((await f.host.status("chat-b")).sessions[0]).not.toHaveProperty("profile");
  });

  it("refuses a profile it cannot start before anyone is asked", async () => {
    const f = await fixture();
    await expect(f.host.requestControl("c", "browser", "x", signal(), { profile: "test" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.host.requestControl("c", "sandbox", "x", signal(), { profile: "Bad Name" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(f.host.requestControl("c", "sandbox", "x", signal(), { profile: "maya" })).rejects.toMatchObject({
      code: "invalid_request",
      message: /Available: blender, test/,
    });
    await expect(f.host.requestControl("c", "sandbox", "x", signal(), { profile: "blender" })).rejects.toMatchObject({
      code: "unsupported",
      message: /not built/,
    });
    f.setMode("endpoint");
    await expect(f.host.requestControl("c", "sandbox", "x", signal(), { profile: "test" })).rejects.toMatchObject({
      code: "unsupported",
      message: /managed mode/,
    });
    expect(f.cards).toEqual([]);
    expect(f.endpointOpen).not.toHaveBeenCalled();
    expect(f.host.agentRequests("c")).toEqual([]);
  });

  it("a recipe that changed after consent is refused at start, never swapped in", async () => {
    let entry: ProfileEntry = testProfile();
    const f = await fixture({ entry: () => entry });
    await f.host.requestControl("chat-r", "sandbox", "x", signal(), { profile: "test" });
    entry = { ...entry, digest: "f".repeat(64) };
    await f.cards[0]!.answer(true);
    expect(f.runArgs()).toEqual([]);
    expect(f.service.status(controlPrincipal("chat-r", "agent")).some((s) => s.state === "ready")).toBe(false);
    expect(f.notices.at(-1)).toMatch(/was NOT enabled/);
  });

  it("consent binds the image too: an image built from another recipe never starts, even if it changed after the card was shown", async () => {
    // Refused before asking: the image is an older recipe's build (the card would show the current one).
    const stale = await fixture();
    stale.docker.state.images.set(testProfile().image, {
      id: `sha256:${"1".repeat(64)}`,
      labels: currentLabels(testProfile(), { [PROFILE_LABELS.recipe]: "e".repeat(64) }),
    });
    await expect(stale.host.requestControl("chat-s", "sandbox", "x", signal(), { profile: "test" })).rejects.toMatchObject({
      code: "unsupported",
      message: /must be rebuilt/,
    });
    expect(stale.cards).toEqual([]);
    // Swapped after consent was asked: the start re-reads the image and refuses it.
    const f = await fixture();
    await f.host.requestControl("chat-i", "sandbox", "x", signal(), { profile: "test" });
    f.docker.state.images.set(testProfile().image, {
      id: `sha256:${"2".repeat(64)}`,
      labels: currentLabels(testProfile(), { [PROFILE_LABELS.recipe]: "e".repeat(64) }),
    });
    await f.cards[0]!.answer(true);
    expect(f.runArgs()).toEqual([]);
    expect(f.notices.at(-1)).toMatch(/was NOT enabled/);
  });

  it("an existing session on another profile is not silently reused", async () => {
    const f = await fixture();
    await f.host.requestControl("chat-e", "sandbox", "x", signal());
    await f.cards[0]!.answer(true);
    await expect(f.host.requestControl("chat-e", "sandbox", "x", signal(), { profile: "test" })).rejects.toMatchObject({
      code: "lease_conflict",
      message: /already has a sandbox session \(the base desktop\), not profile test/,
    });
    // The same (base) request returns the existing session, as before.
    expect(await f.host.requestControl("chat-e", "sandbox", "x", signal())).toMatchObject({ state: "ready" });
  });

  it("the sandbox target never opens an endpoint with a profile", async () => {
    const f = await fixture();
    f.setMode("endpoint");
    await expect(f.service.open(controlPrincipal("z", "agent"), "sandbox-desktop", undefined, { variant: profileVariant(testProfile()) })).rejects.toBeTruthy();
    expect(f.endpointOpen).not.toHaveBeenCalled();
    expect(existsSync(f.manager.sessionsDir) ? await readdir(f.manager.sessionsDir) : []).toEqual([]);
  });
});
