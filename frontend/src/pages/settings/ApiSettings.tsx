import { useEffect, useState } from "react";
import { Key, Globe, Cpu, Eye, EyeOff, RefreshCw } from "lucide-react";
import { getAgentSettings, updateAgentSettings, getSystemInfo } from "../../api";
import type { AgentSettings } from "shared/types/index.js";
import type { SystemInfo } from "../../api";

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

export default function ApiSettings() {
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
      });
      setSettings(updated);
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

  return (
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

      <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 16, lineHeight: 1.5 }}>
        Overrides are applied as environment variables when Callboard spawns the Claude Agent SDK. They take effect for new sessions; resume an existing chat to
        pick up the new settings. Leave a field empty to fall back to the ambient environment (
        {settings?.apiKey || settings?.authToken ? "your saved value" : "your subscription login"}).
      </div>
    </>
  );
}
