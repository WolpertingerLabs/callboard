/**
 * ACP and Cline record the user's turn themselves, and so record its images
 * too, as image-store ids. Without them a turn sent with only images shows as
 * nothing (Cline) or as `[image …]` text after the attachment blocks (ACP),
 * which `splitAttachmentBlocks` cannot split and the optimistic bubble cannot
 * match.
 *
 * DATA_DIR is redirected before the dynamic imports: interning writes to the
 * image store.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAttachmentBlocks, formatAttachmentBlock, splitAttachmentBlocks } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-user-turn-images-"));
process.env.CALLBOARD_DATA_DIR = dataDir;

const { userMessageOf } = await import("./acp/AcpAgentQuery.js");
const { AcpTranscriptWriter } = await import("./acp/transcript.js");
const { findAcpTranscript, parseAcpTranscript } = await import("./acp/sessionParser.js");
const { internDataUris } = await import("./cline/ClineAgentQuery.js");
const { ImageStorageService } = await import("../../services/image-storage.js");

afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const PNG = Buffer.from("png-bytes").toString("base64");
const block = formatAttachmentBlock({ id: "f1", name: "notes.md", path: "/d/f1_notes.md", size: 2, mimeType: "text/markdown" }, { content: "hi" });
const stored = () => readdirSync(join(dataDir, "images"));

describe("ACP userMessageOf", () => {
  it("keeps the attachment blocks last and records the image by its upload id", async () => {
    const upload = (await ImageStorageService.storeImage(Buffer.from("png-bytes"), "shot.png", "image/png")).image!.id;
    const text = appendAttachmentBlocks("look", [block]);
    const user = userMessageOf([
      { type: "text", text },
      { type: "image", data: PNG, mimeType: "image/png" },
    ]);
    expect(user.imageIds).toEqual([upload]);
    expect(user.content).toBe(text);
    expect(splitAttachmentBlocks(user.content)).toMatchObject({ text: "look", files: [{ name: "notes.md" }] });
  });

  it("puts any other non-text block ahead of the text", () => {
    const text = appendAttachmentBlocks("", [block]);
    const user = userMessageOf([
      { type: "text", text },
      { type: "resource_link", uri: "file:///x", name: "x" },
    ]);
    expect(user.content).toBe(`[resource_link file:///x]\n${text}`);
    expect(splitAttachmentBlocks(user.content).files).toHaveLength(1);
  });

  it("round-trips an image-only turn through the transcript as empty text with its image", () => {
    const user = userMessageOf([{ type: "image", data: Buffer.from("only-image").toString("base64"), mimeType: "image/png" }]);
    expect(user.content).toBe("");
    const writer = new AcpTranscriptWriter("opencode", "img-only", "/work");
    writer.writeHeader(null);
    writer.writeUserMessage(user.content, user.imageIds);
    const [turn] = parseAcpTranscript(findAcpTranscript("img-only")!.filePath);
    expect(turn).toMatchObject({ role: "user", type: "text", content: "", imageIds: user.imageIds });
    expect(stored().some((f) => f.startsWith(user.imageIds[0]))).toBe(true);
  });
});

describe("Cline internDataUris", () => {
  it("interns data URIs, deduped, and ignores anything else", () => {
    const uri = `data:image/png;base64,${Buffer.from("cline-image").toString("base64")}`;
    const ids = internDataUris([uri, uri, "https://example.com/x.png"]);
    expect(ids).toHaveLength(1);
    expect(stored().some((f) => f.startsWith(ids[0]))).toBe(true);
  });
});
