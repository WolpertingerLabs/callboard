import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL,
  SANDBOX_DEFAULT_LIMITS,
  SANDBOX_IMAGE_LABELS,
  SANDBOX_INTERNAL_NETWORK,
  SANDBOX_NETWORK,
  SANDBOX_PROTOCOL_LABEL_VALUE,
  SANDBOX_TOKEN_PATH,
  ensureSandboxNetwork,
  sandboxContentDigest,
  sandboxImageBuildArgs,
  SANDBOX_SECURITY_FLOOR,
  sandboxNetworkCreateArgs,
  sandboxRunArgs,
} from "../dist/index.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("sandboxRunArgs carries every hardening flag, and the token only as a read-only file mount", () => {
  const args = sandboxRunArgs({ port: 0, tokenFile: "/tmp/x/token", name: "cb-1", labels: { "dev.callboard.sandbox": "1", "dev.callboard.chat": "abc" } });
  assert.equal(args[0], "run");
  assert.equal(args.at(-1), "callboard/computer-use-desktop:local");
  for (const flag of [
    "--detach",
    "--rm",
    "--read-only",
    "--cap-drop=ALL",
    "--cap-add=SETUID",
    "--cap-add=SETGID",
    "--security-opt=no-new-privileges",
    `--pids-limit=${SANDBOX_DEFAULT_LIMITS.pids}`,
    `--memory=${SANDBOX_DEFAULT_LIMITS.memory}`,
    `--memory-swap=${SANDBOX_DEFAULT_LIMITS.memory}`,
    `--cpus=${SANDBOX_DEFAULT_LIMITS.cpus}`,
    `--network=${SANDBOX_NETWORK}`,
  ])
    assert.ok(args.includes(flag), flag);
  const after = (flag) => args.filter((_, i) => args[i - 1] === flag);
  assert.deepEqual(after("--publish"), ["127.0.0.1::7801"]);
  assert.deepEqual(after("--mount"), [`type=bind,source=/tmp/x/token,target=${SANDBOX_TOKEN_PATH},readonly`]);
  assert.deepEqual(after("--tmpfs"), [
    "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
    "/home/desktop:rw,nosuid,nodev,size=512m,uid=10001,gid=10001,mode=0755",
  ]);
  assert.deepEqual(after("--label"), ["dev.callboard.sandbox=1", "dev.callboard.chat=abc"]);
  assert.deepEqual(after("--name"), ["cb-1"]);
  // Never: an environment variable, a privileged mode, a Docker socket, another host path.
  const joined = args.join(" ");
  for (const bad of ["--env", "-e", "--privileged", "docker.sock", "--volume", "-v", "--network=host", "0.0.0.0"])
    assert.ok(!args.includes(bad) && !joined.includes(bad), bad);
  assert.deepEqual(
    sandboxRunArgs({ port: 7801, tokenFile: "/t" }).filter((a) => a.startsWith("127.0.0.1")),
    ["127.0.0.1:7801:7801"],
  );
});

test("sandboxRunArgs takes limits and refuses unsafe input", () => {
  const args = sandboxRunArgs({ port: 1, tokenFile: "/t", limits: { memory: "2g", cpus: 2, pids: 512, homeSize: "1g" }, remove: false });
  for (const flag of ["--memory=2g", "--memory-swap=2g", "--cpus=2", "--pids-limit=512"]) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes("--rm"));
  assert.ok(args.some((a) => a.startsWith("/home/desktop:") && a.includes("size=1g")));
  for (const bad of [
    { port: -1, tokenFile: "/t" },
    { port: 70000, tokenFile: "/t" },
    { port: 1, tokenFile: "relative/token" },
    { port: 1, tokenFile: "/a,source=/etc/shadow" },
    { port: 1, tokenFile: "/t", name: "--privileged" },
    { port: 1, tokenFile: "/t", image: "--privileged" },
    { port: 1, tokenFile: "/t", labels: { "bad key": "x" } },
    { port: 1, tokenFile: "/t", limits: { memory: "1g,exec" } },
    { port: 1, tokenFile: "/t", limits: { cpus: 0 } },
    { port: 1, tokenFile: "/t", limits: { pids: 5 } },
    { port: 1, tokenFile: "/t", network: "host" },
    { port: 1, tokenFile: "/t", network: "none" },
    { port: 1, tokenFile: "/t", network: "bridge" },
    { port: 1, tokenFile: "/t", network: "container:abc" },
  ])
    assert.throws(() => sandboxRunArgs(bad), { code: "invalid_request" }, JSON.stringify(bad));
});

test("docker/run.sh uses the same hardening as sandboxRunArgs", async () => {
  const script = await readFile(join(packageDir, "docker", "run.sh"), "utf8");
  const args = sandboxRunArgs({ port: 7801, tokenFile: "/x" });
  for (const flag of args.filter(
    (a) => a.startsWith("--") && a !== "--detach" && a !== "--rm" && !a.startsWith("--network=") && !["--publish", "--mount", "--tmpfs", "--name"].includes(a),
  ))
    assert.ok(script.includes(flag), `run.sh lacks ${flag}`);
  for (const tmpfs of args.filter((_, i) => args[i - 1] === "--tmpfs")) assert.ok(script.includes(`--tmpfs ${tmpfs}`), `run.sh lacks --tmpfs ${tmpfs}`);
  assert.ok(script.includes(`target=${SANDBOX_TOKEN_PATH},readonly`));
  assert.ok(script.includes('--publish "127.0.0.1:$port:7801"'));
  assert.ok(script.includes('--network="$network"') && script.includes(`COMPUTER_USE_DESKTOP_NETWORK:-${SANDBOX_NETWORK}`));
  for (const part of sandboxNetworkCreateArgs().slice(2, -1)) assert.ok(script.includes(part), `run.sh network lacks ${part}`);
  assert.ok(script.includes("trap 'rm -rf \"$dir\"' EXIT"), "token directory cleaned on failure");
  assert.ok(!/\s-e\s|--env\b/.test(script), "no environment variables");
});

test("sandbox networks are bridges with inter-container traffic off; a non-default network is used as given", () => {
  assert.deepEqual(sandboxNetworkCreateArgs(), [
    "network",
    "create",
    "--driver",
    "bridge",
    "--opt",
    "com.docker.network.bridge.enable_icc=false",
    "--label",
    "dev.callboard.sandbox-network=1",
    "callboard-sandbox",
  ]);
  assert.throws(() => sandboxNetworkCreateArgs("--bad"), { code: "invalid_request" });
  assert.ok(sandboxRunArgs({ port: 1, tokenFile: "/t", network: "cb-test-net" }).includes("--network=cb-test-net"));
});

test("the image labels match package.json and the protocol", async () => {
  const dockerfile = await readFile(join(packageDir, "docker", "Dockerfile"), "utf8");
  const { version } = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.ok(dockerfile.includes(`${SANDBOX_IMAGE_LABELS.version}="${version}"`), "image version label out of date");
  assert.equal(SANDBOX_PROTOCOL_LABEL_VALUE, `${PROTOCOL.major}.${PROTOCOL.minor}`);
  assert.ok(dockerfile.includes(`${SANDBOX_IMAGE_LABELS.protocol}="${SANDBOX_PROTOCOL_LABEL_VALUE}"`), "image protocol label out of date");
  // And the base image stays pinned by digest.
  assert.match(dockerfile, /ARG NODE_IMAGE=node:[^\s]+@sha256:[0-9a-f]{64}/);
});

test("an unpublished sandbox (an --internal network) has no --publish and must take port 0", () => {
  const args = sandboxRunArgs({ port: 0, publish: false, tokenFile: "/tmp/x/token", network: SANDBOX_INTERNAL_NETWORK });
  assert.ok(!args.includes("--publish"));
  assert.ok(args.includes(`--network=${SANDBOX_INTERNAL_NETWORK}`));
  assert.throws(() => sandboxRunArgs({ port: 7801, publish: false, tokenFile: "/tmp/x/token" }), { code: "invalid_request" });
  // Published stays the default, on loopback.
  assert.ok(sandboxRunArgs({ port: 0, tokenFile: "/tmp/x/token" }).includes("127.0.0.1::7801"));
});

test("internal network arguments keep inter-container traffic off and add --internal", () => {
  const args = sandboxNetworkCreateArgs(SANDBOX_INTERNAL_NETWORK, { internal: true });
  assert.deepEqual(args, [
    "network",
    "create",
    "--driver",
    "bridge",
    "--internal",
    "--opt",
    "com.docker.network.bridge.enable_icc=false",
    "--label",
    "dev.callboard.sandbox-network=1",
    SANDBOX_INTERNAL_NETWORK,
  ]);
  assert.ok(!sandboxNetworkCreateArgs().includes("--internal"));
});

test("ensureSandboxNetwork through a caller's Docker runner: creates when missing, refuses an internal/external mismatch", async () => {
  const networks = new Map();
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(" "));
    if (args[1] === "inspect") {
      const n = networks.get(args[2]);
      if (!n) throw new Error("No such network");
      return JSON.stringify([n]);
    }
    if (args[1] === "create") {
      networks.set(args.at(-1), {
        Driver: "bridge",
        Internal: args.includes("--internal"),
        Options: { "com.docker.network.bridge.enable_icc": "false" },
      });
      return "id\n";
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  await ensureSandboxNetwork({ name: "n-int", internal: true, run });
  assert.equal(networks.get("n-int").Internal, true);
  assert.ok(calls.some((c) => c.startsWith("network create --driver bridge --internal")));
  await ensureSandboxNetwork({ name: "n-int", internal: true, run }); // exists and matches
  await assert.rejects(ensureSandboxNetwork({ name: "n-int", run }), { code: "invalid_request" }); // exists but internal
  await ensureSandboxNetwork({ name: "n-ext", run });
  await assert.rejects(ensureSandboxNetwork({ name: "n-ext", internal: true, run }), { code: "invalid_request" });
  networks.set("n-icc", { Driver: "bridge", Internal: false, Options: {} });
  await assert.rejects(ensureSandboxNetwork({ name: "n-icc", run }), { code: "invalid_request" });
});

test("the Docker context ships in the package and builds from dist, not src", async () => {
  const pkg = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("docker"), "docker/ must be in files");
  const dockerfile = await readFile(join(packageDir, "docker", "Dockerfile"), "utf8");
  assert.ok(/^COPY dist \.\/dist$/m.test(dockerfile), "the image copies the compiled dist/");
  assert.ok(!/^COPY src/m.test(dockerfile), "the image must not need src/");
  assert.ok(!/npm run build/.test(dockerfile), "the image must not compile");
  assert.ok(pkg.files.includes(".dockerignore"), ".dockerignore must be in files");
  const ignore = await readFile(join(packageDir, ".dockerignore"), "utf8");
  for (const line of ["*", "!package.json", "!dist", "!docker/package-lock.json", "!docker/start-desktop.sh"])
    assert.ok(ignore.split("\n").includes(line), line);
});

test("the image declares the security floor the package requires, and run.sh labels its build with the content digest", async () => {
  const dockerfile = await readFile(join(packageDir, "docker", "Dockerfile"), "utf8");
  assert.ok(Number.isInteger(SANDBOX_SECURITY_FLOOR) && SANDBOX_SECURITY_FLOOR >= 1);
  assert.ok(
    dockerfile.includes(`${SANDBOX_IMAGE_LABELS.securityFloor}="${SANDBOX_SECURITY_FLOOR}"`),
    "Dockerfile security-floor label out of step with SANDBOX_SECURITY_FLOOR",
  );
  const script = await readFile(join(packageDir, "docker", "run.sh"), "utf8");
  assert.ok(script.includes(`--label "${SANDBOX_IMAGE_LABELS.content}=$digest"`), "run.sh must label its build with the content digest");
  assert.ok(script.includes("sandboxContentDigest"), "run.sh must compute the digest with the package's function");
  const args = sandboxImageBuildArgs({ context: packageDir, image: "callboard/test:x" });
  assert.deepEqual(args.slice(0, 5), ["build", "--label", `${SANDBOX_IMAGE_LABELS.content}=${sandboxContentDigest(packageDir)}`, "-t", "callboard/test:x"]);
  assert.match(sandboxContentDigest(packageDir), /^[0-9a-f]{64}$/);
  assert.throws(() => sandboxImageBuildArgs({ context: packageDir, image: "--evil" }), { code: "invalid_request" });
});
