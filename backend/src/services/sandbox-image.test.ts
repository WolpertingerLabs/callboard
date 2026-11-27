/**
 * The sandbox image's content digest (review round 1, finding 2): stable for
 * the same shipped files, different when any of them changes, ignoring source
 * maps and mtimes, and carried as a label by every build.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SANDBOX_CONTENT_LABEL,
  inspectSandboxImage,
  sandboxBuildContext,
  sandboxContentDigest,
  sandboxImageBuildArgs,
  sandboxPackageVersion,
} from "./sandbox-image.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
function context() {
  const dir = mkdtempSync(join(tmpdir(), "cb-sandbox-ctx-"));
  dirs.push(dir);
  mkdirSync(join(dir, "dist", "remote"), { recursive: true });
  mkdirSync(join(dir, "docker"));
  writeFileSync(join(dir, "package.json"), '{"version":"0.1.0"}');
  writeFileSync(join(dir, "dist", "driver-host-cli.js"), "host v1");
  writeFileSync(join(dir, "dist", "remote", "host.js"), "remote v1");
  writeFileSync(join(dir, "docker", "Dockerfile"), "FROM x");
  writeFileSync(join(dir, "docker", "package-lock.json"), "{}");
  writeFileSync(join(dir, "docker", "start-desktop.sh"), "#!/bin/sh");
  return dir;
}

describe("sandboxContentDigest", () => {
  it("is stable for the same files, ignores mtimes and source maps, and changes with any shipped file", () => {
    const dir = context();
    const first = sandboxContentDigest(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    utimesSync(join(dir, "dist", "driver-host-cli.js"), new Date(0), new Date(0));
    writeFileSync(join(dir, "dist", "driver-host-cli.js.map"), "{}");
    expect(sandboxContentDigest(dir)).toBe(first);
    for (const file of ["dist/remote/host.js", "docker/Dockerfile", "docker/start-desktop.sh", "package.json"]) {
      const other = context();
      writeFileSync(join(other, file), "changed");
      expect(sandboxContentDigest(other), file).not.toBe(first);
    }
    // A rebuilt dist/ in a running daemon is noticed (the memo is keyed on sizes and mtimes).
    writeFileSync(join(dir, "dist", "remote", "host.js"), "remote v2");
    expect(sandboxContentDigest(dir)).not.toBe(first);
  });

  it("ignores the package version (package.json, docker/package-lock.json), but nothing else in those files", () => {
    const lock = (version: string, dep = "^1.0.0") =>
      JSON.stringify({ name: "p", version, lockfileVersion: 3, packages: { "": { name: "p", version, dependencies: { a: dep } } } }, null, 2);
    const dir = context();
    writeFileSync(join(dir, "docker", "package-lock.json"), lock("0.1.0"));
    const first = sandboxContentDigest(dir);
    const bumped = context();
    writeFileSync(join(bumped, "package.json"), '{\n  "version": "1.0.0-alpha.70",\n  "gitHead": "abc"\n}\n');
    writeFileSync(join(bumped, "docker", "package-lock.json"), lock("1.0.0-alpha.70"));
    expect(sandboxContentDigest(bumped)).toBe(first);
    const changed = (file: string, text: string) => {
      const other = context();
      writeFileSync(join(other, "docker", "package-lock.json"), lock("0.1.0"));
      writeFileSync(join(other, file), text);
      return sandboxContentDigest(other);
    };
    expect(changed("package.json", '{"version":"0.1.0","main":"x.js"}')).not.toBe(first);
    expect(changed("docker/package-lock.json", lock("0.1.0", "^2.0.0"))).not.toBe(first);
    expect(changed("package.json", "not json")).not.toBe(first);
  });

  it("is computed for the real shipped context, and every build carries it as a label", () => {
    const digest = sandboxContentDigest();
    const args = sandboxImageBuildArgs({ image: "callboard/test:x" });
    expect(args.slice(0, 5)).toEqual([
      "build",
      "--label",
      `${SANDBOX_CONTENT_LABEL}=${digest}`,
      "--label",
      `org.opencontainers.image.version=${sandboxPackageVersion()}`,
    ]);
    expect(sandboxPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(args.at(-1)).toBe(sandboxBuildContext());
  });

  it("inspect reports current only for a matching label", async () => {
    const docker = (labels: Record<string, string>) => async () => JSON.stringify(labels);
    const base = { "dev.callboard.computer-use.protocol": "2.0" };
    await expect(inspectSandboxImage(docker({ ...base, [SANDBOX_CONTENT_LABEL]: "a" }), "i", undefined, () => "a")).resolves.toMatchObject({
      compatible: true,
      current: true,
    });
    await expect(inspectSandboxImage(docker({ ...base, [SANDBOX_CONTENT_LABEL]: "b" }), "i", undefined, () => "a")).resolves.toMatchObject({
      compatible: true,
      current: false,
      content: "b",
    });
    await expect(inspectSandboxImage(docker(base), "i", undefined, () => "a")).resolves.toMatchObject({ compatible: true, current: false });
  });
});
