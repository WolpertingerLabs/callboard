/**
 * Sandbox desktop profiles, without Docker: the registry of built-in recipes,
 * how a profile image is judged (current, out of date, refused), verified
 * downloads, the Settings caps, and the whole consent → open path through the
 * real host, service and container manager on an in-memory Docker — the
 * profile's image and clamped limits reach `docker run` with the base
 * hardening unchanged, its session length reaches the service as a
 * per-session TTL, and the Computer view and cu_status show it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseService, PROFILE_LABELS, PROFILE_SECURITY_FLOOR, sandboxRunArgs, type Driver } from "@wolpertingerlabs/computer-use";
import { SANDBOX_DESKTOP_BOUNDS, type SandboxDesktopMode } from "shared/types/index.js";
import { ComputerUseHost, controlPrincipal, sandboxTargetDriver, sessionProfileName, type HostPolicy, type RaiseHumanApproval } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { SandboxContainerManager, managedSandboxDriver, PROFILE_LABEL } from "./sandbox-containers.js";
import { effectiveProfileLimits, normalizeSandboxSettings, resolveSandboxSettings, type ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import { profileForConsent } from "./sandbox-profile-consent.js";
import {
  fetchVerified,
  inspectProfileImage,
  listProfiles,
  loadBuiltinProfiles,
  parseProfileVariant,
  profileVariant,
  resolveProfile,
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
  [PROFILE_LABELS.recipe]: entry.digest,
  [PROFILE_LABELS.baseImage]: BASE_ID,
  [PROFILE_LABELS.baseContent]: sandboxContentDigest(),
  [PROFILE_LABELS.gl]: entry.recipe.gl,
  [PROFILE_LABELS.floor]: String(PROFILE_SECURITY_FLOOR),
  ...overrides,
});

describe("the registry", () => {
  it("ships blender and test, both valid, tagged in the profile repository", () => {
    const { entries, errors } = loadBuiltinProfiles();
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.recipe.name, e.image, e.source])).toEqual([
      ["blender", "callboard/computer-use-profile:blender", "builtin"],
      ["test", "callboard/computer-use-profile:test", "builtin"],
    ]);
    expect(resolveProfile("blender")?.recipe.gl).toBe("software");
    for (const name of ["base", "nope", "../test", "Test"]) expect(resolveProfile(name)).toBeUndefined();
  });

  it("a later (scoped) source never shadows an earlier one's name", () => {
    const fake: ProfileSource = { kind: "builtin", list: () => [{ ...testProfile(), digest: "shadow" }] };
    const merged = listProfiles({ workspaceId: "w1" }, [{ kind: "builtin", list: builtins }, fake]);
    expect(merged.filter((e) => e.recipe.name === "test")).toHaveLength(1);
    expect(merged.find((e) => e.recipe.name === "test")?.digest).toBe(testProfile().digest);
  });

  it("a variant binds a name to a recipe digest", () => {
    const entry = testProfile();
    const variant = profileVariant(entry);
    expect(variant).toBe(`test@${entry.digest.slice(0, 16)}`);
    expect(parseProfileVariant(variant)).toEqual({ name: "test", digest: entry.digest.slice(0, 16) });
    expect(sessionProfileName(variant)).toBe("test");
    for (const bad of ["test", "test@xyz", "base@0123456789abcdef", "Test@0123456789abcdef", "test@0123456789abcdef0"])
      expect(parseProfileVariant(bad)).toBeUndefined();
  });
});

describe("judging a profile image", () => {
  const judge = async (labels: Record<string, string> | null, base = { imageId: BASE_ID, content: sandboxContentDigest() }) => {
    const docker = fakeDocker();
    const entry = testProfile();
    if (labels) docker.state.images.set(entry.image, { id: `sha256:${"1".repeat(64)}`, labels });
    return inspectProfileImage(docker.run, entry, base);
  };
  it("missing, current, and out of date by recipe or base (still startable)", async () => {
    const entry = testProfile();
    expect((await judge(null)).state).toBe("missing");
    expect(await judge(currentLabels(entry))).toMatchObject({ state: "current", id: `sha256:${"1".repeat(64)}`, sizeBytes: 123456789 });
    expect(await judge(currentLabels(entry, { [PROFILE_LABELS.recipe]: "old" }))).toMatchObject({ state: "outdated", outdatedBy: ["recipe"] });
    expect(await judge(currentLabels(entry), { imageId: `sha256:${"2".repeat(64)}`, content: sandboxContentDigest() })).toMatchObject({
      state: "outdated",
      outdatedBy: ["base"],
    });
    expect(await judge(currentLabels(entry, { [PROFILE_LABELS.baseContent]: "older" }))).toMatchObject({ state: "outdated", outdatedBy: ["base"] });
    expect(await judge(currentLabels(entry, { [PROFILE_LABELS.recipe]: "old" }), {} as never)).toMatchObject({ outdatedBy: ["recipe", "base"] });
  });
  it("refused below either security floor, without our labels, or on another protocol major", async () => {
    const entry = testProfile();
    expect((await judge(currentLabels(entry, { "dev.callboard.computer-use.security-floor": "0" }))).state).toBe("insecure");
    expect((await judge(currentLabels(entry, { [PROFILE_LABELS.floor]: "0" }))).state).toBe("insecure");
    const { [PROFILE_LABELS.floor]: _floor, ...noFloor } = currentLabels(entry);
    expect((await judge(noFloor)).state).toBe("insecure");
    expect((await judge(currentLabels(entry, { [PROFILE_LABELS.name]: "blender" }))).state).toBe("insecure");
    expect((await judge(currentLabels(entry, { "dev.callboard.computer-use.protocol": "3.0" }))).state).toBe("incompatible");
  });
});

describe("verified downloads", () => {
  const body = Buffer.from("profile download bytes");
  const sha = createHash("sha256").update(body).digest("hex");
  const respond = (init: { url?: string; status?: number; bytes?: Buffer } = {}) =>
    vi.fn(async () =>
      Object.defineProperty(new Response(init.bytes ?? body, { status: init.status ?? 200 }), "url", { value: init.url ?? "https://example.com/f" }),
    );
  const dataDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "cb-profile-dl-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    return dir;
  };

  it("keeps only a file whose SHA-256 matches, and reuses it from the cache", async () => {
    const dir = await dataDir();
    const fetchImpl = respond();
    const file = await fetchVerified({ url: "https://example.com/f", sha256: sha }, { dataDir: dir, fetchImpl: fetchImpl as never });
    expect(file).toBe(join(dir, "sandbox-desktop", "profile-downloads", sha));
    expect(await fetchVerified({ url: "https://example.com/f", sha256: sha }, { dataDir: dir, fetchImpl: fetchImpl as never })).toBe(file);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a mismatch (and caches nothing), a failed response, and a redirect off https", async () => {
    const dir = await dataDir();
    const wrong = "f".repeat(64);
    await expect(fetchVerified({ url: "https://example.com/f", sha256: wrong }, { dataDir: dir, fetchImpl: respond() as never })).rejects.toThrow(
      `has sha256 ${sha}, but the recipe requires ${wrong}`,
    );
    expect(await readdir(join(dir, "sandbox-desktop", "profile-downloads"))).toEqual([]);
    await expect(fetchVerified({ url: "https://example.com/f", sha256: sha }, { dataDir: dir, fetchImpl: respond({ status: 404 }) as never })).rejects.toThrow(
      "answered 404",
    );
    await expect(
      fetchVerified({ url: "https://example.com/f", sha256: sha }, { dataDir: dir, fetchImpl: respond({ url: "http://example.com/f" }) as never }),
    ).rejects.toThrow("redirected away from https");
  });
});

describe("the Settings caps", () => {
  it("validate strictly, default sanely, and clamp a recipe's request", () => {
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
    // Nothing requested: the base sandbox's own values.
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
  it("refuses outside managed mode, an unknown name (listing the real ones), and an image not built or refused", async () => {
    await expect(profileForConsent("test", deps({ mode: "endpoint" }).deps)).rejects.toMatchObject({ code: "unsupported", message: /need managed mode/ });
    await expect(profileForConsent("maya", deps().deps)).rejects.toMatchObject({ code: "invalid_request", message: /Available: blender, test/ });
    await expect(profileForConsent("blender", deps().deps)).rejects.toMatchObject({ code: "unsupported", message: /is not built.*building is theirs/ });
    const { docker, deps: d } = deps();
    docker.state.images.set(testProfile().image, { id: `sha256:${"1".repeat(64)}`, labels: currentLabels(testProfile(), { [PROFILE_LABELS.floor]: "0" }) });
    await expect(profileForConsent("test", d)).rejects.toMatchObject({ code: "unsupported", message: /must be rebuilt/ });
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
    profile: (name) => (name === "test" ? resolveEntry() : undefined),
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
    expect(args!.at(-1)).toBe(testProfile().image);
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
          !arg.includes("computer-use-"),
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
