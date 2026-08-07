/**
 * Nudge decision — what to do when a session's message stream ends.
 *
 * Extracted from the query loop in `claude.ts` because this is the one branch
 * in that file every single session passes through, and getting it wrong is
 * expensive in both directions: nudge when you shouldn't and a finished
 * session re-prompts itself in a loop; fail to nudge and a session that owes
 * the user something quietly stops. It is pure so it can be tested exhaustively
 * without standing up a provider.
 *
 * ## Obligations
 *
 * A session may end its turn owing up to two different things:
 *
 * - **objective** — the session was started with `requireExplicitCompletion`
 *   and has not called its completion tool (`objective_complete`, or for job
 *   steps a recorded `pendingResult` from `complete_job_step`). This is
 *   session-terminal: it is the answer to "are you done?".
 * - **condition** — the session opened a condition watch via
 *   `wait(require_condition)` and neither resolved it with
 *   `wait_condition_met` nor kept polling. This is loop-scoped and can recur
 *   many times within one session.
 *
 * They are deliberately separate. Sharing one flag would let a session with
 * `requireExplicitCompletion` satisfy its terminal obligation by closing a
 * poll, and then end with the real objective untouched.
 *
 * Note the asymmetry: an open condition watch nudges **regardless** of
 * `requireCompletion`, because any session can open one. That is why the
 * hard-termination guards below run before the obligation check rather than
 * after `requireCompletion`, as they did when the objective was the only
 * obligation.
 */

export type NudgeObligation = "objective" | "condition";

export interface NudgeInputs {
  /** Session was started with requireExplicitCompletion. */
  requireCompletion: boolean;
  /** The completion tool has been called (or a job step recorded a result). */
  objectiveSatisfied: boolean;
  /** A condition watch is open for this session. */
  watchOpen: boolean;
  watchText?: string;
  watchAttempts?: number;
  watchMaxAttempts?: number;
  nudgesUsed: number;
  maxNudges: number;
  /** The user cancelled the run. */
  aborted: boolean;
  /** The provider reported an error. */
  errored: boolean;
  /** A hard cap already ended the run (max_turns / max_budget / …). */
  endReason?: string | undefined;
  /** The prompt was the `/clear` builtin. */
  isClear: boolean;
  /** Name of the completion tool this session should call. */
  completionToolName: string;
  isJobStepSession: boolean;
}

export type NudgeDecision =
  | { action: "break" }
  | { action: "giveUp"; endReason: string; obligations: NudgeObligation[] }
  | { action: "nudge"; text: string; obligations: NudgeObligation[] };

/** The objective half of the nudge, worded as it always has been. */
function objectiveText(i: NudgeInputs): string {
  return (
    `Your previous turn ended without calling the ${i.completionToolName} tool, but this session requires explicit completion. ` +
    `If the objective is fully achieved, call ${i.completionToolName} now${i.isJobStepSession ? "" : " (optionally with a message and result data)"}. ` +
    `Otherwise, continue working toward the objective.`
  );
}

/** The condition half — always names the concrete escape routes. */
function conditionText(i: NudgeInputs): string {
  const what = i.watchText ? `"${i.watchText}"` : "an external condition";
  const attempt = i.watchAttempts && i.watchMaxAttempts ? ` (attempt ${i.watchAttempts} of ${i.watchMaxAttempts})` : "";
  return (
    `Your previous turn ended with an open condition watch on ${what}${attempt}. ` +
    `If the condition is satisfied, call wait_condition_met. If it is not, call wait again with the same require_condition to keep polling. ` +
    `If you have given up on it, call wait_condition_met with satisfied: false.`
  );
}

/**
 * Decide whether the loop breaks, nudges, or gives up.
 *
 * Hard terminations win over every obligation: a user abort, a provider error,
 * an already-set `endReason` (a hard cap) and `/clear` all end the run exactly
 * as they did before this function existed.
 */
export function decideNudge(i: NudgeInputs): NudgeDecision {
  if (i.aborted || i.errored || i.endReason) return { action: "break" };
  if (i.isClear) return { action: "break" };

  const obligations: NudgeObligation[] = [];
  if (i.requireCompletion && !i.objectiveSatisfied) obligations.push("objective");
  if (i.watchOpen) obligations.push("condition");

  if (obligations.length === 0) return { action: "break" };

  if (i.nudgesUsed >= i.maxNudges) {
    // Preserve the historic reason whenever the objective is in play; the
    // condition-only case gets its own so a log or a client can tell the two
    // apart. `reason` is a free-form string on the wire and nothing switches
    // on it, so this adds a value without changing any existing meaning.
    return {
      action: "giveUp",
      endReason: obligations.includes("objective") ? "objective_incomplete" : "condition_unresolved",
      obligations,
    };
  }

  const parts: string[] = [];
  if (obligations.includes("objective")) parts.push(objectiveText(i));
  if (obligations.includes("condition")) parts.push(conditionText(i));

  return { action: "nudge", text: parts.join("\n\n"), obligations };
}
