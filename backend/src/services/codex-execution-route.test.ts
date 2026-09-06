import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCodexExecutionRoute, routeFromCodexConfig, safeApiRoot } from "./codex-execution-route.js";
import { translateCodexOptions } from "../agents/adapters/codex/optionsAdapter.js";
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cb-route-"));
  vi.stubEnv("OPENAI_BASE_URL", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});
const config = (body: string) => writeFile(join(home, "config.toml"), body);

describe("installed Codex effective config/read", () => {
  it("ignores inactive tables/comments and keeps native none summary-only", async () => {
    await config(
      `model_provider='openai'\n# https://openrouter.ai/api/v1\n[model_providers.unused]\nname='Unused'\nbase_url='https://openrouter.ai/api/v1'\nwire_api='responses'\n`,
    );
    const resolved = await resolveCodexExecutionRoute({ codexHome: home }, home);
    expect(resolved.route).toBe("codex");
    const { codexOpts } = translateCodexOptions({ codex: { reasoningRoute: "native", reasoningEffort: "none" } });
    expect(codexOpts.config?.model_reasoning_effort).toBeUndefined();
    expect(codexOpts.config?.model_reasoning_summary).toBe("none");
  });
  it("honors settings API base over ambient OR; explicit OR API base genuinely disables", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://openrouter.ai/api/v1");
    expect((await resolveCodexExecutionRoute({ codexHome: home, codexAuthMode: "api-key", codexBaseUrl: "https://api.openai.com/v1" }, home)).route).toBe(
      "codex",
    );
    vi.stubEnv("OPENAI_BASE_URL", "https://api.openai.com/v1");
    const route = await resolveCodexExecutionRoute({ codexHome: home, codexAuthMode: "api-key", codexBaseUrl: "https://openrouter.ai/api/v1" }, home);
    expect(route).toMatchObject({ route: "openrouter", endpoint: "https://openrouter.ai/api/v1", injectedOpenRouter: false });
    expect(translateCodexOptions({ codex: { reasoningRoute: "openrouter", reasoningEffort: "none" } }).codexOpts.config?.model_reasoning_effort).toBe("none");
  });
  it("uses active quoted provider rather than inactive openai/global override", async () => {
    await config(
      `model_provider='my.gateway'\nopenai_base_url='https://api.openai.com/v1'\n[model_providers."my.gateway"]\nname='Gateway'\nbase_url='https://openrouter.ai/api/v1'\nwire_api='responses'\n`,
    );
    expect((await resolveCodexExecutionRoute({ codexHome: home, codexAuthMode: "api-key", codexBaseUrl: "https://api.openai.com/v1" }, home)).route).toBe(
      "openrouter",
    );
  });
  it("includes trusted project layers and re-reads changes instead of stale cached route", async () => {
    const project = join(home, "project");
    await mkdir(join(project, ".git"), { recursive: true });
    await mkdir(join(project, ".codex"));
    execFileSync("git", ["init", project], { stdio: "ignore" });
    await config(`model_provider='openai'\n[projects.${JSON.stringify(project)}]\ntrust_level='trusted'\n`);
    await writeFile(
      join(project, ".codex", "config.toml"),
      `model='gpt-6-astra'\nmodel_reasoning_effort='ultra'\nopenai_base_url='https://openrouter.ai/api/v1'\n`,
    );
    const first = await resolveCodexExecutionRoute({ codexHome: home }, project);
    expect(first.model).toBe("gpt-6-astra");
    // CLI filters endpoint overrides from project layers; do not reimplement them.
    expect(first.route).toBe("codex");
    await writeFile(join(project, ".codex", "config.toml"), `model='gpt-5.5'\n`);
    expect((await resolveCodexExecutionRoute({ codexHome: home }, project)).model).toBe("gpt-5.5");
  });
  it("private custom endpoints and malformed config are unknown, not assumed native", async () => {
    await config(`model_provider='private'\n[model_providers.private]\nname='Private'\nbase_url='https://private.example/v1'\nwire_api='responses'\n`);
    expect((await resolveCodexExecutionRoute({ codexHome: home }, home)).route).toBe("unknown");
    await config(`model_provider = [ malformed`);
    expect((await resolveCodexExecutionRoute({ codexHome: home }, home)).route).toBe("unknown");
  });
  it("explicit Callboard OR injection is scoped independently of utility routing", async () => {
    const result = await resolveCodexExecutionRoute(
      {
        codexHome: home,
        codexUseOpenRouter: true,
        codexOpenRouterApiKey: "fake",
        codexOpenRouterBaseUrl: "https://private.example/api/v1/",
        openRouterBaseUrl: "https://unrelated.example/v1",
      },
      home,
    );
    expect(result).toMatchObject({ route: "openrouter", endpoint: "https://private.example/api/v1", injectedOpenRouter: true });
  });
});
it("does not return URLs containing credentials or tokens", () => {
  expect(safeApiRoot("https://user:secret@host/v1")).toBeUndefined();
  expect(safeApiRoot("https://host/v1?key=secret")).toBeUndefined();
  expect(
    routeFromCodexConfig({ model_provider: "openai", openai_base_url: "https://api.openai.com/v1" }, { OPENAI_BASE_URL: "https://openrouter.ai/api/v1" }).route,
  ).toBe("codex");
});

it("sanitizes daemon secrets before intentional API overrides reach a configured CLI", async () => {
  vi.stubEnv("AUTH_PASSWORD_HASH", "sentinel-hash");
  vi.stubEnv("AUTH_PASSWORD_SALT", "sentinel-salt");
  vi.stubEnv("PORT", "sentinel-port");
  vi.stubEnv("OPENAI_BASE_URL", "https://ambient.example/v1");
  const wrapper = join(home, "probe-cli.cjs");
  await writeFile(
    wrapper,
    `#!${process.execPath}
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const result = request.method === 'config/read' ? { config: { model_provider: 'openai', model: JSON.stringify({
    hashPresent: 'AUTH_PASSWORD_HASH' in process.env,
    saltPresent: 'AUTH_PASSWORD_SALT' in process.env,
    portPresent: 'PORT' in process.env,
    home: process.env.CODEX_HOME,
    base: process.env.OPENAI_BASE_URL,
    key: process.env.OPENAI_API_KEY
  }) } } : {};
  if (request.id) process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
});
`,
    { mode: 0o700 },
  );
  const result = await resolveCodexExecutionRoute(
    {
      codexHome: home,
      codexPathOverride: wrapper,
      codexAuthMode: "api-key",
      codexBaseUrl: "https://api.openai.com/v1",
      codexApiKey: "sentinel-intentional-key",
    },
    home,
  );
  expect(JSON.parse(result.model!)).toEqual({
    hashPresent: false,
    saltPresent: false,
    portPresent: false,
    home,
    base: "https://api.openai.com/v1",
    key: "sentinel-intentional-key",
  });
});
