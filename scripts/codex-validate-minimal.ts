/**
 * Minimal Codex SDK validation — strip every option to find what breaks.
 */
import { Codex } from "@openai/codex-sdk";

async function main() {
  const codex = new Codex({});
  const thread = codex.startThread({
    skipGitRepoCheck: true,
    workingDirectory: "/tmp/codex-validate-scratch",
    sandboxMode: "read-only",
    approvalPolicy: "never",
  });
  console.log("starting...");
  const { events } = await thread.runStreamed(
    "Reply with exactly: 'codex sdk validation ok'. No other text.",
  );
  for await (const evt of events) {
    console.log(JSON.stringify(evt));
  }
  console.log("thread.id:", thread.id);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
