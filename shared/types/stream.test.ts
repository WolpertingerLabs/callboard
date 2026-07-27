/**
 * Wire surface snapshot — the enforcement half of the append-only rules
 * documented at the top of `stream.ts`.
 *
 * The rules say the wire type is a published interface: fields are added, never
 * removed or renamed; optional never becomes required; new enum values are
 * gated. Prose alone doesn't catch an accidental break, so this test freezes a
 * machine-readable description of the wire types into a committed file
 * (`wire-surface.snapshot.json`) and fails when the description drifts.
 *
 * How the description is built: the two wire source files are parsed with the
 * TypeScript syntactic parser and reduced to field names, optionality, and
 * types — plus, for `protocol.ts`, the *runtime values* of the exported
 * constants, since the header names and capability strings are themselves part
 * of the wire. Doc comments are deliberately not part of the surface: comments
 * are leading trivia and `getText()` drops them, so a doc-comment edit cannot
 * make this test pass or fail.
 *
 * Why a snapshot isn't circular here: the description is derived from the types
 * (that's the point — it tracks them), but the *expectation* is a file in git.
 * A wire change therefore cannot land without a reviewable diff to
 * `wire-surface.snapshot.json` sitting next to it. Nothing regenerates the
 * expectation at run time; a missing snapshot file is a hard failure, not an
 * invitation to write one.
 *
 * The second describe block is the anti-vacuity proof. It mutates the real
 * `stream.ts` source in memory — one mutation per append-only violation — and
 * asserts each mutated surface no longer matches the committed snapshot. Each
 * mutation also asserts it actually changed the source text, so a mutation
 * whose search string goes stale fails loudly instead of quietly proving
 * nothing.
 *
 * To update after an intentional, reviewed wire change:
 *   UPDATE_WIRE_SNAPSHOT=1 npx vitest run shared/types/stream.test.ts
 * and commit the resulting diff.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as protocolModule from "./protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(HERE, "wire-surface.snapshot.json");

/** Files whose exported types make up the wire surface. */
const WIRE_FILES = ["stream.ts", "protocol.ts"] as const;

/** Emitted into the snapshot so a reader who opens the file knows what it is. */
const NOTE =
  "Generated description of callboard's wire type surface. Committed on purpose: " +
  "a change here means the client/server wire changed. See the append-only rules at " +
  "the top of shared/types/stream.ts, and stream.test.ts for how this is built and checked.";

/** A single interface member, reduced to the parts that are visible on the wire. */
type FieldShape =
  | { optional: boolean; type: string | string[] }
  /** Anything that isn't a plain property (index signature, method, …) — kept verbatim so it can't vanish silently. */
  | { raw: string };

interface FileSurface {
  /** Every exported name in the file, so a new exported enum/const shows up even if its body isn't described below. */
  exports: string[];
  interfaces: Record<string, Record<string, FieldShape>>;
  typeAliases: Record<string, string | string[]>;
}

interface WireSurface {
  note: string;
  types: Record<string, FileSurface>;
  constants: Record<string, Record<string, unknown>>;
}

/** Collapse whitespace so reformatting a type across lines isn't a "change". */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isExported(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function sortKeys<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * String-literal types — the enum values that actually travel on the wire —
 * become a sorted array, so adding a `type` value is a one-line diff rather
 * than a rewritten string. Returns null for anything else.
 */
function stringLiteralValues(node: ts.TypeNode): string[] | null {
  const members = ts.isUnionTypeNode(node) ? [...node.types] : [node];
  const values: string[] = [];
  for (const member of members) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) return null;
    values.push(member.literal.text);
  }
  return values.sort();
}

function describeTypeNode(node: ts.TypeNode): string | string[] {
  const literals = stringLiteralValues(node);
  if (literals) return literals;
  if (ts.isUnionTypeNode(node)) {
    return node.types
      .map((member) => normalize(member.getText()))
      .sort()
      .join(" | ");
  }
  return normalize(node.getText());
}

function describeMembers(members: ts.NodeArray<ts.TypeElement>): Record<string, FieldShape> {
  const fields: Record<string, FieldShape> = {};
  for (const member of members) {
    if (ts.isPropertySignature(member) && member.type) {
      fields[member.name.getText()] = {
        optional: member.questionToken !== undefined,
        type: describeTypeNode(member.type),
      };
    } else {
      // Not a plain typed property. Record it raw rather than dropping it —
      // a hole in the extractor is how a snapshot test stops being one.
      fields[normalize(member.name?.getText() ?? "(unnamed)")] = { raw: normalize(member.getText()) };
    }
  }
  return sortKeys(fields);
}

/** Reduce one wire source file to its exported type surface. */
function describeSource(fileName: string, sourceText: string): FileSurface {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const surface: FileSurface = { exports: [], interfaces: {}, typeAliases: {} };

  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && isExported(statement)) {
      surface.exports.push(statement.name.text);
      surface.interfaces[statement.name.text] = describeMembers(statement.members);
    } else if (ts.isTypeAliasDeclaration(statement) && isExported(statement)) {
      surface.exports.push(statement.name.text);
      surface.typeAliases[statement.name.text] = describeTypeNode(statement.type);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (isExported(declaration)) surface.exports.push(declaration.name.getText());
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) && isExported(statement)) {
      if (statement.name) surface.exports.push(statement.name.text);
    }
  }

  surface.exports.sort();
  surface.interfaces = sortKeys(surface.interfaces);
  surface.typeAliases = sortKeys(surface.typeAliases);
  return surface;
}

/**
 * The runtime values `protocol.ts` publishes. Header names and capability
 * strings are wire bytes, not implementation detail — both sides must agree on
 * them exactly — so their values belong in the snapshot alongside the shapes.
 */
function describeProtocolConstants(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(protocolModule)) {
    values[name] = typeof value === "function" ? { "(returns)": (value as () => unknown)() } : value;
  }
  return sortKeys(values);
}

function buildWireSurface(): WireSurface {
  const types: Record<string, FileSurface> = {};
  for (const file of WIRE_FILES) {
    types[file] = describeSource(file, fs.readFileSync(path.join(HERE, file), "utf8"));
  }
  return { note: NOTE, types, constants: { "protocol.ts": describeProtocolConstants() } };
}

function readCommittedSnapshot(): WireSurface {
  if (!fs.existsSync(SNAPSHOT_PATH)) {
    throw new Error(
      `Missing committed wire snapshot at ${SNAPSHOT_PATH}. It is tracked in git and must not be regenerated ` +
        `blindly — restore it (git checkout) rather than recreating it, or the test proves nothing.`,
    );
  }
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8")) as WireSurface;
}

describe("wire surface snapshot", () => {
  it("matches the committed snapshot", () => {
    const actual = buildWireSurface();

    if (process.env.UPDATE_WIRE_SNAPSHOT === "1") {
      fs.writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    }

    expect(
      actual,
      "The wire type surface changed. If the change is append-only (a new optional field, or a new enum " +
        "value gated behind a capability), re-run with UPDATE_WIRE_SNAPSHOT=1 and commit the snapshot diff. " +
        "If it removes or renames a field, makes an optional field required, or changes a field's meaning or " +
        "type, it breaks clients already in the wild — see the rules at the top of shared/types/stream.ts.",
    ).toEqual(readCommittedSnapshot());
  });

  it("describes a real surface, not an empty one", () => {
    // Guards the extractor itself: if parsing silently produced nothing, the
    // comparison above would still be "green" against a regenerated snapshot.
    const surface = buildWireSurface().types["stream.ts"];
    const streamEvent = surface.interfaces["StreamEvent"];

    expect(streamEvent, "StreamEvent not found in stream.ts").toBeDefined();
    expect(Object.keys(streamEvent).length).toBeGreaterThan(5);
    expect(streamEvent["type"]).toEqual({ optional: false, type: expect.arrayContaining(["text", "done", "error"]) });
  });
});

/**
 * One entry per append-only violation the rules forbid. Each rewrites the real
 * `stream.ts` source in memory and must produce a surface the committed
 * snapshot rejects.
 */
const VIOLATIONS: { label: string; mutate: (source: string) => string }[] = [
  {
    label: "a field is removed",
    mutate: (source) => source.replace("  costUsd?: number;\n", ""),
  },
  {
    label: "a field is renamed",
    mutate: (source) => source.replace("  costUsd?: number;", "  costUSD?: number;"),
  },
  {
    label: "an optional field becomes required",
    mutate: (source) => source.replace("  costUsd?: number;", "  costUsd: number;"),
  },
  {
    label: "a new type union value is added",
    mutate: (source) => source.replace(`    | "auto_recovery";`, `    | "auto_recovery"\n    | "workspace_ready";`),
  },
  {
    label: "a field's type changes",
    mutate: (source) => source.replace("  costUsd?: number;", "  costUsd?: string;"),
  },
];

describe("the snapshot rejects append-only violations", () => {
  const original = fs.readFileSync(path.join(HERE, "stream.ts"), "utf8");

  for (const { label, mutate } of VIOLATIONS) {
    it(`fails when ${label}`, () => {
      const mutated = mutate(original);

      // A mutation whose search text has drifted would silently no-op and this
      // case would "pass" while testing nothing. Check the edit happened.
      expect(mutated, `mutation for "${label}" no longer matches stream.ts and edited nothing`).not.toBe(original);

      const committed = readCommittedSnapshot().types["stream.ts"];
      expect(describeSource("stream.ts", mutated)).not.toEqual(committed);
    });
  }

  it("passes on the unmutated source, so the rejections above mean something", () => {
    expect(describeSource("stream.ts", original)).toEqual(readCommittedSnapshot().types["stream.ts"]);
  });
});
