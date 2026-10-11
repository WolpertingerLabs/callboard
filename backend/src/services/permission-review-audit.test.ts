/**
 * The decision-path input copy in permission-review-audit.ts: whole inputs are
 * copied exactly, large ones are cut to the record's string limit WITHOUT
 * serializing all of them, and the record says which happened.
 */
import { describe, expect, it } from "vitest";
import { MAX_STRING_BYTES, type AuditRecordInput } from "./audit-log.js";
import { MAX_INPUT_DEPTH, MAX_INPUT_ENTRIES, REVIEW_REQUESTED_EVENT, serializeInput, startReviewAudit } from "./permission-review-audit.js";

function requestedRecordFor(input: Record<string, unknown>): Promise<AuditRecordInput> {
  return new Promise((resolve) => {
    startReviewAudit({
      hooks: {
        getCallerAlias: () => "c",
        emit: (_alias, build) => {
          const r = build();
          if (r.eventName === REVIEW_REQUESTED_EVENT) resolve(r);
        },
      },
      screen: "model",
      chatId: "chat-1",
      toolName: "Write",
      toolUseId: undefined,
      input,
      category: "fileWrite",
      cwd: "/repo",
      settings: { modelReview: true, parentAnswers: false },
      settingsFallback: false,
    });
  });
}

describe("tool.input on the requested record", () => {
  it("a whole input is stored exactly, with its size and no truncated flag", async () => {
    const input = { file_path: "/repo/a.ts", content: "export const x = 1;\n" };
    const r = await requestedRecordFor(input);
    expect(r.attributes["tool.input"]).toBe(JSON.stringify(input));
    expect(r.attributes["tool.input.bytes"]).toBe(Buffer.byteLength(JSON.stringify(input)));
    expect(r.attributes["tool.input.truncated"]).toBeUndefined();
  });

  it("an input over the limit is cut, flagged truncated, and its full size omitted", async () => {
    const r = await requestedRecordFor({ file_path: "/repo/big.txt", content: "x".repeat(100_000) });
    expect(r.attributes["tool.input.truncated"]).toBe(true);
    expect(r.attributes["tool.input.bytes"]).toBeUndefined();
    const json = r.attributes["tool.input"] as string;
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_STRING_BYTES);
    expect(json.startsWith('{"file_path":"/repo/big.txt","content":"xxxx')).toBe(true);
    expect(json).toContain("…[truncated]");
  });
});

describe("serializeInput", () => {
  it.each([
    ["plain", { command: "npm test", description: "run tests" }],
    ["nested", { a: { b: [1, "two", true, null, { c: 3.5 }] } }],
    ["drops undefined/functions like JSON", { a: undefined, f: () => 1, keep: 1, arr: [undefined, () => 2] }],
    ["Date via toJSON", { when: new Date(0) }],
    ["unicode", { s: "héllo — ✓ 🎉" }],
    ["empty", {}],
  ])("matches JSON.stringify for a small input (%s)", (_name, input) => {
    expect(serializeInput(input)).toEqual({ json: JSON.stringify(input), bytes: Buffer.byteLength(JSON.stringify(input)), truncated: false });
  });

  it("does not read past the entry cap of a huge array (bounded work, not a full serialize)", () => {
    let reads = 0;
    const huge = new Proxy(new Array(10_000_000), {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
        return Reflect.get(target, prop, receiver);
      },
    });
    const out = serializeInput({ items: huge });
    expect(out.truncated).toBe(true);
    expect(reads).toBeLessThanOrEqual(MAX_INPUT_ENTRIES);
  });

  it("does not read past the budget of many large fields", () => {
    let reads = 0;
    const fields: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) {
      Object.defineProperty(fields, `f${i}`, {
        enumerable: true,
        get: () => {
          reads++;
          return "y".repeat(10_000);
        },
      });
    }
    const out = serializeInput(fields);
    expect(out.truncated).toBe(true);
    // 16 KiB of budget holds two 10 KB strings at most; the rest are never read.
    expect(reads).toBeLessThanOrEqual(3);
  });

  it("caps nesting depth without recursing to the bottom", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 100_000; i++) deep = { d: deep };
    const out = serializeInput(deep);
    expect(out.truncated).toBe(true);
    expect((out.json.match(/"d"/g) ?? []).length).toBeLessThanOrEqual(MAX_INPUT_DEPTH);
  });

  it("a throwing getter is replaced and the copy flagged as not exact", () => {
    const input = {
      ok: 1,
      get bad(): never {
        throw new Error("no");
      },
    };
    const out = serializeInput(input);
    expect(JSON.parse(out.json)).toEqual({ ok: 1, bad: "[unreadable]" });
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBeUndefined();
  });

  it("a throwing toJSON is replaced and the copy flagged as not exact", () => {
    const out = serializeInput({
      when: {
        toJSON() {
          throw new Error("no");
        },
      },
    });
    expect(JSON.parse(out.json)).toEqual({ when: "[unreadable]" });
    expect(out.truncated).toBe(true);
  });

  it("an object past the key cap is cut and flagged", () => {
    const input: Record<string, number> = {};
    for (let i = 0; i < MAX_INPUT_ENTRIES + 1; i++) input[`k${i}`] = i;
    const out = serializeInput(input);
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBeUndefined();
    const parsed = JSON.parse(out.json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(MAX_INPUT_ENTRIES + 1); // 256 keys + the cut marker
    expect(parsed).not.toHaveProperty(`k${MAX_INPUT_ENTRIES}`);
  });

  it("an object exactly at the key cap is whole", () => {
    const input: Record<string, number> = {};
    for (let i = 0; i < MAX_INPUT_ENTRIES; i++) input[`k${i}`] = i;
    expect(serializeInput(input)).toEqual({ json: JSON.stringify(input), bytes: JSON.stringify(input).length, truncated: false });
  });

  it("keys JSON drops are skipped without a false cut — past the key cap or past the budget", () => {
    const atCap: Record<string, unknown> = {};
    for (let i = 0; i < MAX_INPUT_ENTRIES; i++) atCap[`k${i}`] = i;
    atCap.u = undefined;
    atCap.f = () => 1;
    expect(serializeInput(atCap)).toEqual({ json: JSON.stringify(atCap), bytes: JSON.stringify(atCap).length, truncated: false });

    // A string that spends the whole budget without being cut, then a function.
    const budget = MAX_STRING_BYTES - 1024 - ("a".length + 4);
    const spent = { a: "x".repeat(budget), f: () => 1, s: Symbol("x") };
    const out = serializeInput(spent);
    expect(out.truncated).toBe(false);
    expect(out.json).toBe(JSON.stringify(spent));
  });

  it("never visits inherited keys", () => {
    let reads = 0;
    const proto: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      Object.defineProperty(proto, `p${i}`, {
        enumerable: true,
        get: () => {
          reads++;
          return i;
        },
      });
    }
    const input = Object.create(proto) as Record<string, unknown>;
    input.own = 1;
    expect(serializeInput(input)).toEqual({ json: '{"own":1}', bytes: 9, truncated: false });
    expect(reads).toBe(0);
  });

  it("stays within the byte limit when escaping and multi-byte characters inflate it", () => {
    const out = serializeInput({ s: '"\n'.repeat(20_000), u: "🎉".repeat(20_000) });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.json)).toBeLessThanOrEqual(MAX_STRING_BYTES);
  });
});
