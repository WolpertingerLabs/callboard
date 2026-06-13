import { useEffect, useState } from "react";
import { Key, Globe, Cpu, Eye, EyeOff, RefreshCw, Bot, Network, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { getAgentSettings, updateAgentSettings, getSystemInfo, getOpenRouterCatalog } from "../../api";
import type { AgentSettings, OpenRouterModelInfo, OpenRouterServerToolConfig, OpenRouterParamProfile } from "shared/types/index.js";
import { OR_SERVER_TOOLS, OR_PLUGINS, OR_SAMPLING_PARAMS, validateServerTools, validateParamProfile } from "shared/types/index.js";
import type { SystemInfo } from "../../api";
import OpenRouterModelSelector from "../../components/OpenRouterModelSelector";
import ParamFieldForm from "../../components/ParamFieldForm";
import { getDefaultProvider } from "../../utils/localStorage";
import type { AgentProviderKind } from "../../utils/localStorage";

const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 20,
  background: "var(--bg)",
  marginBottom: 16,
};

const headerStyle: React.CSSProperties = {
  marginBottom: 6,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginBottom: 12,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--text)",
  marginBottom: 4,
};

const envLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: "monospace",
  color: "var(--text-muted)",
  marginLeft: 8,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "monospace",
  boxSizing: "border-box",
};

const helpStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  marginTop: 4,
};

const fieldWrap: React.CSSProperties = {
  marginBottom: 14,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "6px 0",
  borderBottom: "1px solid var(--border)",
  fontSize: 12,
};

function truncateSensitive(value: string | undefined, edgeChars = 4): string {
  if (!value) return "—";
  if (value.length <= edgeChars * 2 + 3) return value;
  return `${value.slice(0, edgeChars)}...${value.slice(-edgeChars)}`;
}

interface SecretFieldProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

function SecretField({ id, value, onChange, placeholder }: SecretFieldProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        style={{ ...inputStyle, paddingRight: 40 }}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        title={visible ? "Hide" : "Show"}
        style={{
          position: "absolute",
          right: 6,
          top: "50%",
          transform: "translateY(-50%)",
          background: "transparent",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer",
          padding: 4,
          display: "flex",
          alignItems: "center",
        }}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}

// ── OpenRouter param-profile editing helpers ────────────────────────────────

const toggleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "8px 0",
  borderBottom: "1px solid var(--border)",
};

const tagStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "1px 5px",
  marginLeft: 6,
};

/** Read the params bag for a plugin entry (the object minus its `id`). */
function pluginParams(entry: { id: string } & Record<string, unknown>): Record<string, unknown> {
  const { id: _id, ...rest } = entry;
  return rest;
}

/**
 * Editor for one {@link OpenRouterParamProfile}: sampling params (via
 * ParamFieldForm) plus a per-plugin toggle that reveals the plugin's own
 * ParamFieldForm. Stored plugin shape is `{ id, ...camelCaseParams }`;
 * `nestUnder` params (file-parser's `pdf.engine`) are nested by ParamFieldForm.
 */
function ParamProfileEditor({
  profile,
  onChange,
  unsupportedKeys,
}: {
  profile: OpenRouterParamProfile;
  onChange: (next: OpenRouterParamProfile) => void;
  unsupportedKeys?: Set<string>;
}) {
  const plugins = profile.plugins ?? [];
  const pluginById = new Map(plugins.map((p) => [p.id, p]));

  const setSamplingParams = (params: Record<string, unknown>) => {
    onChange({ ...profile, params: Object.keys(params).length > 0 ? params : undefined });
  };

  const togglePlugin = (id: string, on: boolean) => {
    const next = on ? [...plugins.filter((p) => p.id !== id), { id }] : plugins.filter((p) => p.id !== id);
    onChange({ ...profile, plugins: next.length > 0 ? next : undefined });
  };

  const setPluginParams = (id: string, params: Record<string, unknown>) => {
    const next = plugins.map((p) => (p.id === id ? { id, ...params } : p));
    onChange({ ...profile, plugins: next });
  };

  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", margin: "6px 0 8px" }}>Sampling parameters</div>
      <ParamFieldForm specs={OR_SAMPLING_PARAMS} value={profile.params ?? {}} onChange={setSamplingParams} unsupportedKeys={unsupportedKeys} />

      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", margin: "12px 0 4px" }}>Plugins</div>
      {OR_PLUGINS.map((plugin) => {
        const entry = pluginById.get(plugin.id);
        const enabled = entry !== undefined;
        return (
          <div key={plugin.id} style={toggleRowStyle}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => togglePlugin(plugin.id, e.target.checked)}
              style={{ marginTop: 2, flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>
                {plugin.label}
                {plugin.deprecated && <span style={tagStyle}>deprecated</span>}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{plugin.description}</div>
              {plugin.modelHint && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  Meaningful with <code style={{ fontSize: 11 }}>{plugin.modelHint}</code>.
                </div>
              )}
              {enabled && plugin.params.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <ParamFieldForm specs={plugin.params} value={pluginParams(entry)} onChange={(p) => setPluginParams(plugin.id, p)} />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** True when a profile carries no sampling params and no plugins. */
function isEmptyProfile(p: OpenRouterParamProfile | undefined): boolean {
  if (!p) return true;
  const hasParams = p.params !== undefined && Object.keys(p.params).length > 0;
  const hasPlugins = p.plugins !== undefined && p.plugins.length > 0;
  return !hasParams && !hasPlugins;
}

/**
 * Compute the set of sampling `supportedParamKey`s a given model does NOT
 * advertise. An empty/unknown `supportedParameters` list (model not in the
 * catalog) ⇒ no keys flagged (we don't gray out when we can't tell).
 */
function computeUnsupportedKeys(model: OpenRouterModelInfo | undefined): Set<string> {
  const out = new Set<string>();
  if (!model || !Array.isArray(model.supportedParameters) || model.supportedParameters.length === 0) return out;
  const supported = new Set(model.supportedParameters);
  for (const spec of OR_SAMPLING_PARAMS) {
    if (spec.supportedParamKey && !supported.has(spec.supportedParamKey)) out.add(spec.supportedParamKey);
  }
  return out;
}

export default function ApiSettings() {
  // Top-level integration toggle — picks which provider's settings are shown.
  // Seeded from the user's New Chat default so the page opens on the provider
  // they actually use; purely a view selector, not persisted back.
  const [activeProvider, setActiveProvider] = useState<AgentProviderKind>(() => getDefaultProvider());

  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Editable form state — mirrors the override fields on AgentSettings.
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [model, setModel] = useState("");
  const [defaultOpusModel, setDefaultOpusModel] = useState("");
  const [defaultSonnetModel, setDefaultSonnetModel] = useState("");
  const [defaultHaikuModel, setDefaultHaikuModel] = useState("");
  const [subagentModel, setSubagentModel] = useState("");
  // OpenRouter (alternative provider) overrides.
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [openRouterBaseUrl, setOpenRouterBaseUrl] = useState("");
  const [openRouterModel, setOpenRouterModel] = useState("");
  const [openRouterLogsRoot, setOpenRouterLogsRoot] = useState("");
  // Stored as a string in form state so the input can be cleared (empty
  // string → "use library default"). Validation/parse happens on save.
  const [openRouterMaxBudgetUsd, setOpenRouterMaxBudgetUsd] = useState("");
  // Custom model aliases, edited as ordered rows; converted to the
  // Record<alias, modelId> shape on save. Blank rows are dropped on save.
  const [aliasRows, setAliasRows] = useState<{ alias: string; modelId: string }[]>([]);
  // OpenRouter server tools. `undefined` = unowned (toggles show harness
  // defaults); any user edit transitions to an explicit array we own — even
  // `[]`, which means "all server tools disabled".
  const [serverTools, setServerTools] = useState<OpenRouterServerToolConfig[] | undefined>(undefined);
  // Global default sampling params + plugins.
  const [modelParamsDefault, setModelParamsDefault] = useState<OpenRouterParamProfile>({});
  // Per-model overrides, edited as ordered rows; converted to a
  // Record<slug, profile> on save. Blank-slug rows are dropped.
  const [modelParamRows, setModelParamRows] = useState<{ slug: string; profile: OpenRouterParamProfile }[]>([]);
  // Catalog models (for supportedParameters lookups in per-model overrides).
  const [orModels, setOrModels] = useState<OpenRouterModelInfo[]>([]);
  // Collapse state for the bulky sections.
  const [showDefaults, setShowDefaults] = useState(false);
  const [expandedTool, setExpandedTool] = useState<string | null>(null);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [s, sys] = await Promise.all([getAgentSettings(), getSystemInfo().catch(() => null)]);
      setSettings(s);
      setSystemInfo(sys);
      setApiBaseUrl(s.apiBaseUrl ?? "");
      setApiKey(s.apiKey ?? "");
      setAuthToken(s.authToken ?? "");
      setModel(s.model ?? "");
      setDefaultOpusModel(s.defaultOpusModel ?? "");
      setDefaultSonnetModel(s.defaultSonnetModel ?? "");
      setDefaultHaikuModel(s.defaultHaikuModel ?? "");
      setSubagentModel(s.subagentModel ?? "");
      setOpenRouterApiKey(s.openRouterApiKey ?? "");
      setOpenRouterBaseUrl(s.openRouterBaseUrl ?? "");
      setOpenRouterModel(s.openRouterModel ?? "");
      setOpenRouterLogsRoot(s.openRouterLogsRoot ?? "");
      setOpenRouterMaxBudgetUsd(typeof s.openRouterMaxBudgetUsd === "number" ? String(s.openRouterMaxBudgetUsd) : "");
      setAliasRows(Object.entries(s.openRouterModelAliases ?? {}).map(([alias, modelId]) => ({ alias, modelId })));
      setServerTools(s.openRouterServerTools);
      setModelParamsDefault(s.openRouterModelParamsDefault ?? {});
      setModelParamRows(Object.entries(s.openRouterModelParamProfiles ?? {}).map(([slug, profile]) => ({ slug, profile })));
      // Catalog (for supportedParameters); best-effort — fields still work offline.
      getOpenRouterCatalog()
        .then(({ models }) => setOrModels(models))
        .catch(() => {});
    } catch (err: any) {
      setError(err.message || "Failed to load settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setError("");

    // ── Client-side validation of the OpenRouter tool/param settings ──
    // Mirrors the backend's write-time rules so the user sees problems before
    // the save round-trips. Any error aborts the save (like alias validation).
    const orErrors: string[] = [];
    let cleanedServerTools: OpenRouterServerToolConfig[] | undefined;
    if (serverTools !== undefined) {
      const { value, errors } = validateServerTools(serverTools);
      orErrors.push(...errors);
      cleanedServerTools = value; // may be [] (explicitly "all disabled")
    }

    const { value: cleanedDefault, errors: defaultErrors } = validateParamProfile(modelParamsDefault);
    orErrors.push(...defaultErrors);

    const cleanedProfiles: Record<string, OpenRouterParamProfile> = {};
    const seenSlugs = new Set<string>();
    for (const row of modelParamRows) {
      const slug = row.slug.trim();
      if (slug === "") continue; // blank rows dropped on save
      if (seenSlugs.has(slug)) {
        orErrors.push(`Duplicate per-model override for "${slug}"`);
        continue;
      }
      seenSlugs.add(slug);
      const { value, errors } = validateParamProfile(row.profile);
      orErrors.push(...errors.map((e) => `${slug}: ${e}`));
      if (!isEmptyProfile(value)) cleanedProfiles[slug] = value;
    }

    if (orErrors.length > 0) {
      setError(orErrors.join("; "));
      setSaving(false);
      return;
    }

    try {
      const updated = await updateAgentSettings({
        apiBaseUrl,
        apiKey,
        authToken,
        model,
        defaultOpusModel,
        defaultSonnetModel,
        defaultHaikuModel,
        subagentModel,
        openRouterApiKey,
        openRouterBaseUrl,
        openRouterModel,
        openRouterLogsRoot,
        // Send `null` to clear, or the parsed number otherwise. We
        // intentionally avoid `undefined`: JSON.stringify would strip it and
        // the route's `!== undefined` partial-update guard would leave the
        // prior saved value intact, making the input unable to clear an
        // override.
        openRouterMaxBudgetUsd: (openRouterMaxBudgetUsd.trim() === "" ? null : Number(openRouterMaxBudgetUsd)) as number | undefined,
        // Rows with either side blank are dropped; an empty map clears all
        // aliases (the route stores undefined for an empty object).
        openRouterModelAliases: Object.fromEntries(
          aliasRows.map((r) => [r.alias.trim(), r.modelId.trim()]).filter(([alias, modelId]) => alias !== "" && modelId !== ""),
        ),
        // Server tools: send the explicit array (including `[]` = all disabled)
        // once owned; `undefined` while unowned so the harness keeps its
        // defaults. JSON.stringify drops `undefined`, so the route's
        // partial-update guard correctly leaves the field untouched.
        openRouterServerTools: cleanedServerTools,
        // Param profiles: always send the cleaned value (even an empty `{}`
        // profile / empty record) so the route can clear a previously-saved
        // override. The backend coerces an empty validated profile/record to
        // undefined on store; sending `undefined` here would instead leave the
        // prior value intact (JSON.stringify drops it).
        openRouterModelParamsDefault: cleanedDefault,
        openRouterModelParamProfiles: cleanedProfiles,
      });
      setSettings(updated);
      // Re-sync alias rows so blank rows dropped on save disappear from the form.
      setAliasRows(Object.entries(updated.openRouterModelAliases ?? {}).map(([alias, modelId]) => ({ alias, modelId })));
      // Re-sync the OR tool/param state from the saved value.
      setServerTools(updated.openRouterServerTools);
      setModelParamsDefault(updated.openRouterModelParamsDefault ?? {});
      setModelParamRows(Object.entries(updated.openRouterModelParamProfiles ?? {}).map(([slug, profile]) => ({ slug, profile })));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // Re-fetch system info so the Account / Models display reflects new overrides.
      // The backend kicks off a refresh on save; give it a moment before polling.
      setTimeout(() => {
        getSystemInfo()
          .then(setSystemInfo)
          .catch(() => {});
      }, 800);
    } catch (err: any) {
      setError(err.message || "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleRefresh = async () => {
    try {
      const sys = await getSystemInfo();
      setSystemInfo(sys);
    } catch {
      /* ignore */
    }
  };

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>;
  }

  const account = systemInfo?.account;
  const models = systemInfo?.models ?? [];

  // Inline alias validation — mirrors the backend's write-time rules so the
  // user sees the problem before Save bounces with a 400.
  const aliasNames = aliasRows.map((r) => r.alias.trim().toLowerCase()).filter((a) => a !== "");
  const duplicateAliasNames = [...new Set(aliasNames.filter((a, i) => aliasNames.indexOf(a) !== i))];
  const aliasNameSet = new Set(aliasNames);
  const aliasTargetingAlias = aliasRows.find((r) => r.modelId.trim() !== "" && aliasNameSet.has(r.modelId.trim().toLowerCase()));

  return (
    <>
      {/* Integration toggle — Claude Code and OpenRouter as first-class providers */}
      <div
        style={{
          display: "flex",
          borderRadius: 8,
          border: "1px solid var(--border)",
          overflow: "hidden",
          marginBottom: 16,
        }}
      >
        {[
          { kind: "claude-code" as AgentProviderKind, label: "Claude Code", icon: <Bot size={14} /> },
          { kind: "openrouter" as AgentProviderKind, label: "OpenRouter", icon: <Network size={14} /> },
        ].map(({ kind, label, icon }, idx) => (
          <button
            key={kind}
            onClick={() => setActiveProvider(kind)}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: "10px 12px",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
              border: "none",
              borderRight: idx < 1 ? "1px solid var(--border)" : "none",
              background: activeProvider === kind ? "var(--accent)" : "var(--surface)",
              color: activeProvider === kind ? "var(--text-on-accent)" : "var(--text)",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>

      {activeProvider === "claude-code" && (
        <>
          {/* API Endpoint */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Globe size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>API Endpoint</span>
            </div>
            <div style={subtitleStyle}>
              Override the base URL used by the Claude Agent SDK. Useful for routing through a corporate proxy or LLM gateway. Leave empty to use the default
              Anthropic API endpoint.
            </div>
            <div style={fieldWrap}>
              <label htmlFor="apiBaseUrl" style={labelStyle}>
                Base URL<span style={envLabelStyle}>ANTHROPIC_BASE_URL</span>
              </label>
              <input
                id="apiBaseUrl"
                type="text"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                placeholder="https://api.anthropic.com"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={helpStyle}>When set to a non-first-party host, MCP tool search is disabled by default.</div>
            </div>
          </div>

          {/* Authentication */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Key size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Authentication</span>
            </div>
            <div style={subtitleStyle}>
              Claude Code normally authenticates through your Claude subscription. Set an API key or auth token here to override that — for example, to use a
              different account or a gateway that requires a bearer token.
            </div>

            {/* Current source (view-only) */}
            <div style={{ marginBottom: 14 }}>
              <div style={rowStyle}>
                <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>Current token source</span>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)" }}>{account?.tokenSource || "—"}</span>
              </div>
              <div style={rowStyle}>
                <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>Current API key source</span>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)" }}>{truncateSensitive(account?.apiKeySource, 4)}</span>
              </div>
              <div style={rowStyle}>
                <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>Account</span>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)" }}>{truncateSensitive(account?.email, 4) || "—"}</span>
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="apiKey" style={labelStyle}>
                API Key<span style={envLabelStyle}>ANTHROPIC_API_KEY</span>
              </label>
              <SecretField id="apiKey" value={apiKey} onChange={setApiKey} placeholder="sk-ant-..." />
              <div style={helpStyle}>Sent as the X-Api-Key header. Takes precedence over your subscription login.</div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="authToken" style={labelStyle}>
                Auth Token<span style={envLabelStyle}>ANTHROPIC_AUTH_TOKEN</span>
              </label>
              <SecretField id="authToken" value={authToken} onChange={setAuthToken} placeholder="Bearer token value" />
              <div style={helpStyle}>Sent as the Authorization: Bearer header. Use for gateways that require a bearer token.</div>
            </div>
          </div>

          {/* Models */}
          <div style={sectionStyle}>
            <div style={{ ...headerStyle, justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Cpu size={16} style={{ color: "var(--accent)" }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Models</span>
              </div>
              <button
                onClick={handleRefresh}
                title="Refresh models from SDK"
                style={{
                  background: "var(--surface)",
                  color: "var(--text-muted)",
                  padding: 6,
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                }}
              >
                <RefreshCw size={14} />
              </button>
            </div>
            <div style={subtitleStyle}>Override which model is used for the session and what the `opus`, `sonnet`, and `haiku` aliases resolve to.</div>

            {/* Currently available models */}
            {models.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Currently available to your account:</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {models.map((m) => (
                    <div key={m.value} style={rowStyle}>
                      <span style={{ color: "var(--text)" }}>{m.displayName}</span>
                      <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--text-muted)" }}>{m.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={fieldWrap}>
              <label htmlFor="model" style={labelStyle}>
                Default Model<span style={envLabelStyle}>ANTHROPIC_MODEL</span>
              </label>
              <input
                id="model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. opus, sonnet, claude-opus-4-7"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={helpStyle}>Alias (opus, sonnet, haiku, opusplan) or full model ID. Applies to new sessions.</div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="opusModel" style={labelStyle}>
                Opus Alias Target<span style={envLabelStyle}>ANTHROPIC_DEFAULT_OPUS_MODEL</span>
              </label>
              <input
                id="opusModel"
                type="text"
                value={defaultOpusModel}
                onChange={(e) => setDefaultOpusModel(e.target.value)}
                placeholder="claude-opus-4-7"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
            </div>

            <div style={fieldWrap}>
              <label htmlFor="sonnetModel" style={labelStyle}>
                Sonnet Alias Target<span style={envLabelStyle}>ANTHROPIC_DEFAULT_SONNET_MODEL</span>
              </label>
              <input
                id="sonnetModel"
                type="text"
                value={defaultSonnetModel}
                onChange={(e) => setDefaultSonnetModel(e.target.value)}
                placeholder="claude-sonnet-4-6"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
            </div>

            <div style={fieldWrap}>
              <label htmlFor="haikuModel" style={labelStyle}>
                Haiku Alias Target<span style={envLabelStyle}>ANTHROPIC_DEFAULT_HAIKU_MODEL</span>
              </label>
              <input
                id="haikuModel"
                type="text"
                value={defaultHaikuModel}
                onChange={(e) => setDefaultHaikuModel(e.target.value)}
                placeholder="claude-haiku-4-5"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={helpStyle}>Also used for background tasks. Replaces the deprecated ANTHROPIC_SMALL_FAST_MODEL.</div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="subagentModel" style={labelStyle}>
                Subagent Model<span style={envLabelStyle}>CLAUDE_CODE_SUBAGENT_MODEL</span>
              </label>
              <input
                id="subagentModel"
                type="text"
                value={subagentModel}
                onChange={(e) => setSubagentModel(e.target.value)}
                placeholder="e.g. haiku"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
            </div>
          </div>
        </>
      )}

      {activeProvider === "openrouter" && (
        <>
          {/* OpenRouter */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Network size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>OpenRouter</span>
            </div>
            <div style={subtitleStyle}>
              Provide a key to enable OpenRouter as an option when starting a new chat. OpenRouter routes through 300+ models with a single key.
            </div>

            <div style={fieldWrap}>
              <label htmlFor="openRouterApiKey" style={labelStyle}>
                API Key<span style={envLabelStyle}>OPENROUTER_API_KEY</span>
              </label>
              <SecretField id="openRouterApiKey" value={openRouterApiKey} onChange={setOpenRouterApiKey} placeholder="sk-or-..." />
              <div style={helpStyle}>Required. When set, the New Chat panel exposes an OpenRouter provider toggle.</div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="openRouterBaseUrl" style={labelStyle}>
                Base URL<span style={envLabelStyle}>OPENROUTER_BASE_URL</span>
              </label>
              <input
                id="openRouterBaseUrl"
                type="text"
                value={openRouterBaseUrl}
                onChange={(e) => setOpenRouterBaseUrl(e.target.value)}
                placeholder="https://openrouter.ai/api/v1"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={helpStyle}>Optional. Override the OpenRouter API endpoint (proxies / regional mirrors).</div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="openRouterModel" style={labelStyle}>
                Default Model
              </label>
              <OpenRouterModelSelector
                id="openRouterModel"
                value={openRouterModel}
                onChange={setOpenRouterModel}
                placeholder="~anthropic/claude-sonnet-latest"
              />
              <div style={helpStyle}>
                Start typing to filter tool-calling models by slug. Common aliases: <code style={{ fontSize: 11 }}>~anthropic/claude-sonnet-latest</code>,{" "}
                <code style={{ fontSize: 11 }}>openai/gpt-4o</code>, <code style={{ fontSize: 11 }}>google/gemini-2.0-flash</code>.
              </div>
            </div>

            <div style={fieldWrap}>
              <label style={labelStyle}>Model Aliases</label>
              <div style={{ ...helpStyle, marginTop: 0, marginBottom: 8 }}>
                Name your own shortcuts for models — e.g. <code style={{ fontSize: 11 }}>low coder</code> →{" "}
                <code style={{ fontSize: 11 }}>deepseek/deepseek-chat</code>. Aliases work anywhere an OpenRouter model can be set (new chats, the default model
                above, scheduled jobs). Re-pointing an alias applies to every chat using it. An alias with the same name as a real model wins.
              </div>
              {aliasRows.map((row, i) => (
                <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                  <input
                    type="text"
                    value={row.alias}
                    onChange={(e) => setAliasRows((rows) => rows.map((r, j) => (j === i ? { ...r, alias: e.target.value } : r)))}
                    placeholder="low coder"
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...inputStyle, width: 180, flexShrink: 0 }}
                  />
                  <span style={{ color: "var(--text-muted)", fontSize: 12, flexShrink: 0 }}>→</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <OpenRouterModelSelector
                      value={row.modelId}
                      onChange={(v) => setAliasRows((rows) => rows.map((r, j) => (j === i ? { ...r, modelId: v } : r)))}
                      placeholder="deepseek/deepseek-chat"
                      excludeAliases
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setAliasRows((rows) => rows.filter((_, j) => j !== i))}
                    title="Remove alias"
                    style={{
                      background: "transparent",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      padding: 8,
                      display: "flex",
                      alignItems: "center",
                      flexShrink: 0,
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              {duplicateAliasNames.length > 0 && (
                <div style={{ fontSize: 11, color: "var(--error)", marginBottom: 8 }}>
                  Duplicate alias name{duplicateAliasNames.length > 1 ? "s" : ""}: {duplicateAliasNames.join(", ")}
                </div>
              )}
              {aliasTargetingAlias && (
                <div style={{ fontSize: 11, color: "var(--error)", marginBottom: 8 }}>
                  &ldquo;{aliasTargetingAlias.modelId.trim()}&rdquo; is itself an alias — targets must be real model slugs.
                </div>
              )}
              <button
                type="button"
                onClick={() => setAliasRows((rows) => [...rows, { alias: "", modelId: "" }])}
                style={{
                  background: "transparent",
                  border: "1px dashed var(--border)",
                  borderRadius: 8,
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  padding: "8px 12px",
                  fontSize: 12,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <Plus size={14} /> Add alias
              </button>
              <div style={helpStyle}>
                Deleting an alias does not update chats already using it — they will fail to start until the alias is recreated or the chat&rsquo;s model is
                changed.
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="openRouterMaxBudgetUsd" style={labelStyle}>
                Max budget per session (USD)
              </label>
              <input
                id="openRouterMaxBudgetUsd"
                type="number"
                min="0"
                step="0.01"
                value={openRouterMaxBudgetUsd}
                onChange={(e) => setOpenRouterMaxBudgetUsd(e.target.value)}
                placeholder="1.00"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={helpStyle}>
                Cumulative spend cap for an OpenRouter chat session. Defaults to <code style={{ fontSize: 11 }}>$1.00</code> when empty — raise this for
                long-running coding sessions to avoid the &ldquo;Agent reached the maximum budget limit&rdquo; cutoff. Applies per streaming session, not per
                message.
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="openRouterLogsRoot" style={labelStyle}>
                Logs Root
              </label>
              <input
                id="openRouterLogsRoot"
                type="text"
                value={openRouterLogsRoot}
                onChange={(e) => setOpenRouterLogsRoot(e.target.value)}
                placeholder="~/.openrouter-agent-harness/logs"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={helpStyle}>Optional. Override where OR session state is written. Defaults to ~/.openrouter-agent-harness/logs.</div>
            </div>
          </div>

          {/* OpenRouter — Server Tools */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Cpu size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Server Tools</span>
            </div>
            <div style={subtitleStyle}>
              OpenRouter-hosted tools the model can call. Until you change a toggle, new sessions use the harness defaults (date/time, web search, web
              fetch). Changing any toggle takes ownership — your exact selection is then used verbatim, including disabling everything.
            </div>
            {serverTools !== undefined && serverTools.length === 0 && (
              <div style={{ ...helpStyle, marginTop: 0, marginBottom: 8, color: "var(--text)" }}>All server tools disabled.</div>
            )}
            {OR_SERVER_TOOLS.map((tool) => {
              const owned = serverTools !== undefined;
              const entry = owned ? serverTools.find((t) => t.type === tool.type) : undefined;
              const enabled = owned ? entry !== undefined : tool.defaultOn;
              const hasParams = tool.params.length > 0;
              const expanded = expandedTool === tool.type;

              // Toggling takes ownership: seed the explicit array from the
              // current effective set, then add/remove this tool.
              const toggle = (on: boolean) => {
                const base: OpenRouterServerToolConfig[] = owned
                  ? serverTools
                  : OR_SERVER_TOOLS.filter((t) => t.defaultOn).map((t) => ({ type: t.type }));
                const next = on ? [...base.filter((t) => t.type !== tool.type), { type: tool.type }] : base.filter((t) => t.type !== tool.type);
                setServerTools(next);
              };

              const setToolParams = (params: Record<string, unknown>) => {
                const base = owned ? serverTools : OR_SERVER_TOOLS.filter((t) => t.defaultOn).map((t) => ({ type: t.type }));
                const next = base.map((t) => (t.type === tool.type ? { type: tool.type, ...(Object.keys(params).length > 0 ? { params } : {}) } : t));
                setServerTools(next);
              };

              return (
                <div key={tool.type} style={toggleRowStyle}>
                  <input type="checkbox" checked={enabled} onChange={(e) => toggle(e.target.checked)} style={{ marginTop: 2, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <div style={{ fontSize: 13, color: "var(--text)", fontWeight: 500 }}>
                        {tool.label}
                        {tool.defaultOn && <span style={tagStyle}>default</span>}
                      </div>
                      {enabled && hasParams && (
                        <button
                          type="button"
                          onClick={() => setExpandedTool(expanded ? null : tool.type)}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "var(--text-muted)",
                            cursor: "pointer",
                            fontSize: 12,
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            flexShrink: 0,
                          }}
                        >
                          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Configure
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{tool.description}</div>
                    {enabled && hasParams && expanded && (
                      <div style={{ marginTop: 8 }}>
                        <ParamFieldForm specs={tool.params} value={entry?.params ?? {}} onChange={setToolParams} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* OpenRouter — Default Model Parameters */}
          <div style={sectionStyle}>
            <button
              type="button"
              onClick={() => setShowDefaults((v) => !v)}
              style={{
                ...headerStyle,
                width: "100%",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                padding: 0,
                color: "var(--text)",
              }}
            >
              {showDefaults ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Default Model Parameters</span>
            </button>
            <div style={subtitleStyle}>
              Sampling knobs and plugins applied to every OpenRouter session. Leave a field blank to use the model/provider default — blanks are never sent.
              Per-model overrides below take precedence.
            </div>
            {showDefaults && <ParamProfileEditor profile={modelParamsDefault} onChange={setModelParamsDefault} />}
          </div>

          {/* OpenRouter — Per-Model Overrides */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Cpu size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Per-Model Parameter Overrides</span>
            </div>
            <div style={subtitleStyle}>
              Override the default parameters for specific models. Knobs a model doesn&rsquo;t advertise are grayed out. The Pareto router plugin is meaningful
              with <code style={{ fontSize: 11 }}>openrouter/pareto-code</code>.
            </div>
            {modelParamRows.map((row, i) => {
              const model = orModels.find((m) => m.id === row.slug.trim());
              const unsupportedKeys = computeUnsupportedKeys(model);
              return (
                <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 10 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <OpenRouterModelSelector
                        value={row.slug}
                        onChange={(v) => setModelParamRows((rows) => rows.map((r, j) => (j === i ? { ...r, slug: v } : r)))}
                        placeholder="openai/gpt-4o"
                        excludeAliases
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => setModelParamRows((rows) => rows.filter((_, j) => j !== i))}
                      title="Remove override"
                      style={{
                        background: "transparent",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        padding: 8,
                        display: "flex",
                        alignItems: "center",
                        flexShrink: 0,
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <ParamProfileEditor
                    profile={row.profile}
                    onChange={(profile) => setModelParamRows((rows) => rows.map((r, j) => (j === i ? { ...r, profile } : r)))}
                    unsupportedKeys={unsupportedKeys}
                  />
                </div>
              );
            })}
            <button
              type="button"
              onClick={() => setModelParamRows((rows) => [...rows, { slug: "", profile: {} }])}
              style={{
                background: "transparent",
                border: "1px dashed var(--border)",
                borderRadius: 8,
                color: "var(--text-muted)",
                cursor: "pointer",
                padding: "8px 12px",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Plus size={14} /> Add model override
            </button>
          </div>
        </>
      )}

      {error && <div style={{ fontSize: 13, color: "var(--error)", marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            background: saving ? "var(--surface)" : "var(--accent)",
            color: saving ? "var(--text-muted)" : "var(--text-on-accent)",
            padding: "10px 20px",
            borderRadius: 8,
            border: saving ? "1px solid var(--border)" : "none",
            fontSize: 14,
            fontWeight: 500,
            cursor: saving ? "not-allowed" : "pointer",
          }}
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save"}
        </button>
      </div>

      {activeProvider === "claude-code" ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 16, lineHeight: 1.5 }}>
          Overrides are applied as environment variables when Callboard spawns the Claude Agent SDK. They take effect for new sessions; resume an existing chat
          to pick up the new settings. Leave a field empty to fall back to the ambient environment (
          {settings?.apiKey || settings?.authToken ? "your saved value" : "your subscription login"}).
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 16, lineHeight: 1.5 }}>
          Overrides are applied as environment variables when Callboard spawns an OpenRouter session. They take effect for new sessions; resume an existing chat
          to pick up the new settings. Leave a field empty to fall back to the ambient environment.
        </div>
      )}
    </>
  );
}
