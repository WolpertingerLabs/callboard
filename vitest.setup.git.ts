/**
 * Git fixtures must not inherit commit-signing policy from the developer.
 *
 * Several suites create scratch repositories and commits. A global
 * `commit.gpgsign=true` makes those fixtures depend on an available private key
 * (and on an interactive pinentry), even though the signature is irrelevant to
 * every assertion. Environment config overrides the global file and is
 * inherited by all child processes spawned by the tests.
 */
const marker = "CALLBOARD_VITEST_GIT_CONFIGURED";
if (process.env[marker] !== "1") {
  const inheritedCount = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "0", 10);
  const index = Number.isSafeInteger(inheritedCount) && inheritedCount >= 0 ? inheritedCount : 0;
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  process.env[`GIT_CONFIG_KEY_${index}`] = "commit.gpgsign";
  process.env[`GIT_CONFIG_VALUE_${index}`] = "false";
  process.env[marker] = "1";
}
