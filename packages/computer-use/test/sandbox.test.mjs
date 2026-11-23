import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_DEFAULT_LIMITS, SANDBOX_TOKEN_PATH, sandboxRunArgs } from "../dist/index.js";

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
  ])
    assert.throws(() => sandboxRunArgs(bad), { code: "invalid_request" }, JSON.stringify(bad));
});

test("docker/run.sh uses the same hardening as sandboxRunArgs", async () => {
  const script = await readFile(join(packageDir, "docker", "run.sh"), "utf8");
  const args = sandboxRunArgs({ port: 7801, tokenFile: "/x" });
  for (const flag of args.filter((a) => a.startsWith("--") && a !== "--detach" && a !== "--rm" && !["--publish", "--mount", "--tmpfs", "--name"].includes(a)))
    assert.ok(script.includes(flag), `run.sh lacks ${flag}`);
  for (const tmpfs of args.filter((_, i) => args[i - 1] === "--tmpfs")) assert.ok(script.includes(`--tmpfs ${tmpfs}`), `run.sh lacks --tmpfs ${tmpfs}`);
  assert.ok(script.includes(`target=${SANDBOX_TOKEN_PATH},readonly`));
  assert.ok(script.includes('--publish "127.0.0.1:$port:7801"'));
  assert.ok(!/\s-e\s|--env\b/.test(script), "no environment variables");
});
