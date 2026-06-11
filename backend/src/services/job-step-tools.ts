/**
 * Job step tools — the MCP server injected ONLY into job-step sessions
 * (sessions spawned by the job runner with a jobContext).
 *
 * complete_job_step is how a step session reports structured results back to
 * the deterministic runner: it persists a pendingResult onto the run file,
 * which the runner harvests when the session ends. Writing to the store
 * (rather than calling the runner) keeps this module dependency-free of the
 * runner and makes the report durable across a backend restart.
 */
import { z } from "zod";
import { defineTool } from "../agents/ports/tools.js";
import type { ToolServerSpec } from "../agents/ports/tools.js";
import { recordStepResult } from "./job-store.js";
import type { JobContext } from "./job-runner.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("job-step-tools");

export function buildJobStepToolsSpec(getJobContext: () => JobContext | undefined): ToolServerSpec {
  return {
    name: "job-tools",
    version: "1.0.0",
    tools: [
      defineTool(
        "complete_job_step",
        "Report the result of the job step this session is running. This session is one step of a deterministic job run — " +
          "the job runner harvests what you report here when the session ends, and uses it to decide the next step. " +
          "Call this exactly once, as the LAST thing you do. For steps with declared outputs, every declared key must be present " +
          "in `outputs`. For poll/checker steps, set `verdict` to \"done\" or \"not_yet\". You may call it again before the " +
          "session ends to overwrite an earlier report.",
        {
          outputs: z
            .record(z.string(), z.any())
            .optional()
            .describe("Structured outputs for this step (keyed values that later steps reference as {{steps.<id>.outputs.<key>}})"),
          verdict: z.string().optional().describe('For poll steps: "done" or "not_yet". For review-style steps: e.g. "pass" / "fail" (also fine as an output).'),
          summary: z.string().optional().describe("One-line human-readable summary of what this step did"),
        },
        async (args) => {
          const ctx = getJobContext();
          if (!ctx) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: "No job context — this session is not a job step" }) }] };
          }
          const ok = recordStepResult(ctx.runId, ctx.stepId, {
            ...(args.outputs && { outputs: args.outputs }),
            ...(args.verdict && { verdict: args.verdict }),
            ...(args.summary && { summary: args.summary }),
          });
          if (!ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ error: `Failed to record step result for run ${ctx.runId} step ${ctx.stepId} — the run may have moved on` }),
                },
              ],
            };
          }
          log.info(`Recorded step result for run ${ctx.runId} step ${ctx.stepId}${args.verdict ? ` (verdict: ${args.verdict})` : ""}`);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ success: true, runId: ctx.runId, stepId: ctx.stepId, note: "Result recorded. Finish your turn — the job runner advances when this session ends." }),
              },
            ],
          };
        },
      ),
    ],
  };
}
