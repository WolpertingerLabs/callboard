/**
 * Sandbox desktop profiles against real Docker, through Callboard's own
 * wiring: build a profile with the shipped compiler and epilogue, ask for it
 * through `requestControl` (the consent card names it and its limits), open
 * it, drive it as the agent does, check the hardening still holds inside it,
 * and drain a file from its outbox.
 *
 *   CALLBOARD_DOCKER_TESTS=1 npx vitest run backend/src/services/sandbox-profiles.docker.test.ts
 *     the `test` profile: x11-apps and software GL; launch xeyes and see the frame
 *     change; no root process, no setuid file, no apt/dpkg, no ld.so.preload;
 *     the profile's PATH and variables in the desktop's shell; a file drained.
 *
 *   CALLBOARD_DOCKER_HEAVY_TESTS=1 npx vitest run backend/src/services/sandbox-profiles.docker.test.ts
 *     the `blender` profile (downloads ~360 MB): start Blender on software GL,
 *     see its UI in a screenshot, save a .blend into ~/outbox through its own
 *     Save dialog, and see it arrive. Logs build time, image size and Blender's
 *     startup time.
 *
 * Builds the base under a per-run tag (layers come from the build cache) and
 * the profiles in a per-run repository, and removes both, their containers and
 * networks afterwards. Set CALLBOARD_DOCKER_PROFILE_REPOSITORY (any but the
 * production `callboard/computer-use-profile`, which it refuses) to build into
 * that repository and keep the profile images; CALLBOARD_DOCKER_PROFILE_CACHE to a directory to keep
 * downloads between runs; CALLBOARD_DOCKER_MANAGED_IMAGE to reuse a base image
 * (and its `-builder` tag) instead of building one.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ComputerUseService, type Driver } from "@wolpertingerlabs/computer-use";
import { ComputerUseHost, controlPrincipal, sandboxTargetDriver, type HostPolicy, type RaiseHumanApproval } from "./computer-use.js";
import { readComputerUsePolicy } from "./computer-use-policy.js";
import { MANAGED_LABEL, OWNER_LABEL, PROFILE_LABEL, SandboxContainerManager, managedSandboxDriver } from "./sandbox-containers.js";
import { resolveSandboxSettings, type ResolvedSandboxSettings } from "./sandbox-desktop-settings.js";
import { buildSandboxImage, execDocker, sandboxBuilderImage } from "./sandbox-image.js";
import { profileForConsent } from "./sandbox-profile-consent.js";
import { buildProfileImage, currentBase, inspectProfileImage, loadBuiltinProfiles, type ProfileEntry } from "./sandbox-profiles.js";

const light = process.env.CALLBOARD_DOCKER_TESTS === "1";
const heavy = process.env.CALLBOARD_DOCKER_HEAVY_TESTS === "1";
const enabled = light || heavy;
const suffix = randomUUID().slice(0, 8);
const reuse = process.env.CALLBOARD_DOCKER_MANAGED_IMAGE?.trim();
const image = reuse || `callboard/computer-use-desktop:ptest-${suffix}`;
const keepRepository = process.env.CALLBOARD_DOCKER_PROFILE_REPOSITORY?.trim();
// Never the production repository: its images belong to the running Callboard.
if (keepRepository === "callboard/computer-use-profile" || reuseIsProduction()) throw new Error("Refusing to build into or reuse a production image");
function reuseIsProduction() {
  return process.env.CALLBOARD_DOCKER_MANAGED_IMAGE?.trim() === "callboard/computer-use-desktop:local";
}
const repository = keepRepository || `callboard/computer-use-profile-ptest-${suffix}`;
const networks = { internet: `callboard-sandbox-ptest-${suffix}`, none: `callboard-sandbox-ptest-${suffix}-int` };
const log = (...parts: unknown[]) => console.log("[profiles-docker]", ...parts);

function docker(args: string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("docker", args, { encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(stdout),
    ),
  );
}
/** Run a command in the container as the desktop user, on its display. */
const asDesktop = (container: string, script: string) => docker(["exec", "-u", "desktop", "-e", "DISPLAY=:99", container, "sh", "-c", script]);
async function until(check: () => Promise<boolean>, what: string, ms = 60_000, every = 200) {
  const deadline = Date.now() + ms;
  while (!(await check().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(every);
  }
}

let dataDir = "";
let cacheDir = "";
const settings: ResolvedSandboxSettings = { ...resolveSandboxSettings({}), maxConcurrent: 2 };
const managers: SandboxContainerManager[] = [];
const hosts: ComputerUseHost[] = [];
const built: string[] = [];

const entry = (name: string): ProfileEntry => {
  const found = loadBuiltinProfiles().entries.find((e) => e.recipe.name === name)!;
  return { ...found, image: `${repository}:${name}` };
};

async function build(name: string): Promise<{ entry: ProfileEntry; seconds: number; sizeMb: number }> {
  const profile = entry(name);
  const started = Date.now();
  let output = "";
  await buildProfileImage({
    entry: profile,
    docker: execDocker(),
    dataDir: cacheDir,
    baseImage: image,
    onOutput: (chunk) => {
      output = (output + chunk).slice(-20_000);
    },
  }).catch((error) => {
    console.log(output);
    throw error;
  });
  built.push(profile.image);
  const seconds = Math.round((Date.now() - started) / 1000);
  const sizeMb = Math.round(Number((await docker(["image", "inspect", "--format", "{{.Size}}", profile.image])).trim()) / 1024 / 1024);
  for (const line of output.split("\n").filter((l) => /^(harden|verify|unpack|run-setup):/.test(l.trim()))) log(`  ${line.trim()}`);
  return { entry: profile, seconds, sizeMb };
}

/** The host, service and manager, as the daemon wires them; the agent's consent card is answered yes here. */
function wire(profile: ProfileEntry) {
  const exec = execDocker();
  const manager = new SandboxContainerManager({
    docker: exec,
    dataDir,
    settings: () => settings,
    image,
    networks,
    profile: (ref) => (ref.id === profile.id ? profile : undefined),
  });
  managers.push(manager);
  const files = new Map<string, Buffer>();
  // As Callboard's drain does: a file changed in the last second is listed without a digest; wait for it to settle.
  manager.drainBeforeDestroy = async (sandbox, signal) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const listed = await sandbox.driver.listOutbox(signal);
      if (listed.some((file) => !file.sha256)) {
        await delay(500);
        continue;
      }
      for (const file of listed) files.set(file.name, (await sandbox.driver.downloadOutboxFile(file.name, signal, { expectedSha256: file.sha256! })).data);
      return;
    }
  };
  const none: Driver = {
    kind: "browser",
    probe: async () => ({ available: false, kind: "browser", capabilities: [] }),
    open: async () => {
      throw new Error("unused");
    },
  };
  const desktop: Driver = { ...none, kind: "native-desktop", lockDomain: `ptest-desktop-${suffix}` };
  const sandbox = sandboxTargetDriver({
    mode: () => "managed",
    managed: managedSandboxDriver(manager),
    endpoint: { ...desktop, lockDomain: `ptest-endpoint-${suffix}` },
    containerState: (sessionId) => manager.containerState(sessionId),
    profileForConsent: (name) =>
      profileForConsent(name, {
        mode: "managed",
        docker: exec,
        baseImage: image,
        settings,
        resolve: (n) => (n === profile.recipe.name ? profile : undefined),
        names: () => [profile.recipe.name],
      }),
    sessionProfile: (sessionId) => manager.profileOf(sessionId),
  });
  const policy: HostPolicy = { policy: readComputerUsePolicy({ browserControl: "deny", computerControl: "deny", sandboxControl: "allow" }), signature: "s" };
  const cards: { input: Record<string, unknown>; answer: (approved: boolean) => unknown }[] = [];
  const raise: RaiseHumanApproval = (_chatId, request, answer) => {
    cards.push({ input: request.input, answer: answer as (approved: boolean) => unknown });
    return { requestId: `card-${cards.length}`, isOpen: () => true, cancel: () => true };
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
  return { manager, service, host, cards, files };
}

/** Ask for the profile, answer the card, and return the session and an `act` that goes through the host as cu_action does. */
async function open(w: ReturnType<typeof wire>, chatId: string, profile: string) {
  const started = Date.now();
  expect(await w.host.requestControl(chatId, "sandbox", "profile test", new AbortController().signal, { profile })).toMatchObject({
    status: "consent_pending",
  });
  await w.cards.at(-1)!.answer(true);
  const session = w.service.status(controlPrincipal(chatId, "agent")).find((s) => s.state === "ready")!;
  expect(session).toBeDefined();
  log(`profile ${profile}: session ready ${Date.now() - started}ms after consent`);
  const agent = controlPrincipal(chatId, "agent");
  const observe = () => w.service.observe(agent, { sessionId: session.sessionId, generation: session.generation });
  const act = async (action: Record<string, unknown>) => {
    const frame = await observe();
    const lease = w.host.agentLease(chatId, session.sessionId, session.generation);
    await w.host.requestAgentAction(chatId, session.sessionId, session.generation, frame.frameId, action, (actionId, approved) =>
      w.service.act(agent, { ...lease, frameId: frame.frameId, actionId, action: approved as never }),
    );
  };
  const container = w.manager.nameOf(session.sessionId);
  return { session, observe, act, container, chatId };
}

/** Type a command into the desktop's terminal (focused at start) and run it. */
async function shell(act: (action: Record<string, unknown>) => Promise<void>, command: string) {
  await act({ type: "type", text: command });
  await act({ type: "key", key: "Enter" });
}

/** Inside a running sandbox: what must hold whatever the recipe did. */
async function assertHardening(container: string) {
  const [info] = JSON.parse(await docker(["inspect", container]));
  expect(info.HostConfig.ReadonlyRootfs).toBe(true);
  expect(info.HostConfig.CapDrop).toEqual(["ALL"]);
  expect(info.HostConfig.SecurityOpt).toEqual(["no-new-privileges"]);
  expect(info.HostConfig.Privileged).toBe(false);
  const procs = (
    await asDesktop(
      container,
      'for p in /proc/[0-9]*; do [ "${p#/proc/}" = "$$" ] && continue; printf "%s %s %s\\n" "$(cat $p/comm 2>/dev/null)" "$(awk "/^Uid/{print \\$2}" $p/status 2>/dev/null)" "$(awk "/^CapEff/{print \\$2}" $p/status 2>/dev/null)"; done',
    )
  )
    .trim()
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([comm, uid]) => uid && !["sh", "awk", "cat"].includes(comm!));
  expect(procs.length).toBeGreaterThanOrEqual(5);
  for (const [comm, uid, caps] of procs) {
    expect(uid, `${comm} runs as root`).not.toBe("0");
    expect(caps, `${comm} holds capabilities`).toBe("0000000000000000");
  }
  const checks = await docker([
    "exec",
    container,
    "sh",
    "-c",
    [
      'echo "setuid:$(find / -xdev -type f -perm /6000 2>/dev/null | head -3 | tr "\\n" " ")"',
      'echo "apt:$(for t in apt apt-get dpkg dpkg-deb npm; do command -v $t; done | tr "\\n" " ")"',
      'echo "preload:$(ls /etc/ld.so.preload 2>/dev/null)"',
      'echo "uid0:$(awk -F: "\\$3 == 0 { print \\$1 }" /etc/passwd)"',
      'echo "trusted:$(stat -c "%u %a" /usr/local/bin/start-desktop.sh /opt/computer-use/dist/driver-host-cli.js /usr/bin/tini /usr/local/bin/node | tr "\\n" " ")"',
      'echo "opt:$(find /opt -xdev ! -user 0 2>/dev/null | head -3 | tr "\\n" " ")"',
      'echo "write:$(touch /opt/profile/x 2>&1 | head -1)"',
    ].join("; "),
  ]);
  const got = Object.fromEntries(
    checks
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
  );
  log(`hardening: ${JSON.stringify(got)}`);
  expect(got.setuid).toBe("");
  expect(got.apt).toBe("");
  expect(got.preload).toBe("");
  expect(got.uid0).toBe("root");
  // Restored from the base: root's, and nobody else may write them (dist/ keeps the host's group bits, as in the base).
  const trusted = got.trusted!.split(" ");
  expect(trusted).toHaveLength(8);
  for (let i = 0; i < 8; i += 2) {
    expect(trusted[i]).toBe("0");
    expect(Number(trusted[i + 1]!.at(-1)) & 2).toBe(0);
  }
  expect(got.opt).toBe("");
  expect(got.write).toMatch(/Read-only file system/);
}

beforeAll(async () => {
  if (!enabled) return;
  dataDir = await mkdtemp(join(tmpdir(), "callboard-profiles-docker-"));
  cacheDir = process.env.CALLBOARD_DOCKER_PROFILE_CACHE?.trim() || dataDir;
  if (!reuse) {
    log(`building ${image} and ${sandboxBuilderImage(image)} from the shipped context`);
    const started = Date.now();
    await buildSandboxImage({ image });
    log(`base built in ${Math.round((Date.now() - started) / 1000)}s`);
  }
}, 1_800_000);

afterAll(async () => {
  if (!enabled) return;
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
  if (!keepRepository) for (const tag of built) await docker(["image", "rm", tag]).catch(() => {});
  if (!reuse) for (const tag of [image, sandboxBuilderImage(image)]) await docker(["image", "rm", tag]).catch(() => {});
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
}, 300_000);

it.skipIf(!light)(
  "the test profile: built from its recipe, started on consent with its limits, an app launched, hardening intact, a file drained",
  async () => {
    const { entry: profile, seconds, sizeMb } = await build("test");
    log(`test profile built in ${seconds}s, ${sizeMb} MB`);
    const judged = await inspectProfileImage(execDocker(), profile, await currentBase(execDocker(), image));
    expect(judged.state).toBe("current");

    const w = wire(profile);
    const s = await open(w, `chat-test-${suffix}`, "test");
    // The consent card named the profile and what it gets.
    expect(w.cards[0]!.input).toMatchObject({
      durationMinutes: 10,
      profile: { name: "test", limits: { cpus: 1, memoryMb: 1024, homeMb: 256, sessionMinutes: 10 } },
    });
    const [info] = JSON.parse(await docker(["inspect", s.container]));
    expect(info.Config.Image).toBe(profile.image);
    expect(info.Config.Labels[PROFILE_LABEL]).toBe("test");
    expect(info.HostConfig.NanoCpus).toBe(1e9);
    expect(info.HostConfig.Memory).toBe(1024 * 1024 * 1024);
    expect(info.HostConfig.Tmpfs["/home/desktop"]).toContain("size=256m");
    expect(Math.abs(s.session.expiresAt - Date.now() - 10 * 60_000)).toBeLessThan(60_000);
    expect((await w.host.status(s.chatId)).sessions[0]).toMatchObject({ profile: { name: "test", gl: "software" } });

    await assertHardening(s.container);

    // Software GL is on: Mesa's llvmpipe answers on the display.
    expect(await asDesktop(s.container, "glxinfo -B")).toMatch(/OpenGL renderer string: llvmpipe/);

    // Launch the profile's app from the terminal, as the agent would, and see the frame change.
    const before = await s.observe();
    await shell(s.act, "xeyes -geometry 300x300+960+480 &");
    await until(async () => !!(await asDesktop(s.container, "xdotool search --onlyvisible --name xeyes")).trim(), "xeyes to map");
    await delay(500);
    const after = await s.observe();
    expect(after.frame.data).not.toBe(before.frame.data);
    expect([after.frame.width, after.frame.height]).toEqual([1280, 800]);

    // The profile's PATH and variables reach the desktop's shell; its output leaves through the outbox.
    // (The window manager focused xeyes: click the terminal first.)
    await s.act({ type: "click", x: 120, y: 120 });
    await shell(s.act, "profile-hello > ~/outbox/.hello.txt.part && mv ~/outbox/.hello.txt.part ~/outbox/hello.txt");
    await until(async () => (await asDesktop(s.container, "cat ~/outbox/hello.txt 2>/dev/null")).includes("profile-test-ok"), "hello.txt");
    await w.host.stop(s.chatId, s.session.sessionId);
    await until(async () => !(await docker(["ps", "--all", "--quiet", "--filter", `name=${s.container}`])).trim(), "the container to be removed");
    expect(w.files.get("hello.txt")?.toString()).toBe("profile-test-ok 1\n");
  },
  1_800_000,
);

it.skipIf(!heavy)(
  "the blender profile: Blender starts on software GL, its UI shows, and a .blend saved from its own dialog arrives",
  async () => {
    const { entry: profile, seconds, sizeMb } = await build("blender");
    log(`blender profile built in ${seconds}s, ${sizeMb} MB`);
    const w = wire(profile);
    const s = await open(w, `chat-blender-${suffix}`, "blender");
    expect(w.cards[0]!.input).toMatchObject({ durationMinutes: 60, profile: { name: "blender", gl: "software" } });
    const [info] = JSON.parse(await docker(["inspect", s.container]));
    expect(info.HostConfig.NanoCpus).toBe(4e9);
    expect(info.HostConfig.Memory).toBe(4096 * 1024 * 1024);
    await assertHardening(s.container);

    // Start Blender from the terminal, as the agent would, and time it.
    const launched = Date.now();
    await shell(s.act, "blender &");
    await until(
      async () => /Blender/.test(await asDesktop(s.container, "xdotool search --onlyvisible --name Blender getwindowname %@ 2>/dev/null")),
      "Blender's window",
      120_000,
    );
    const mapped = Date.now() - launched;
    // Drawn: Blender's panels, not a blank window. Its painted UI is several large, distinct
    // dark greys (viewport, headers, editors); an unpainted window is one flat colour.
    const greys = async () => {
      const histogram = await asDesktop(s.container, "import -window root -depth 8 -colors 16 -format %c histogram:info:- | sort -rn | head -4");
      return histogram
        .trim()
        .split("\n")
        .map((line) => /^\s*(\d+):\s*\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(line))
        .filter((m): m is RegExpExecArray => !!m)
        .map(([, count, r, g, b]) => ({ share: Number(count) / (1280 * 800), r: Number(r), g: Number(g), b: Number(b) }))
        .filter((c) => Math.max(c.r, c.g, c.b) < 110 && Math.abs(c.r - c.g) < 12 && Math.abs(c.g - c.b) < 12);
    };
    await until(
      async () => {
        const top = await greys();
        return top.length >= 3 && top.every((c) => c.share < 0.6) && top.slice(0, 3).every((c) => c.share > 0.05);
      },
      "Blender's UI to draw",
      120_000,
      250,
    );
    const drawn = Date.now() - launched;
    log(`blender: window after ${mapped}ms, UI drawn after ${drawn}ms`);
    const shot = await s.observe();
    writeFileSync(join(tmpdir(), `callboard-blender-${suffix}.png`), Buffer.from(shot.frame.data, "base64"));
    log(`blender: screenshot at ${join(tmpdir(), `callboard-blender-${suffix}.png`)}`);
    expect(
      await asDesktop(
        s.container,
        "cat /proc/$(for p in /proc/[0-9]*; do [ \"$(cat $p/comm)\" = blender ] && echo ${p#/proc/} && break; done)/environ | tr '\\0' '\\n' | grep -E '^(LIBGL_ALWAYS_SOFTWARE|GALLIUM_DRIVER)='",
      ),
    ).toMatch(/LIBGL_ALWAYS_SOFTWARE=1\nGALLIUM_DRIVER=llvmpipe|GALLIUM_DRIVER=llvmpipe\nLIBGL_ALWAYS_SOFTWARE=1/);

    // Its own Save dialog, as an agent would drive it. Blender's file name field rewrites "/" to "_"
    // (typing a full path there saves "_home_desktop_outbox_scene.blend"), so the path goes into the
    // directory field and the name into the file name field; a click starts editing a field, Enter
    // confirms it, and Enter on the hovered field then runs the save (no click on the Save button).
    const edit = async (x: number, y: number, text: string) => {
      await s.act({ type: "move", x, y });
      await s.act({ type: "wait", durationMs: 300 });
      await s.act({ type: "click", x, y });
      await s.act({ type: "key", key: "Control+a" });
      await s.act({ type: "type", text });
      await s.act({ type: "key", key: "Enter" });
    };
    await s.act({ type: "move", x: 200, y: 600 });
    await s.act({ type: "wait", durationMs: 300 });
    await s.act({ type: "click", x: 200, y: 600 }); // outside the splash closes it
    await s.act({ type: "move", x: 520, y: 380 });
    await s.act({ type: "key", key: "Control+s" });
    await until(
      async () =>
        /Blender File View/.test(await asDesktop(s.container, "xdotool search --onlyvisible --name 'Blender File View' getwindowname %@ 2>/dev/null")),
      "the Save dialog",
      30_000,
    );
    await delay(1000);
    await edit(670, 142, "/home/desktop/outbox/"); // the directory field
    await delay(800);
    await edit(600, 724, "scene.blend"); // the file name field
    await delay(800);
    await s.act({ type: "key", key: "Enter" }); // runs the save
    await until(async () => (await asDesktop(s.container, "ls ~/outbox")).split("\n").includes("scene.blend"), "scene.blend in the outbox", 60_000, 500);
    await until(
      async () =>
        /scene \[\/home\/desktop\/outbox\/scene\.blend\]/.test(await asDesktop(s.container, "xdotool search --onlyvisible --name Blender getwindowname %@")),
      "the title to name the saved file",
      30_000,
    );

    await w.host.stop(s.chatId, s.session.sessionId);
    await until(async () => !(await docker(["ps", "--all", "--quiet", "--filter", `name=${s.container}`])).trim(), "the container to be removed", 60_000);
    const blend = w.files.get("scene.blend");
    expect(blend, "scene.blend was drained").toBeDefined();
    expect(blend!.subarray(0, 7).toString()).toBe("BLENDER");
    log(`blender: scene.blend arrived, ${blend!.length} bytes`);
  },
  3_600_000,
);
