import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { installDrift } = require("./reload.cjs");

const lock = (packages) => ({ lockfileVersion: 3, packages: { "": { name: "root" }, ...packages } });

describe("installDrift", () => {
  const wanted = {
    backend: { name: "callboard-backend" },
    "packages/drawlatch": { version: "1.0.0-alpha.69" },
    "node_modules/express": { version: "5.3.0" },
    "node_modules/@wolpertingerlabs/drawlatch": { resolved: "packages/drawlatch", link: true },
    "node_modules/@esbuild/darwin-arm64": { version: "0.21.5", optional: true },
    "node_modules/fsevents": { version: "2.3.3", devOptional: true },
  };

  it("passes when node_modules matches the lockfile", () => {
    const installed = { ...wanted };
    delete installed["node_modules/@esbuild/darwin-arm64"]; // optional platform binaries may be absent
    delete installed["node_modules/fsevents"];
    expect(installDrift(lock(wanted), lock(installed))).toBeNull();
  });

  it("reports a missing node_modules", () => {
    expect(installDrift(lock(wanted), null)).toMatch(/missing/);
  });

  it("reports a version that differs from the lockfile", () => {
    const installed = { ...wanted, "node_modules/express": { version: "4.22.3" } };
    expect(installDrift(lock(wanted), lock(installed))).toMatch(/express is 4\.22\.3, lockfile wants 5\.3\.0/);
  });

  it("reports a registry copy where the lockfile wants the workspace link (pre-workspace node_modules)", () => {
    const installed = { ...wanted, "node_modules/@wolpertingerlabs/drawlatch": { version: "1.0.0-alpha.68" } };
    expect(installDrift(lock(wanted), lock(installed))).toMatch(/drawlatch should be a link to packages\/drawlatch/);
  });

  it("reports a required package that is not installed", () => {
    const installed = { ...wanted };
    delete installed["node_modules/express"];
    expect(installDrift(lock(wanted), lock(installed))).toMatch(/express is not installed/);
  });

  it("caps the list and counts the rest", () => {
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`node_modules/p${i}`, { version: "1.0.0" }]));
    const out = installDrift(lock(many), lock({}));
    expect(out.split("\n")).toHaveLength(6);
    expect(out).toMatch(/and 3 more/);
  });
});
