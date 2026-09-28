/**
 * Artifact service: slug ids, immutable versions, the 50-version cap, the
 * 5MB source limit, and upsert/create/append modes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA = mkdtempSync(join(tmpdir(), "callboard-artifact-svc-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const svc = await import("./artifact-service.js");
const { StorageError } = await import("./storage-service.js");
const { ARTIFACTS_ROOT, ARTIFACT_MAX_SOURCE_BYTES, ARTIFACT_MAX_VERSIONS } = svc;

async function expectCode(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(StorageError);
    expect((err as InstanceType<typeof StorageError>).code).toBe(code);
    return err as Error;
  }
  throw new Error(`expected StorageError(${code}), got success`);
}

beforeEach(() => rmSync(ARTIFACTS_ROOT, { recursive: true, force: true }));

describe("artifact ids", () => {
  it("accepts slugs and rejects everything else, at every entry point", async () => {
    for (const id of ["cramhouse", "a", "a-1-b", "0", "x".repeat(64)]) expect(() => svc.assertArtifactId(id)).not.toThrow();
    for (const bad of ["", "-a", "A", "a_b", "a.b", "..", ".", "a/b", "a\\b", "a\0", "x".repeat(65), "а", "cramhouse\n"]) {
      expect(() => svc.assertArtifactId(bad), JSON.stringify(bad)).toThrow(StorageError);
      await expectCode(svc.saveArtifact({ id: bad, name: "n", contentType: "html", content: "x" }), "invalid");
      await expectCode(() => svc.getArtifact(bad), "invalid");
      await expectCode(() => svc.readArtifactVersion(bad), "invalid");
      await expectCode(svc.deleteArtifact(bad), "invalid");
    }
    expect(existsSync(ARTIFACTS_ROOT) ? readdirSync(ARTIFACTS_ROOT) : []).toEqual([]);
  });
});

describe("versions", () => {
  it("creates v1, appends immutable versions, and reads any kept one", async () => {
    const created = await svc.saveArtifact({ id: "app", name: "App", contentType: "html", content: "<p>1</p>", storageAccess: "read", note: "first" });
    expect(created.created).toBe(true);
    expect(created.artifact).toMatchObject({ id: "app", name: "App", contentType: "html", storageAccess: "read", currentVersion: 1 });
    expect(created.version).toMatchObject({ version: 1, note: "first", size: 8 });
    const v2 = await svc.saveArtifact({ id: "app", content: "<p>2</p>" });
    expect(v2).toMatchObject({ created: false, version: { version: 2 } });
    expect(svc.readArtifactVersion("app", 1).content).toBe("<p>1</p>");
    expect(svc.readArtifactVersion("app").content).toBe("<p>2</p>");
    expect(readFileSync(join(ARTIFACTS_ROOT, "app", "versions", "1.html"), "utf-8")).toBe("<p>1</p>");
    await expectCode(() => svc.readArtifactVersion("app", 3), "not_found");
  });

  it("uses the content type's extension on disk", async () => {
    await svc.saveArtifact({ id: "pic", name: "Pic", contentType: "svg", content: "<svg/>" });
    await svc.saveArtifact({ id: "doc", name: "Doc", contentType: "markdown", content: "# hi" });
    expect(readdirSync(join(ARTIFACTS_ROOT, "pic", "versions"))).toEqual(["1.svg"]);
    expect(readdirSync(join(ARTIFACTS_ROOT, "doc", "versions"))).toEqual(["1.md"]);
  });

  it(`keeps only the last ${ARTIFACT_MAX_VERSIONS} versions and prunes their files`, async () => {
    await svc.saveArtifact({ id: "many", name: "Many", contentType: "markdown", content: "v1" });
    for (let i = 2; i <= ARTIFACT_MAX_VERSIONS + 2; i++) await svc.saveArtifact({ id: "many", content: `v${i}` });
    const artifact = svc.getArtifact("many");
    expect(artifact.currentVersion).toBe(ARTIFACT_MAX_VERSIONS + 2);
    expect(artifact.versions).toHaveLength(ARTIFACT_MAX_VERSIONS);
    expect(artifact.versions[0].version).toBe(3);
    const files = readdirSync(join(ARTIFACTS_ROOT, "many", "versions"));
    expect(files).toHaveLength(ARTIFACT_MAX_VERSIONS);
    expect(files).not.toContain("1.md");
    expect(files).not.toContain("2.md");
    await expectCode(() => svc.readArtifactVersion("many", 1), "not_found");
    expect(svc.readArtifactVersion("many", 3).content).toBe("v3");
  });

  it("serializes concurrent saves: every version number is minted once", async () => {
    await svc.saveArtifact({ id: "race", name: "Race", contentType: "markdown", content: "v1" });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => svc.saveArtifact({ id: "race", content: `c${i}` })));
    expect(new Set(results.map((r) => r.version.version)).size).toBe(20);
    expect(svc.getArtifact("race").currentVersion).toBe(21);
  });
});

describe("rules", () => {
  it(`source ≤ ${ARTIFACT_MAX_SOURCE_BYTES / 1024 / 1024}MB (utf-8 bytes), checked before writing`, async () => {
    await expectCode(svc.saveArtifact({ id: "big", name: "Big", contentType: "html", content: "é".repeat(ARTIFACT_MAX_SOURCE_BYTES / 2 + 1) }), "limit");
    expect(existsSync(join(ARTIFACTS_ROOT, "big"))).toBe(false);
    await svc.saveArtifact({ id: "big", name: "Big", contentType: "html", content: "x".repeat(ARTIFACT_MAX_SOURCE_BYTES) });
  });

  it("name and content_type are required on create; content_type cannot change", async () => {
    await expectCode(svc.saveArtifact({ id: "n", contentType: "html", content: "x" }), "invalid");
    await expectCode(svc.saveArtifact({ id: "n", name: "N", content: "x" }), "invalid");
    await svc.saveArtifact({ id: "n", name: "N", contentType: "html", content: "x" });
    await expectCode(svc.saveArtifact({ id: "n", contentType: "svg", content: "y" }), "invalid");
    await svc.saveArtifact({ id: "n", contentType: "html", content: "y" });
    await expectCode(svc.saveArtifact({ id: "n", name: "N", contentType: "bogus" as never, content: "x" }), "invalid");
    await expectCode(svc.saveArtifact({ id: "n", storageAccess: "admin" as never, content: "x" }), "invalid");
  });

  it("create and append modes are exclusive", async () => {
    await expectCode(svc.saveArtifact({ id: "m", content: "x" }, "append"), "not_found");
    await svc.saveArtifact({ id: "m", name: "M", contentType: "html", content: "x" }, "create");
    await expectCode(svc.saveArtifact({ id: "m", name: "M", contentType: "html", content: "x" }, "create"), "conflict");
  });

  it("updates metadata without minting a version, and deletes", async () => {
    await svc.saveArtifact({ id: "u", name: "U", contentType: "html", content: "x", description: "d" });
    const updated = await svc.updateArtifact("u", { name: "U2", description: "", storageAccess: "readwrite" });
    expect(updated).toMatchObject({ name: "U2", storageAccess: "readwrite", currentVersion: 1 });
    expect(updated.description).toBeUndefined();
    await expectCode(svc.updateArtifact("u", { name: "  " }), "invalid");
    expect(svc.listArtifacts().map((a) => a.id)).toEqual(["u"]);
    expect(svc.listArtifacts()[0]).not.toHaveProperty("versions");
    await svc.deleteArtifact("u");
    expect(svc.listArtifacts()).toEqual([]);
    await expectCode(svc.deleteArtifact("u"), "not_found");
  });

  it("saves from a source_path with render_file's checks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "callboard-art-src-"));
    const file = join(dir, "app.html");
    writeFileSync(file, "<h1>from file</h1>");
    await expectCode(svc.saveArtifactFromFile({ id: "f", name: "F", contentType: "html", sourcePath: "app.html" }), "invalid");
    await expectCode(svc.saveArtifactFromFile({ id: "f", name: "F", contentType: "html", sourcePath: dir }), "invalid");
    await svc.saveArtifactFromFile({ id: "f", name: "F", contentType: "html", sourcePath: file });
    expect(svc.readArtifactVersion("f").content).toBe("<h1>from file</h1>");
  });
});
