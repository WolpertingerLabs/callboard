/**
 * Exhaustive coverage of the one branch every session passes through.
 *
 * Two regressions are worth naming, because both are silent:
 *  - a session that owes nothing must break, or it re-prompts itself forever;
 *  - an open condition watch must nudge even when requireExplicitCompletion is
 *    false, since any session can open one.
 */
import { describe, it, expect } from "vitest";
import { decideNudge, type NudgeInputs } from "./nudge-decision.js";

/** A session that is finished and owes nothing. */
const base: NudgeInputs = {
  requireCompletion: false,
  objectiveSatisfied: false,
  watchOpen: false,
  nudgesUsed: 0,
  maxNudges: 3,
  aborted: false,
  errored: false,
  endReason: undefined,
  isClear: false,
  completionToolName: "objective_complete",
  isJobStepSession: false,
};

const owingObjective: NudgeInputs = { ...base, requireCompletion: true, objectiveSatisfied: false };
const owingCondition: NudgeInputs = { ...base, watchOpen: true, watchText: "CI finishes", watchAttempts: 3, watchMaxAttempts: 20 };

describe("no obligation", () => {
  it("breaks when the session owes nothing", () => {
    expect(decideNudge(base)).toEqual({ action: "break" });
  });

  it("breaks when the objective is required and satisfied", () => {
    expect(decideNudge({ ...owingObjective, objectiveSatisfied: true })).toEqual({ action: "break" });
  });

  it("breaks when completion is not required and no watch is open", () => {
    // The historic fast path: a plain chat never nudges.
    expect(decideNudge({ ...base, objectiveSatisfied: false })).toEqual({ action: "break" });
  });
});

describe("hard terminations win over every obligation", () => {
  for (const [label, override] of [
    ["user abort", { aborted: true }],
    ["provider error", { errored: true }],
    ["a hard cap already set endReason", { endReason: "max_turns" }],
    ["/clear", { isClear: true }],
  ] as const) {
    it(`breaks on ${label} even when both obligations are open`, () => {
      const both = { ...owingObjective, ...owingCondition, requireCompletion: true, watchOpen: true, ...override };
      expect(decideNudge(both)).toEqual({ action: "break" });
    });
  }
});

describe("objective obligation", () => {
  it("nudges with the historic wording", () => {
    const decision = decideNudge(owingObjective);
    expect(decision.action).toBe("nudge");
    if (decision.action !== "nudge") return;
    expect(decision.obligations).toEqual(["objective"]);
    expect(decision.text).toContain("objective_complete");
    expect(decision.text).toContain("requires explicit completion");
    expect(decision.text).toContain("(optionally with a message and result data)");
  });

  it("omits the result-data aside for job steps", () => {
    const decision = decideNudge({ ...owingObjective, isJobStepSession: true, completionToolName: "complete_job_step" });
    expect(decision.action).toBe("nudge");
    if (decision.action !== "nudge") return;
    expect(decision.text).toContain("complete_job_step");
    expect(decision.text).not.toContain("(optionally with a message and result data)");
  });

  it("gives up as objective_incomplete at the cap", () => {
    expect(decideNudge({ ...owingObjective, nudgesUsed: 3, maxNudges: 3 })).toEqual({
      action: "giveUp",
      endReason: "objective_incomplete",
      obligations: ["objective"],
    });
  });
});

describe("condition obligation", () => {
  it("nudges even when explicit completion is NOT required", () => {
    // The asymmetry that makes this feature work: any session can open a
    // watch, so the watch cannot ride on requireCompletion.
    const decision = decideNudge(owingCondition);
    expect(decision.action).toBe("nudge");
    if (decision.action !== "nudge") return;
    expect(decision.obligations).toEqual(["condition"]);
    expect(decision.text).toContain('"CI finishes"');
    expect(decision.text).toContain("attempt 3 of 20");
    expect(decision.text).toContain("wait_condition_met");
    expect(decision.text).toContain("satisfied: false");
  });

  it("falls back to generic wording when the watch text is unknown", () => {
    const decision = decideNudge({ ...base, watchOpen: true });
    expect(decision.action).toBe("nudge");
    if (decision.action !== "nudge") return;
    expect(decision.text).toContain("an external condition");
    expect(decision.text).not.toContain("attempt");
  });

  it("gives up as condition_unresolved at the cap", () => {
    expect(decideNudge({ ...owingCondition, nudgesUsed: 3, maxNudges: 3 })).toEqual({
      action: "giveUp",
      endReason: "condition_unresolved",
      obligations: ["condition"],
    });
  });

  it("does not nudge for a satisfied objective when only the watch is open", () => {
    const decision = decideNudge({ ...owingCondition, requireCompletion: true, objectiveSatisfied: true });
    expect(decision.action).toBe("nudge");
    if (decision.action !== "nudge") return;
    expect(decision.obligations).toEqual(["condition"]);
    expect(decision.text).not.toContain("requires explicit completion");
  });
});

describe("both obligations", () => {
  const both: NudgeInputs = { ...owingCondition, requireCompletion: true, objectiveSatisfied: false };

  it("nudges once, naming both", () => {
    const decision = decideNudge(both);
    expect(decision.action).toBe("nudge");
    if (decision.action !== "nudge") return;
    expect(decision.obligations).toEqual(["objective", "condition"]);
    expect(decision.text).toContain("requires explicit completion");
    expect(decision.text).toContain("wait_condition_met");
  });

  it("prefers the historic endReason at the cap", () => {
    // objective_incomplete is what existing consumers have always seen for a
    // session that owed its objective; a co-occurring watch must not change it.
    expect(decideNudge({ ...both, nudgesUsed: 5, maxNudges: 5 })).toMatchObject({
      action: "giveUp",
      endReason: "objective_incomplete",
      obligations: ["objective", "condition"],
    });
  });
});

describe("nudge budget", () => {
  it("nudges up to the cap and gives up on reaching it", () => {
    expect(decideNudge({ ...owingObjective, nudgesUsed: 0, maxNudges: 2 }).action).toBe("nudge");
    expect(decideNudge({ ...owingObjective, nudgesUsed: 1, maxNudges: 2 }).action).toBe("nudge");
    expect(decideNudge({ ...owingObjective, nudgesUsed: 2, maxNudges: 2 }).action).toBe("giveUp");
  });

  it("gives up immediately when nudging is disabled", () => {
    expect(decideNudge({ ...owingObjective, nudgesUsed: 0, maxNudges: 0 }).action).toBe("giveUp");
  });
});
