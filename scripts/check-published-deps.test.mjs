/**
 * The publish gate's import scanner.
 *
 * `deps:check` decides whether the tarball is missing a runtime dependency, and
 * it gets one thing wrong in each direction:
 *
 * - **Over-reporting blocks a publish on prose.** tsc emits JSDoc into its
 *   output, so a doc comment explaining why the code does *not*
 *   `require("<pkg>/package.json")` read to the old raw-text scan as a
 *   dependency on a package named `<pkg>`. That is what it did, on
 *   `backend/dist/utils/package-version.js`, at 1.0.0-alpha.51.
 * - **Under-reporting ships a tarball that dies on import.** That is the
 *   incident the check exists for (@agentclientprotocol/sdk, 1.0.0-alpha.43),
 *   so the "still found" cases below matter more than the "not found" ones. A
 *   scanner that loses its place inside a regex or a quote-bearing string
 *   fails silently and green.
 */
import { describe, it, expect } from "vitest";
import { blankComments, importedPackages } from "./check-published-deps.mjs";

describe("blankComments", () => {
  it("keeps offsets and line breaks so statement anchors still match", () => {
    const source = 'const a = 1; // note\nimport x from "pkg";\n';
    const blanked = blankComments(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.split("\n")).toHaveLength(source.split("\n").length);
    expect(blanked).toContain('import x from "pkg";');
  });

  it("leaves a comment marker inside a string alone", () => {
    const source = 'const url = "https://example.com/a"; import x from "pkg";';
    expect(blankComments(source)).toBe(source);
  });

  it("does not lose its place in a regex containing quotes", () => {
    // The scanner's own IMPORT_RE contains `["']`. Treating that quote as the
    // start of a string desyncs everything after it.
    const source = 'const RE = /["\']/g;\nimport x from "pkg";\n';
    expect(blankComments(source)).toContain('import x from "pkg";');
  });

  it("does not treat division as a regex", () => {
    // If `a / b` opened a regex, the scan would run to the next `/` and eat the
    // import — the silent-false-negative direction this must never take.
    const source = 'const half = total / 2;\nconst other = x / y;\nimport x from "pkg";\n';
    expect(blankComments(source)).toContain('import x from "pkg";');
  });

  it("blanks an unterminated block comment to the end of the file", () => {
    expect(blankComments('/* import x from "pkg";').trim()).toBe("");
  });
});

describe("importedPackages", () => {
  it("finds static, dynamic and require imports", () => {
    const source = [
      'import { a } from "alpha";',
      'export { b } from "@scope/beta";',
      'const c = await import("gamma/sub");',
      'const d = require("delta");',
    ].join("\n");
    expect([...importedPackages(source)].sort()).toEqual(["@scope/beta", "alpha", "delta", "gamma"]);
  });

  it("ignores relative, absolute and node: specifiers", () => {
    const source = 'import a from "./a.js";\nimport b from "/tmp/b.js";\nimport c from "node:fs";\n';
    expect([...importedPackages(source)]).toEqual([]);
  });

  it("ignores a require written inside a doc comment", () => {
    // The exact shape that blocked the publish.
    const source = [
      "/**",
      ' * ## Why this is not `require("<pkg>/package.json").version`',
      " */",
      "export const version = readVersion();",
    ].join("\n");
    expect([...importedPackages(source)]).toEqual([]);
  });

  it("ignores a real package name mentioned in a comment", () => {
    // PACKAGE_NAME_RE cannot catch this one; only blanking the comment does.
    const source = '// we used to require("lodash") here\nimport a from "alpha";';
    expect([...importedPackages(source)]).toEqual(["alpha"]);
  });

  it("ignores a specifier that cannot name a package", () => {
    expect([...importedPackages('const x = require("<pkg>");')]).toEqual([]);
  });

  it("still finds an import on the line after a comment", () => {
    const source = '// see below\nimport { sdk } from "@agentclientprotocol/sdk";';
    expect([...importedPackages(source)]).toEqual(["@agentclientprotocol/sdk"]);
  });

  it("still finds an import after a comment that mentions a quote", () => {
    const source = "// don't do this\nimport { sdk } from \"@agentclientprotocol/sdk\";";
    expect([...importedPackages(source)]).toEqual(["@agentclientprotocol/sdk"]);
  });
});
