import { useEffect, useRef, useState } from "react";
import { Key, Globe, Cpu, Eye, EyeOff, RefreshCw, Bot, Network, Terminal, Plug, Boxes, ExternalLink, AlertTriangle, CheckCircle2, HardDrive } from "lucide-react";
import {
  getAgentSettings,
  updateAgentSettings,
  getSystemInfo,
  getOpenRouterCatalog,
  getAcpModels,
  getClineProviders,
  getPiProviders,
  getEngines,
  refreshEngines,
  checkEngineBinary,
} from "../../api";
import PiModelSelector from "../../components/PiModelSelector";
import EngineStatusCard, { EngineStatusDot, StatusRow } from "./EngineStatusCard";
import type { EngineRecheckOutcome } from "./EngineStatusCard";
import type { AgentSettings, OpenRouterModelInfo } from "shared/types/index.js";
import type { SystemInfo, AcpProviderInfo, AcpModelCatalogInfo, EngineStatus, EngineBinaryCheckResponse } from "../../api";
import OpenRouterModelSelector from "../../components/OpenRouterModelSelector";
import ClineModelSelector from "../../components/ClineModelSelector";
import CodexModelSelector from "../../components/CodexModelSelector";
import { getDefaultProvider, getDefaultAcpProviderId } from "../../utils/localStorage";
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

type ReferenceLink = {
  label: string;
  href: string;
  note?: string;
};

/**
 * Which section of this page is showing.
 *
 * Wider than {@link AgentProviderKind} by `"openrouter"`, which left that union
 * when the OR harness was retired. The tab stays: the key still backs the
 * account-wide ACP fallback and the model catalog, so this page is where an
 * OpenRouter credential is configured — it is a service config, not a harness
 * tab. See plans/remove-openrouter-engine.md.
 */
type SettingsTab = AgentProviderKind | "openrouter";

const providerReferenceLinks: Record<SettingsTab, ReferenceLink[]> = {
  "claude-code": [
    { label: "Claude usage", href: "https://claude.ai/settings/usage", note: "Subscription usage and usage credits" },
    { label: "Console billing", href: "https://console.anthropic.com/settings/billing", note: "Anthropic API credits and billing" },
    {
      label: "Code limits",
      href: "https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan",
      note: "Claude Code subscription limit reference",
    },
  ],
  openrouter: [
    { label: "Credits", href: "https://openrouter.ai/settings/credits", note: "OpenRouter credit balance" },
    { label: "Activity", href: "https://openrouter.ai/activity", note: "OpenRouter usage activity" },
    { label: "Keys", href: "https://openrouter.ai/keys", note: "API keys and key limits" },
  ],
  codex: [
    { label: "Codex usage", href: "https://chatgpt.com/codex/settings/usage", note: "Codex plan limits and credits" },
    { label: "API usage", href: "https://platform.openai.com/usage", note: "OpenAI API usage" },
    { label: "API billing", href: "https://platform.openai.com/settings/organization/billing/overview", note: "OpenAI Platform billing" },
    { label: "API limits", href: "https://platform.openai.com/settings/organization/limits", note: "OpenAI Platform limits" },
  ],
  // ACP is a wire format, not a vendor, so there is no single usage or billing
  // page to link — credentials belong to whichever CLI the user configured, and
  // callboard never handles them. The protocol docs are the honest destination.
  acp: [
    { label: "Agent Client Protocol", href: "https://agentclientprotocol.com", note: "The protocol callboard speaks to these agents" },
    { label: "OpenCode docs", href: "https://opencode.ai/docs/", note: "Model, auth and permission configuration for OpenCode" },
  ],
  // Cline embeds an SDK rather than wrapping a service, so its billing lives
  // wherever the user's chosen model provider bills — there is no Cline account
  // in the picture. The links that help are the SDK's own docs plus the console
  // for the default provider.
  cline: [
    { label: "Cline SDK docs", href: "https://docs.cline.bot/sdk/overview", note: "The agent runtime callboard embeds" },
    { label: "Model providers", href: "https://docs.cline.bot/sdk/model-providers", note: "Provider ids and credentials the SDK accepts" },
    { label: "Console billing", href: "https://console.anthropic.com/settings/billing", note: "Anthropic credits, for the default provider" },
  ],
  // Same shape as Cline: pi embeds a runtime rather than wrapping a service, so
  // billing lives with whichever model provider the user points it at. Its
  // default is OpenRouter, which is where the useful links go.
  //
  // Phase 3 adds this entry because `Record<UiAgentProviderKind, …>` demands it
  // once `"pi"` joins the union — the pi *tab* and its credential form are
  // Phase 4.
  pi: [
    { label: "pi on npm", href: "https://www.npmjs.com/package/@earendil-works/pi-coding-agent", note: "The agent runtime callboard embeds" },
    { label: "pi source", href: "https://github.com/earendil-works/pi", note: "Tools, extensions and session format" },
    { label: "OpenRouter credits", href: "https://openrouter.ai/settings/credits", note: "Credit balance, for the default provider" },
  ],
};

/**
 * An ACP vendor's status from `/api/system-info` alone.
 *
 * `acpProviders` carries the two facts that matter most — is the binary there,
 * and what is it called — and it arrives with the rest of the page rather than
 * behind a registry lookup. So a missing `/api/engines` answer costs the version
 * rows and nothing else, instead of blanking the tab.
 *
 * Credentials are `"unknown"` here for the same reason they are on the real
 * status: ACP has no auth introspection, and this path knows strictly less than
 * that one does.
 */
function acpFallbackEngine(vendor: AcpProviderInfo): EngineStatus {
  return {
    id: vendor.id,
    label: vendor.label,
    runtime: { kind: "external", command: vendor.command },
    installed: vendor.available,
    credentials: {
      configured: "unknown",
      note: `Held by the ${vendor.label} CLI, never by Callboard. ACP gives a client no way to ask whether an agent is signed in.`,
    },
  };
}

/**
 * Read-only status for one ACP vendor.
 *
 * Every other tab on this page edits credentials callboard holds. This one has
 * none to edit, and that is the point rather than an omission: ACP's model is
 * that credentials belong to the vendor CLI — `initialize` advertises
 * `authMethods` and never a place to hand over a key — so the useful thing to
 * show is what callboard *does* know, and what it does to the agent it spawns.
 *
 * The CLI and Credentials rows this used to render itself are now
 * {@link EngineStatusCard}'s Runtime and Credentials rows — an ACP vendor is
 * the one genuinely install-or-not engine on the page, so it is the shared
 * card's first consumer rather than a parallel implementation of it. What is
 * left here is what the card cannot know: the permission override callboard
 * applies to sessions it launches (invisible otherwise, and it materially
 * changes how the agent behaves) and the harvested model catalog.
 *
 * When `/api/engines` has not answered — a cold registry lookup, or a failed
 * call — the card falls back to {@link acpFallbackEngine} rather than to a
 * placeholder. `systemInfo.acpProviders` already carries `available` and
 * `command` synchronously, and dropping to "Checking engine status…" would take
 * the single most actionable line on the page ("`opencode` not found on PATH")
 * away from exactly the user who needs it.
 */
function AcpProviderSection({
  vendor,
  engine,
  enginesLoading,
  onRecheckEngines,
  onEnginesUpdated,
  useOpenRouter,
  onUseOpenRouterChange,
  openRouterApiKey,
  onOpenRouterApiKeyChange,
  accountKeySet,
}: {
  vendor: AcpProviderInfo;
  /** This vendor's row from `GET /api/engines`; absent while it loads or if the call failed. */
  engine: EngineStatus | undefined;
  enginesLoading: boolean;
  /** Drop the daemon's cached lookups and re-probe — the card's Recheck button. */
  onRecheckEngines: () => Promise<EngineRecheckOutcome>;
  /** Adopt the statuses the server re-probed after running an install from this card. */
  onEnginesUpdated: (engines: EngineStatus[]) => void;
  useOpenRouter: boolean;
  onUseOpenRouterChange: (v: boolean) => void;
  openRouterApiKey: string;
  onOpenRouterApiKeyChange: (v: string) => void;
  /** Whether the account-wide OpenRouter key is set, so the copy can say what blank falls back to. */
  accountKeySet: boolean;
}) {
  const [catalog, setCatalog] = useState<AcpModelCatalogInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    getAcpModels(vendor.id)
      .then((c) => {
        if (!cancelled) setCatalog(c);
      })
      .catch(() => {
        // A vendor with no catalog is the normal cold-start state, not an error.
      });
    return () => {
      cancelled = true;
    };
  }, [vendor.id]);

  return (
    <>
      <EngineStatusCard engine={engine ?? acpFallbackEngine(vendor)} loading={enginesLoading} onRecheck={onRecheckEngines} onEnginesUpdated={onEnginesUpdated} />

      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
          <Plug size={14} style={{ color: "var(--accent-text)" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Session behaviour</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Agent Client Protocol</span>
        </div>

        <StatusRow label="Permissions">
          Callboard runs this agent with every tool set to <code style={{ fontSize: 11 }}>ask</code>, so its own four axes decide. Without that override the
          vendor&rsquo;s defaults apply and the permission settings here would govern nothing.
        </StatusRow>

        <StatusRow label="Models">
          {catalog && catalog.models.length > 0 ? (
            <>
              {catalog.models.length} known{catalog.currentValue ? <> · last ran {<code style={{ fontSize: 11 }}>{catalog.currentValue}</code>}</> : null}
            </>
          ) : (
            <>None yet — the list is learned from chats you run, so it fills in after the first one.</>
          )}
        </StatusRow>
      </div>

      <div style={sectionStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
          <Network size={14} style={{ color: "var(--accent-text)" }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>OpenRouter</span>
        </div>
        <div style={{ ...helpStyle, marginTop: 0, marginBottom: 10 }}>
          Hand {vendor.label} an OpenRouter key so its own OpenRouter provider works. Nothing about the agent is rewritten — it simply gains the
          <code style={{ fontSize: 11 }}> openrouter/&hellip; </code> models in the per-chat model picker alongside whatever it already had.
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 10 }}>
          <input type="checkbox" checked={useOpenRouter} onChange={(e) => onUseOpenRouterChange(e.target.checked)} />
          <span style={{ fontSize: 13, color: "var(--text)" }}>Give ACP agents an OpenRouter key</span>
        </label>

        {useOpenRouter && (
          <div style={fieldWrap}>
            <label htmlFor="acp-or-key" style={labelStyle}>
              OpenRouter API key
            </label>
            <input
              id="acp-or-key"
              type="password"
              value={openRouterApiKey}
              onChange={(e) => onOpenRouterApiKeyChange(e.target.value)}
              placeholder={accountKeySet ? "Leave empty to use your account-wide OpenRouter key" : "sk-or-v1-…"}
              style={inputStyle}
              autoComplete="off"
            />
            <div style={helpStyle}>
              Optional. Blank uses the key from the OpenRouter tab
              {accountKeySet ? "" : ", which is not set yet — without one of the two, nothing is passed"}. Delivered as{" "}
              <code style={{ fontSize: 11 }}>OPENROUTER_API_KEY</code> to the process Callboard spawns, and only to vendors recorded as reading it.
            </div>
          </div>
        )}
      </div>

      <ReferenceLinksSection provider="acp" />
    </>
  );
}

function ReferenceLinksSection({ provider }: { provider: SettingsTab }) {
  const links = providerReferenceLinks[provider];
  return (
    <div style={{ ...sectionStyle, padding: "10px 12px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <Globe size={14} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>Reference</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            Usage, billing, and limits
          </span>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            target="_blank"
            rel="noreferrer"
            title={link.note ? `${link.note}: ${link.href}` : link.href}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 7px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 11,
              lineHeight: 1,
              textDecoration: "none",
              whiteSpace: "nowrap",
            }}
          >
            {link.label}
            <ExternalLink size={10} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          </a>
        ))}
      </div>
    </div>
  );
}

/**
 * A source field's value, or `undefined` when it names no source.
 *
 * The Agent SDK returns the literal string `"none"` rather than omitting these
 * fields when there is no credential, so rendering them raw printed
 * "Current token source: none" — three rows above a Credentials row that had
 * just been taught to disregard exactly that value. One page, one SDK field,
 * two answers.
 *
 * Mirrors `namedSource` in `backend/src/services/engine-status.ts`; kept as a
 * small duplicate rather than shared because this is a display concern and that
 * one is a status decision, and coupling them would mean a settings page
 * importing from the engine-status service.
 */
function namedSource(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return undefined;
  return trimmed;
}

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

/**
 * "Run *my* binary, not the one you found" — the field behind
 * `pathToClaudeCodeExecutable` and `codexPathOverride`.
 *
 * ## Why the validation is a round trip
 *
 * The path is on the **daemon's** filesystem, not the browser's, and the three
 * things that decide whether it will work — does it exist, is it a regular file,
 * does the user running the daemon hold an execute bit on it — are all questions
 * only the daemon can answer. So this asks it, on a debounce, through the same
 * `utils/binary-path.ts` check the resolver applies when a chat starts. A
 * browser-side "looks like a path" regex would have been free and would have
 * agreed with the resolver exactly until the first time it mattered.
 *
 * ## What the field claims, and what it does not
 *
 * A green tick here means "Callboard would accept this path", which is not the
 * same as "this is in effect" — the value has not been saved yet, and until it
 * is, chats keep running whatever they ran before. The **status card at the top
 * of the tab is the authority** on what actually runs, it re-probes on save, and
 * this help text points at it rather than implying the tick settled the matter.
 * The distance between those two claims is the entire bug this feature has
 * produced ten times.
 *
 * A blank field is neither valid nor invalid: it is the default, and it is
 * rendered as plain help text.
 */
function BinaryOverrideField({
  id,
  engineId,
  value,
  onChange,
  placeholder,
  help,
}: {
  id: string;
  /** Selects the fallback sentence the daemon returns. */
  engineId: "claude-code" | "codex";
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** What this override means for this engine, rendered above the check result. */
  help: React.ReactNode;
}) {
  /**
   * The last answer received, tagged with the path it was *about*.
   *
   * Tagged rather than cleared on every keystroke, and that is the whole
   * anti-staleness mechanism: {@link current} below only accepts an answer whose
   * `path` matches what is in the box right now, so an in-flight check for a
   * half-typed path can never be rendered as a verdict on the finished one. It
   * also means the effect never has to write state synchronously to erase a
   * previous result — there is nothing to erase, only something that stops
   * matching.
   */
  const [check, setCheck] = useState<EngineBinaryCheckResponse | null>(null);
  /**
   * The path whose check failed to reach the daemon at all.
   *
   * A third outcome, kept apart from both a verdict and "still waiting". Not
   * claiming "invalid" on a failed request is right — that would be a statement
   * about the user's filesystem from something that never looked at it — but the
   * previous cut said *nothing*, so a daemon that had gone away left the field
   * spinning "Checking…" forever with no way to tell that apart from a slow
   * answer. Saying which one it is costs one line and one piece of state.
   */
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const trimmed = value.trim();

  useEffect(() => {
    if (!trimmed) return;
    // Debounced, and aborted on every keystroke and on unmount — the abort is
    // what stops the daemon fielding a request per character.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkEngineBinary(trimmed, engineId, controller.signal)
        .then((result) => {
          if (!controller.signal.aborted) setCheck(result);
        })
        .catch(() => {
          // Report that Callboard could not ask — never that the answer was no.
          if (!controller.signal.aborted) setUnreachable(trimmed);
        });
    }, 350);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [trimmed, engineId]);

  // Both pieces of state are tagged with the path they are about, so neither a
  // stale verdict nor a stale failure can be rendered against a path the user
  // has since edited.
  const current = check && check.path === trimmed ? check : null;
  const failed = unreachable === trimmed && !current;
  const ok = current?.state === "active";
  const bad = Boolean(current && current.state && current.state !== "active");
  const checking = Boolean(trimmed) && !current && !failed;

  return (
    <div style={fieldWrap}>
      <label htmlFor={id} style={labelStyle}>
        Binary path
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        style={{ ...inputStyle, borderColor: bad ? "var(--warning)" : ok ? "var(--success)" : "var(--border)" }}
      />
      <div style={helpStyle}>{help}</div>
      {trimmed ? (
        <div style={{ ...helpStyle, display: "flex", gap: 5, alignItems: "flex-start", marginTop: 4 }}>
          {checking ? (
            <span style={{ color: "var(--text-muted)" }}>Checking&hellip;</span>
          ) : ok ? (
            <>
              <CheckCircle2 size={12} style={{ color: "var(--success)", flexShrink: 0, marginTop: 1 }} />
              <span>
                Callboard can run this. It takes effect when you save — the status card at the top of this tab then reports which binary chats are actually
                using.
              </span>
            </>
          ) : bad ? (
            <>
              <AlertTriangle size={12} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 1 }} />
              <span>{inlineCode(current!.detail)}</span>
            </>
          ) : failed ? (
            <>
              <AlertTriangle size={12} style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 1 }} />
              <span>
                Callboard could not reach the daemon to check this path, so it does not know whether it will work. The path itself may be perfectly fine —
                saving still stores it, and the status card above reports what actually happens.
              </span>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Render backtick spans in a backend-authored sentence as `<code>`.
 *
 * Same job as `EngineStatusCard`'s `withInlineCode`, on strings written in the
 * same place and in the same voice — the check details name paths and `chmod`
 * commands, and prose that renders them as plain text in one card and as code in
 * another reads as two different products.
 */
function inlineCode(text: string): React.ReactNode {
  return text.split("`").map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} style={{ fontSize: 11 }}>
        {part}
      </code>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

interface OpenRouterRoutingSectionProps {
  /** Which native harness this routes — drives copy and the key env-var label. */
  harness: "Claude Code" | "Codex";
  enabled: boolean;
  onToggle: (on: boolean) => void;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  /** Default endpoint used when the override below is blank — shown as placeholder. */
  endpoint: string;
  /** Endpoint override (blank ⇒ use {@link endpoint}). Lets users pick a regional URL. */
  baseUrl: string;
  onBaseUrlChange: (v: string) => void;
  /** Env var the key is exposed as (ANTHROPIC_AUTH_TOKEN / OPENROUTER_API_KEY). */
  keyEnvLabel: string;
  /** Harness-specific caveats rendered under the key field when routing is on. */
  caveats: React.ReactNode;
  /** True when the ambient env already routes this harness through OpenRouter. */
  detected: boolean;
}

/**
 * "Route through OpenRouter" toggle for a native harness. When on, the harness's
 * API endpoint points at OpenRouter and is authenticated with a dedicated
 * OpenRouter key; the manual endpoint/auth fields above are hidden and the model
 * pickers switch to OpenRouter's catalog. The endpoint defaults to OpenRouter's
 * global URL but is overridable so users can target regional (US/EU) endpoints.
 */
function OpenRouterRoutingSection({
  harness,
  enabled,
  onToggle,
  apiKey,
  onApiKeyChange,
  endpoint,
  baseUrl,
  onBaseUrlChange,
  keyEnvLabel,
  caveats,
  detected,
}: OpenRouterRoutingSectionProps) {
  return (
    <div style={sectionStyle}>
      <div style={headerStyle}>
        <Network size={16} style={{ color: "var(--accent-text)" }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Route through OpenRouter</span>
      </div>
      <div style={subtitleStyle}>
        Run the native {harness} harness but send its requests to OpenRouter, authenticated with an OpenRouter API key. The model picker below switches to
        OpenRouter&apos;s catalog.
      </div>
      {detected && (
        <div style={{ ...helpStyle, marginTop: 0, marginBottom: 12, color: "var(--accent-text)" }}>
          Detected OpenRouter in your environment — enabled by default. Add a key below to manage it through callboard, then Save.
        </div>
      )}
      <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginBottom: enabled ? 14 : 0 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} style={{ flexShrink: 0 }} />
        <span style={{ fontSize: 13, color: "var(--text)" }}>Use OpenRouter as the {harness} endpoint</span>
      </label>
      {enabled && (
        <>
          <div style={fieldWrap}>
            <label htmlFor={`${harness}-or-base-url`} style={labelStyle}>
              Endpoint<span style={envLabelStyle}>optional</span>
            </label>
            <input
              id={`${harness}-or-base-url`}
              type="text"
              value={baseUrl}
              onChange={(e) => onBaseUrlChange(e.target.value)}
              placeholder={endpoint}
              autoComplete="off"
              spellCheck={false}
              style={inputStyle}
            />
            <div style={helpStyle}>
              {detected && !apiKey.trim()
                ? "Leave blank to keep the endpoint your environment already set."
                : `Leave blank for OpenRouter's default (${endpoint}).`}{" "}
              Override to target a regional endpoint (US/EU) or proxy — include the full path, e.g.{" "}
              <code>{endpoint.replace("https://openrouter.ai", "https://eu.openrouter.ai")}</code>. An override always wins, including over the environment.
            </div>
          </div>
          <div style={fieldWrap}>
            <label htmlFor={`${harness}-or-key`} style={labelStyle}>
              OpenRouter API Key<span style={envLabelStyle}>{keyEnvLabel}</span>
            </label>
            <SecretField id={`${harness}-or-key`} value={apiKey} onChange={onApiKeyChange} placeholder="sk-or-..." />
            <div style={helpStyle}>Create one at openrouter.ai/keys. Stored separately from the account-wide OpenRouter key.</div>
          </div>
          <div style={{ ...helpStyle, lineHeight: 1.5 }}>{caveats}</div>
        </>
      )}
    </div>
  );
}

/**
 * Newest `anthropic/claude-<role>-<version>` slug in the OpenRouter catalog
 * (e.g. `anthropic/claude-opus-4.8`), used as the placeholder/default for the
 * Claude-Code-via-OpenRouter role pickers. Mirrors the backend resolver in
 * openrouter-models.ts so the UI shows what the env builder will actually use.
 * Returns undefined when the catalog is empty or has no match.
 */
function latestAnthropicRoleSlug(models: OpenRouterModelInfo[], role: "opus" | "sonnet" | "haiku"): string | undefined {
  const re = new RegExp(`^anthropic/claude-${role}-(\\d+(?:\\.\\d+)?)$`);
  let best: { ver: number[]; id: string } | undefined;
  for (const m of models) {
    const match = re.exec(m.id);
    if (!match) continue;
    const ver = match[1].split(".").map((n) => parseInt(n, 10));
    const isNewer =
      !best ||
      (() => {
        for (let i = 0; i < Math.max(ver.length, best.ver.length); i++) {
          const a = ver[i] ?? 0;
          const b = best.ver[i] ?? 0;
          if (a !== b) return a > b;
        }
        return false;
      })();
    if (isNewer) best = { ver, id: m.id };
  }
  return best?.id;
}

export default function ApiSettings() {
  // Top-level integration toggle — picks which provider's settings are shown.
  // Seeded from the user's New Chat default so the page opens on the provider
  // they actually use; purely a view selector, not persisted back.
  const [activeProvider, setActiveProvider] = useState<SettingsTab>(() => getDefaultProvider());
  // Which ACP vendor the "acp" tab is showing. `activeProvider` is a KIND, and
  // `acp` is one kind covering many CLIs, so the vendor needs its own slot —
  // the same split the chat metadata and the New Chat picker already make.
  const [activeAcpProviderId, setActiveAcpProviderId] = useState("");

  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  // Per-engine runtime / version / credential status, from GET /api/engines.
  // Its own call rather than more fields on system-info: it reaches the npm
  // registry, so it is slower than the poll system-info is built for, and the
  // page must render without waiting for it.
  const [engines, setEngines] = useState<EngineStatus[]>([]);
  const [enginesLoading, setEnginesLoading] = useState(true);
  /**
   * Monotonic id for the newest engine request, so a slower earlier one cannot
   * overwrite it.
   *
   * Two call sites write `engines`: the page load and the Recheck button. A
   * Recheck is *deliberately* slower than a load — it drops the daemon's caches
   * and re-probes — so a reload landing on top of one, or a second Recheck
   * overtaking the first, would have restored the very answer the user pressed
   * the button to get rid of. A ref rather than state: it must be readable
   * synchronously and must not itself cause a render.
   */
  const enginesRequestId = useRef(0);
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
  // Binary overrides — "run my copy, not the one you found". Two engines have
  // one; Cline and pi are in-process libraries with no subprocess to point
  // elsewhere, so they get no field rather than a disabled one.
  const [pathToClaudeCodeExecutable, setPathToClaudeCodeExecutable] = useState("");
  const [codexPathOverride, setCodexPathOverride] = useState("");
  // Claude Code → OpenRouter endpoint routing
  const [claudeCodeUseOpenRouter, setClaudeCodeUseOpenRouter] = useState(false);
  const [claudeCodeOpenRouterApiKey, setClaudeCodeOpenRouterApiKey] = useState("");
  const [claudeCodeOpenRouterBaseUrl, setClaudeCodeOpenRouterBaseUrl] = useState("");
  // Model overrides while routed through OpenRouter. Deliberately separate from
  // the five generic model fields above so flipping the toggle doesn't leave the
  // other mode pointing at a slug its endpoint can't resolve.
  const [claudeCodeOpenRouterModel, setClaudeCodeOpenRouterModel] = useState("");
  const [claudeCodeOpenRouterOpusModel, setClaudeCodeOpenRouterOpusModel] = useState("");
  const [claudeCodeOpenRouterSonnetModel, setClaudeCodeOpenRouterSonnetModel] = useState("");
  const [claudeCodeOpenRouterHaikuModel, setClaudeCodeOpenRouterHaikuModel] = useState("");
  const [claudeCodeOpenRouterSubagentModel, setClaudeCodeOpenRouterSubagentModel] = useState("");
  // OpenRouter as a service: the account key, plus the utility completions it
  // can pay for (chat titles, branch names, themes). Not a harness — see the
  // SettingsTab doc-comment.
  const [openRouterApiKey, setOpenRouterApiKey] = useState("");
  const [openRouterBaseUrl, setOpenRouterBaseUrl] = useState("");
  const [openRouterUtilityCompletions, setOpenRouterUtilityCompletions] = useState(false);
  const [openRouterUtilityHaikuModel, setOpenRouterUtilityHaikuModel] = useState("");
  const [openRouterUtilitySonnetModel, setOpenRouterUtilitySonnetModel] = useState("");
  const [openRouterUtilityOpusModel, setOpenRouterUtilityOpusModel] = useState("");
  // Catalog models, for the role-model placeholders on the routed-harness tabs.
  const [orModels, setOrModels] = useState<OpenRouterModelInfo[]>([]);
  // Codex (alternative provider, subscription-auth) overrides.
  const [codexAuthMode, setCodexAuthMode] = useState<"subscription" | "api-key">("subscription");
  const [codexApiKey, setCodexApiKey] = useState("");
  const [codexBaseUrl, setCodexBaseUrl] = useState("");
  const [codexModel, setCodexModel] = useState("");
  const [codexHome, setCodexHome] = useState("");
  const [codexSandboxMode, setCodexSandboxMode] = useState<"read-only" | "workspace-write" | "danger-full-access">("workspace-write");
  // Codex → OpenRouter endpoint routing
  const [codexUseOpenRouter, setCodexUseOpenRouter] = useState(false);
  const [codexOpenRouterApiKey, setCodexOpenRouterApiKey] = useState("");
  // ACP → OpenRouter. Unlike the two above this rewrites nothing in the agent's
  // config; it only hands the vendor a key, so there is no base-URL or model
  // pair to keep alongside it.
  const [acpUseOpenRouter, setAcpUseOpenRouter] = useState(false);
  const [acpOpenRouterApiKey, setAcpOpenRouterApiKey] = useState("");
  const [codexOpenRouterBaseUrl, setCodexOpenRouterBaseUrl] = useState("");
  const [codexOpenRouterModel, setCodexOpenRouterModel] = useState("");
  // Cline (embedded SDK). No auth *mode* to pick: the runtime is in-process and
  // takes credentials as config, falling back to its own env lookup when blank.
  const [clineProviderId, setClineProviderId] = useState("");
  const [clineModel, setClineModel] = useState("");
  const [clineApiKey, setClineApiKey] = useState("");
  const [clineBaseUrl, setClineBaseUrl] = useState("");
  const [clineMaxIterations, setClineMaxIterations] = useState("");
  const [clineProviders, setClineProviders] = useState<string[]>([]);
  const [piProviderId, setPiProviderId] = useState("");
  const [piModel, setPiModel] = useState("");
  const [piApiKey, setPiApiKey] = useState("");
  const [piBaseUrl, setPiBaseUrl] = useState("");
  const [piProviders, setPiProviders] = useState<string[]>([]);

  const loadAll = async () => {
    setLoading(true);

    // Engine status, kicked off before anything that can throw and never
    // awaited with the rest. Two reasons it lives out here: a cold registry
    // lookup must not hold the whole page on "Loading...", and as the last
    // statement of the try below it was skipped whenever settings failed to
    // load — leaving every tab saying "Checking engine status…" forever,
    // underneath the error banner.
    setEnginesLoading(true);
    const requestId = ++enginesRequestId.current;
    getEngines()
      .then((fresh) => {
        if (enginesRequestId.current === requestId) setEngines(fresh);
      })
      .catch(() => {
        if (enginesRequestId.current === requestId) setEngines([]);
      })
      .finally(() => {
        if (enginesRequestId.current === requestId) setEnginesLoading(false);
      });

    try {
      // `refresh` on every one of this page's five system-info reads. It is the
      // page where the things this payload reports get *changed* — keys, binary
      // overrides, routing toggles, engine installs — so the stale-while-
      // revalidate default would show a user the state they just left. `loadData`
      // is also what a save re-runs, which is why the initial load takes it too.
      const [s, sys] = await Promise.all([getAgentSettings(), getSystemInfo({ refresh: true }).catch(() => null)]);
      setSettings(s);
      setSystemInfo(sys);
      // Seed the ACP tab's vendor. The kind alone cannot say which one, so a
      // user whose New Chat default is an ACP vendor would otherwise land on a
      // selected tab with an empty body. Prefer their saved pick, then anything
      // installed, then whatever is configured.
      const vendors = sys?.acpProviders ?? [];
      if (vendors.length > 0) {
        const saved = getDefaultAcpProviderId();
        const pick = vendors.find((v) => v.id === saved) ?? vendors.find((v) => v.available) ?? vendors[0];
        setActiveAcpProviderId((current) => current || pick.id);
      }
      setApiBaseUrl(s.apiBaseUrl ?? "");
      setApiKey(s.apiKey ?? "");
      setAuthToken(s.authToken ?? "");
      setModel(s.model ?? "");
      setDefaultOpusModel(s.defaultOpusModel ?? "");
      setDefaultSonnetModel(s.defaultSonnetModel ?? "");
      setDefaultHaikuModel(s.defaultHaikuModel ?? "");
      setSubagentModel(s.subagentModel ?? "");
      setPathToClaudeCodeExecutable(s.pathToClaudeCodeExecutable ?? "");
      // Default the toggle on when the ambient env already routes through
      // OpenRouter and the user hasn't explicitly saved a choice yet.
      setClaudeCodeUseOpenRouter(s.claudeCodeUseOpenRouter ?? Boolean(sys?.claudeCodeOpenRouterDetected));
      setClaudeCodeOpenRouterApiKey(s.claudeCodeOpenRouterApiKey ?? "");
      setClaudeCodeOpenRouterBaseUrl(s.claudeCodeOpenRouterBaseUrl ?? "");
      setClaudeCodeOpenRouterModel(s.claudeCodeOpenRouterModel ?? "");
      setClaudeCodeOpenRouterOpusModel(s.claudeCodeOpenRouterOpusModel ?? "");
      setClaudeCodeOpenRouterSonnetModel(s.claudeCodeOpenRouterSonnetModel ?? "");
      setClaudeCodeOpenRouterHaikuModel(s.claudeCodeOpenRouterHaikuModel ?? "");
      setClaudeCodeOpenRouterSubagentModel(s.claudeCodeOpenRouterSubagentModel ?? "");
      setOpenRouterApiKey(s.openRouterApiKey ?? "");
      setOpenRouterBaseUrl(s.openRouterBaseUrl ?? "");
      setOpenRouterUtilityCompletions(Boolean(s.openRouterUtilityCompletions));
      setOpenRouterUtilityHaikuModel(s.openRouterUtilityHaikuModel ?? "");
      setOpenRouterUtilitySonnetModel(s.openRouterUtilitySonnetModel ?? "");
      setOpenRouterUtilityOpusModel(s.openRouterUtilityOpusModel ?? "");
      setPiProviderId(s.piProviderId ?? "");
      setPiModel(s.piModel ?? "");
      setPiApiKey(s.piApiKey ?? "");
      setPiBaseUrl(s.piBaseUrl ?? "");
      setCodexAuthMode(s.codexAuthMode ?? "subscription");
      setCodexApiKey(s.codexApiKey ?? "");
      setCodexBaseUrl(s.codexBaseUrl ?? "");
      setCodexModel(s.codexModel ?? "");
      setCodexHome(s.codexHome ?? "");
      setCodexPathOverride(s.codexPathOverride ?? "");
      setCodexSandboxMode(s.codexSandboxMode ?? "workspace-write");
      setCodexUseOpenRouter(s.codexUseOpenRouter ?? Boolean(sys?.codexOpenRouterDetected));
      setCodexOpenRouterApiKey(s.codexOpenRouterApiKey ?? "");
      setAcpUseOpenRouter(Boolean(s.acpUseOpenRouter));
      setAcpOpenRouterApiKey(s.acpOpenRouterApiKey ?? "");
      setCodexOpenRouterBaseUrl(s.codexOpenRouterBaseUrl ?? "");
      setCodexOpenRouterModel(s.codexOpenRouterModel ?? "");
      setClineProviderId(s.clineProviderId ?? "");
      setClineModel(s.clineModel ?? "");
      setClineApiKey(s.clineApiKey ?? "");
      setClineBaseUrl(s.clineBaseUrl ?? "");
      setClineMaxIterations(typeof s.clineMaxIterations === "number" ? String(s.clineMaxIterations) : "");
      // Provider list comes from the SDK, not a table here. Best-effort: the
      // fields are free text, so an offline backend degrades to typing an id.
      getClineProviders()
        .then(({ providers }) => setClineProviders(providers))
        .catch(() => {});
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

    // Did this save move a binary override? Captured *before* the write, because
    // `setSettings(updated)` below replaces the value being compared against.
    //
    // The server drops its resolution caches when one of these changes, so the
    // card would eventually tell the truth — but only after someone pressed
    // Recheck. Between saving and pressing it, the card would go on describing
    // the previous binary, which is the exact state this feature keeps shipping:
    // a settings page reporting a machine it has not looked at since.
    const overridesChanged =
      pathToClaudeCodeExecutable.trim() !== (settings?.pathToClaudeCodeExecutable ?? "").trim() ||
      codexPathOverride.trim() !== (settings?.codexPathOverride ?? "").trim();

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
        pathToClaudeCodeExecutable,
        claudeCodeUseOpenRouter,
        claudeCodeOpenRouterApiKey,
        claudeCodeOpenRouterBaseUrl,
        claudeCodeOpenRouterModel,
        claudeCodeOpenRouterOpusModel,
        claudeCodeOpenRouterSonnetModel,
        claudeCodeOpenRouterHaikuModel,
        claudeCodeOpenRouterSubagentModel,
        openRouterApiKey,
        openRouterBaseUrl,
        openRouterUtilityCompletions,
        openRouterUtilityHaikuModel,
        openRouterUtilitySonnetModel,
        openRouterUtilityOpusModel,
        piProviderId,
        piModel,
        piApiKey,
        piBaseUrl,
        // Codex provider settings. Auth mode + sandbox mode are enums with a
        // defined default, so they're always sent; the key/url/model/home are
        // free-text overrides that fall back to the ambient env when empty.
        codexAuthMode,
        codexApiKey,
        codexBaseUrl,
        codexModel,
        codexHome,
        codexPathOverride,
        codexSandboxMode,
        codexUseOpenRouter,
        codexOpenRouterApiKey,
        codexOpenRouterBaseUrl,
        codexOpenRouterModel,
        acpUseOpenRouter,
        acpOpenRouterApiKey,
        clineProviderId,
        clineModel,
        clineApiKey,
        clineBaseUrl,
        // Blank clears the override so the SDK's own ceiling applies; a
        // non-numeric entry is dropped rather than saved as NaN.
        clineMaxIterations: clineMaxIterations.trim() ? Number(clineMaxIterations.trim()) || undefined : undefined,
      });
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      // Re-read so the status card names the binary that is now in effect
      // rather than the one that was.
      //
      // A plain `getEngines()`, **not** the Recheck path. Recheck exists to drop
      // the daemon's caches, and is rate-limited to one real probe every ten
      // seconds precisely because it spawns processes — so two saves inside that
      // window returned the *previous* probe's statuses with `probed: false`,
      // which this code then adopted unconditionally as if they were current.
      // The card would show the override the user had just replaced. Nothing
      // here needs the reset anyway: the PUT dropped those caches server-side
      // before it responded, so an ordinary read already sees the new
      // resolution, and it is neither throttled nor a spawn.
      //
      // Errors are swallowed here and only here: the save itself succeeded, and
      // turning a failed follow-up read into a red "Failed to save settings"
      // would report the wrong outcome for the thing the user pressed. A stale
      // card is recoverable with Recheck; a false failure sends someone looking
      // for a problem that is not there.
      if (overridesChanged) {
        const requestId = ++enginesRequestId.current;
        void getEngines()
          .then((fresh) => {
            if (enginesRequestId.current === requestId) {
              setEngines(fresh);
              setEnginesLoading(false);
            }
          })
          .catch(() => {});
      }
      // Re-fetch system info so the Account / Models display reflects new overrides.
      // The backend kicks off a refresh on save; give it a moment before polling.
      setTimeout(() => {
        getSystemInfo({ refresh: true })
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
      const sys = await getSystemInfo({ refresh: true });
      setSystemInfo(sys);
    } catch {
      /* ignore */
    }
  };

  /**
   * "Recheck" on any engine card — re-probe every engine, not just this tab's.
   *
   * One call for all of them because the server-side reset is global: the caches
   * it drops are per-daemon, not per-engine, so probing one and leaving the rest
   * on stale answers would be a distinction the backend does not make.
   *
   * `systemInfo` is refreshed alongside it because `acpProviders[].available`
   * comes from the same PATH lookup that was just invalidated — without this the
   * tab strip and the New Chat picker would keep the pre-install answer while the
   * card showed the new one.
   *
   * Errors propagate: {@link EngineStatusCard}'s button owns the failure state,
   * and swallowing them here would leave it showing a success it did not have.
   */
  const handleRecheckEngines = async (): Promise<EngineRecheckOutcome> => {
    const requestId = ++enginesRequestId.current;
    const { engines: fresh, probed, retryAfterMs } = await refreshEngines();
    if (enginesRequestId.current !== requestId) return { probed, retryAfterMs };
    setEngines(fresh);
    setEnginesLoading(false);
    try {
      const sys = await getSystemInfo({ refresh: true });
      if (enginesRequestId.current === requestId) setSystemInfo(sys);
    } catch {
      // The engine list is the answer the button promised; a stale tab strip is
      // a smaller lie than a failed Recheck that actually worked.
    }
    return { probed, retryAfterMs };
  };

  /**
   * Adopt the statuses the server re-probed after an install it ran itself.
   *
   * The install endpoint drops the same caches Recheck does and re-assembles
   * every engine, so this is a Recheck's answer arriving without the button
   * being pressed — which is the point: a user who installs from the card should
   * not then have to ask the card to look.
   *
   * It claims the request id for the same reason {@link handleRecheckEngines}
   * does. An install outlives most page fetches, and a `GET /api/engines` issued
   * before it finished would otherwise land afterwards and overwrite this with
   * the pre-install answer — the card would say "Installed" over a row that had
   * reverted to "Not installed".
   *
   * `systemInfo` is refreshed alongside it because `acpProviders[].available`
   * feeds the New Chat picker from the same lookup.
   */
  const handleEnginesUpdated = (fresh: EngineStatus[]) => {
    if (fresh.length === 0) return; // a refresh that failed server-side; keep what we have
    const requestId = ++enginesRequestId.current;
    setEngines(fresh);
    setEnginesLoading(false);
    void getSystemInfo({ refresh: true })
      .then((sys) => {
        if (enginesRequestId.current === requestId) setSystemInfo(sys);
      })
      .catch(() => {
        // A stale tab strip is a smaller lie than dropping the install's result.
      });
  };

  if (loading) {
    return <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>;
  }

  const account = systemInfo?.account;
  const models = systemInfo?.models ?? [];

  /**
   * The engine backing a tab.
   *
   * `"openrouter"` deliberately maps to nothing: it is a service credential, not
   * an engine — see the {@link SettingsTab} doc-comment — so it gets no status
   * card and no dot. Inventing a row for it would be the same kind of lie as an
   * "installed ✓" column on a bundled engine.
   */
  const engineFor = (tab: SettingsTab, acpId?: string): EngineStatus | undefined => {
    const id = tab === "acp" ? acpId : tab === "openrouter" ? undefined : tab;
    if (!id) return undefined;
    const engine = engines.find((e) => e.id === id);
    if (engine) return engine;
    // An ACP vendor knows enough from system-info alone to show a dot, so its
    // tab is not left blank while /api/engines is in flight or after it failed.
    const vendor = tab === "acp" ? (systemInfo?.acpProviders ?? []).find((v) => v.id === id) : undefined;
    return vendor ? acpFallbackEngine(vendor) : undefined;
  };

  // Inline alias validation — mirrors the backend's write-time rules so the
  // user sees the problem before Save bounces with a 400.

  return (
    <>
      {/* Integration toggle — Claude Code and OpenRouter as first-class providers */}
      <div
        style={{
          display: "flex",
          // Wraps: the row was built for three fixed tabs, and each configured
          // ACP vendor adds another.
          flexWrap: "wrap",
          borderRadius: 8,
          border: "1px solid var(--border)",
          overflow: "hidden",
          marginBottom: 16,
        }}
      >
        {[
          { kind: "claude-code" as SettingsTab, label: "Claude Code", icon: <Bot size={14} />, acpId: "" },
          { kind: "openrouter" as SettingsTab, label: "OpenRouter", icon: <Network size={14} />, acpId: "" },
          { kind: "codex" as SettingsTab, label: "Codex", icon: <Terminal size={14} />, acpId: "" },
          { kind: "cline" as SettingsTab, label: "Cline", icon: <Boxes size={14} />, acpId: "" },
          { kind: "pi" as SettingsTab, label: "pi", icon: <Boxes size={14} />, acpId: "" },
          // One tab per configured ACP vendor rather than a single "ACP" tab:
          // a user picks OpenCode here the same way they pick it in New Chat,
          // and the page has nothing to say about the protocol in the abstract.
          ...(systemInfo?.acpProviders ?? []).map((v) => ({
            kind: "acp" as SettingsTab,
            label: v.label,
            icon: <Plug size={14} />,
            acpId: v.id,
          })),
        ].map(({ kind, label, icon, acpId }, idx, arr) => {
          // Two tabs share the `acp` kind, so the vendor has to match as well or
          // every ACP tab would highlight at once.
          const isActiveTab = activeProvider === kind && (!acpId || activeAcpProviderId === acpId);
          return (
            <button
              key={acpId || kind}
              onClick={() => {
                setActiveProvider(kind);
                if (acpId) setActiveAcpProviderId(acpId);
              }}
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
                borderRight: idx < arr.length - 1 ? "1px solid var(--border)" : "none",
                background: isActiveTab ? "var(--accent)" : "var(--surface)",
                color: isActiveTab ? "var(--text-on-accent)" : "var(--text)",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              {icon}
              {label}
              {/* Installed + credentialed / installed + uncredentialed / not
                  installed, in that order of colour. Rendered only once the
                  engine is known — a placeholder dot while /api/engines is in
                  flight would read as a state rather than as an absence. The
                  OpenRouter tab never has one: it is a service credential
                  rather than an engine. */}
              {(() => {
                const engine = engineFor(kind, acpId);
                return engine ? <EngineStatusDot engine={engine} /> : null;
              })()}
            </button>
          );
        })}
      </div>

      {activeProvider === "claude-code" && (
        <>
          <EngineStatusCard engine={engineFor("claude-code")} loading={enginesLoading} onRecheck={handleRecheckEngines} onEnginesUpdated={handleEnginesUpdated} />
          <ReferenceLinksSection provider="claude-code" />

          <OpenRouterRoutingSection
            harness="Claude Code"
            enabled={claudeCodeUseOpenRouter}
            onToggle={setClaudeCodeUseOpenRouter}
            apiKey={claudeCodeOpenRouterApiKey}
            onApiKeyChange={setClaudeCodeOpenRouterApiKey}
            baseUrl={claudeCodeOpenRouterBaseUrl}
            onBaseUrlChange={setClaudeCodeOpenRouterBaseUrl}
            detected={Boolean(systemInfo?.claudeCodeOpenRouterDetected)}
            endpoint="https://openrouter.ai/api"
            keyEnvLabel="ANTHROPIC_AUTH_TOKEN"
            caveats={
              <>
                Sets <code>ANTHROPIC_BASE_URL</code> to the endpoint above and forces <code>ANTHROPIC_API_KEY</code> empty. Claude Code is optimized for
                Anthropic models — pick <code>anthropic/*</code> slugs below for best results. If you previously logged in to Anthropic directly, run{" "}
                <code>/logout</code> in a chat to clear any cached session conflict.
              </>
            }
          />

          {/* API Endpoint — manual overrides are unused while routing through OpenRouter. */}
          {!claudeCodeUseOpenRouter && (
            <div style={sectionStyle}>
              <div style={headerStyle}>
                <Globe size={16} style={{ color: "var(--accent-text)" }} />
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
          )}

          {/* Authentication — managed by OpenRouter while routing is on. */}
          {!claudeCodeUseOpenRouter && (
            <div style={sectionStyle}>
              <div style={headerStyle}>
                <Key size={16} style={{ color: "var(--accent-text)" }} />
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
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)" }}>{namedSource(account?.tokenSource) ?? "—"}</span>
                </div>
                <div style={rowStyle}>
                  <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>Current API key source</span>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)" }}>
                    {truncateSensitive(namedSource(account?.apiKeySource), 4)}
                  </span>
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
          )}

          {/* Binary — deliberately OUTSIDE the OpenRouter guard above. Routing
              through OpenRouter changes the endpoint and the credential; the
              Agent SDK still spawns a `claude` either way, so hiding this field
              in that mode would hide the setting from exactly the users most
              likely to be running a hand-built CLI. */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <HardDrive size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Claude Code Binary</span>
            </div>
            <div style={subtitleStyle}>
              Which <code style={{ fontSize: 11 }}>claude</code> the Agent SDK runs. Leave this empty and Callboard looks for a native{" "}
              <code style={{ fontSize: 11 }}>claude</code> on its <code style={{ fontSize: 11 }}>PATH</code>, then falls back to the binary bundled with the
              Agent SDK.
            </div>
            <BinaryOverrideField
              id="pathToClaudeCodeExecutable"
              engineId="claude-code"
              value={pathToClaudeCodeExecutable}
              onChange={setPathToClaudeCodeExecutable}
              placeholder="/usr/local/bin/claude"
              help={
                <>
                  Absolute path on the machine running Callboard. Set this to pin a specific build — a local checkout, a version you have not upgraded, or an
                  install somewhere the daemon&rsquo;s <code style={{ fontSize: 11 }}>PATH</code> does not reach. Clearing it restores the default lookup. Note
                  it does <em>not</em> change the binary behind the About page&rsquo;s CLI version or the login prompt: that is a separate lookup, and the status
                  card above says so when the two disagree.
                </>
              }
            />
          </div>

          {/* Models */}
          <div style={sectionStyle}>
            <div style={{ ...headerStyle, justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Cpu size={16} style={{ color: "var(--accent-text)" }} />
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
            <div style={subtitleStyle}>
              {claudeCodeUseOpenRouter
                ? "Pick OpenRouter slugs for the session model and the opus / sonnet / haiku aliases (anthropic/* listed first). Blank role fields default to the newest matching anthropic/* model in the OpenRouter catalog. Saved separately from your direct-endpoint models, so turning routing off restores those."
                : "Override which model is used for the session and what the `opus`, `sonnet`, and `haiku` aliases resolve to. Saved separately from your OpenRouter models, so turning routing back on restores those."}
            </div>

            {/* Currently available models (SDK catalog — hidden while routing through OpenRouter) */}
            {!claudeCodeUseOpenRouter && models.length > 0 && (
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
              {claudeCodeUseOpenRouter ? (
                <OpenRouterModelSelector
                  id="model"
                  value={claudeCodeOpenRouterModel}
                  onChange={setClaudeCodeOpenRouterModel}
                  priorityPrefix="anthropic/"
                  placeholder="anthropic/claude-opus-4.7"
                />
              ) : (
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
              )}
              <div style={helpStyle}>
                {claudeCodeUseOpenRouter
                  ? "OpenRouter model slug (or a configured alias). Applies to new sessions."
                  : "Alias (opus, sonnet, haiku, opusplan) or full model ID. Applies to new sessions."}
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="opusModel" style={labelStyle}>
                Opus Alias Target<span style={envLabelStyle}>ANTHROPIC_DEFAULT_OPUS_MODEL</span>
              </label>
              {claudeCodeUseOpenRouter ? (
                <OpenRouterModelSelector
                  id="opusModel"
                  value={claudeCodeOpenRouterOpusModel}
                  onChange={setClaudeCodeOpenRouterOpusModel}
                  priorityPrefix="anthropic/"
                  placeholder={latestAnthropicRoleSlug(orModels, "opus") ?? "anthropic/claude-opus-4.8"}
                />
              ) : (
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
              )}
            </div>

            <div style={fieldWrap}>
              <label htmlFor="sonnetModel" style={labelStyle}>
                Sonnet Alias Target<span style={envLabelStyle}>ANTHROPIC_DEFAULT_SONNET_MODEL</span>
              </label>
              {claudeCodeUseOpenRouter ? (
                <OpenRouterModelSelector
                  id="sonnetModel"
                  value={claudeCodeOpenRouterSonnetModel}
                  onChange={setClaudeCodeOpenRouterSonnetModel}
                  priorityPrefix="anthropic/"
                  placeholder={latestAnthropicRoleSlug(orModels, "sonnet") ?? "anthropic/claude-sonnet-4.6"}
                />
              ) : (
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
              )}
            </div>

            <div style={fieldWrap}>
              <label htmlFor="haikuModel" style={labelStyle}>
                Haiku Alias Target<span style={envLabelStyle}>ANTHROPIC_DEFAULT_HAIKU_MODEL</span>
              </label>
              {claudeCodeUseOpenRouter ? (
                <OpenRouterModelSelector
                  id="haikuModel"
                  value={claudeCodeOpenRouterHaikuModel}
                  onChange={setClaudeCodeOpenRouterHaikuModel}
                  priorityPrefix="anthropic/"
                  placeholder={latestAnthropicRoleSlug(orModels, "haiku") ?? "anthropic/claude-haiku-4.5"}
                />
              ) : (
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
              )}
              <div style={helpStyle}>Also used for background tasks. Replaces the deprecated ANTHROPIC_SMALL_FAST_MODEL.</div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="subagentModel" style={labelStyle}>
                Subagent Model<span style={envLabelStyle}>CLAUDE_CODE_SUBAGENT_MODEL</span>
              </label>
              {claudeCodeUseOpenRouter ? (
                <OpenRouterModelSelector
                  id="subagentModel"
                  value={claudeCodeOpenRouterSubagentModel}
                  onChange={setClaudeCodeOpenRouterSubagentModel}
                  priorityPrefix="anthropic/"
                  placeholder={latestAnthropicRoleSlug(orModels, "sonnet") ?? "anthropic/claude-sonnet-4.6"}
                />
              ) : (
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
              )}
            </div>
          </div>
        </>
      )}

      {activeProvider === "openrouter" && (
        <>
          <ReferenceLinksSection provider="openrouter" />

          {/* OpenRouter — the credential itself */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Network size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>OpenRouter</span>
            </div>
            <div style={subtitleStyle}>
              An OpenRouter account key, used by the features below rather than by a harness of its own. To run a coding harness on OpenRouter, turn on
              &ldquo;Route through OpenRouter&rdquo; on the Claude Code or Codex tab — each keeps its own key.
            </div>

            <div style={fieldWrap}>
              <label htmlFor="openRouterApiKey" style={labelStyle}>
                API Key<span style={envLabelStyle}>OPENROUTER_API_KEY</span>
              </label>
              <SecretField id="openRouterApiKey" value={openRouterApiKey} onChange={setOpenRouterApiKey} placeholder="sk-or-..." />
              <div style={helpStyle}>
                Create one at openrouter.ai/keys. Also handed to ACP agents when the key on their own tab is blank, so a single key can cover both.
              </div>
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
              <div style={helpStyle}>
                Optional. Override the OpenRouter API endpoint (proxies / regional mirrors). Used for both the model catalog and the completions below.
              </div>
            </div>
          </div>

          {/* OpenRouter — utility completions */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Cpu size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Utility completions</span>
            </div>
            <div style={subtitleStyle}>
              Callboard makes a few small model calls of its own: naming a chat, naming a branch, generating a theme. They run on Claude Code by default and
              need no configuration; point them at OpenRouter to bill them to your OpenRouter credits instead.
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginBottom: openRouterUtilityCompletions ? 14 : 0 }}>
              <input
                type="checkbox"
                checked={openRouterUtilityCompletions}
                onChange={(e) => setOpenRouterUtilityCompletions(e.target.checked)}
                style={{ flexShrink: 0 }}
              />
              <span style={{ fontSize: 13, color: "var(--text)" }}>Use OpenRouter for chat titles, branch names and themes</span>
            </label>

            {openRouterUtilityCompletions && (
              <>
                {!openRouterApiKey.trim() && (
                  <div style={{ ...helpStyle, marginTop: 0, marginBottom: 12, color: "var(--warning)" }}>
                    No API key above — these calls fall back to Claude Code until one is saved.
                  </div>
                )}

                <div style={fieldWrap}>
                  <label htmlFor="openRouterUtilityHaikuModel" style={labelStyle}>
                    Haiku tier
                  </label>
                  <OpenRouterModelSelector
                    id="openRouterUtilityHaikuModel"
                    value={openRouterUtilityHaikuModel}
                    onChange={setOpenRouterUtilityHaikuModel}
                    placeholder="~anthropic/claude-haiku-latest"
                  />
                  <div style={helpStyle}>Chat titles and branch names. Keep this one cheap and fast — it runs on every new chat.</div>
                </div>

                <div style={fieldWrap}>
                  <label htmlFor="openRouterUtilitySonnetModel" style={labelStyle}>
                    Sonnet tier
                  </label>
                  <OpenRouterModelSelector
                    id="openRouterUtilitySonnetModel"
                    value={openRouterUtilitySonnetModel}
                    onChange={setOpenRouterUtilitySonnetModel}
                    placeholder="~anthropic/claude-sonnet-latest"
                  />
                  <div style={helpStyle}>Theme generation, which asks for ~90 colour values in two modes and wants the better model.</div>
                </div>

                <div style={fieldWrap}>
                  <label htmlFor="openRouterUtilityOpusModel" style={labelStyle}>
                    Opus tier
                  </label>
                  <OpenRouterModelSelector
                    id="openRouterUtilityOpusModel"
                    value={openRouterUtilityOpusModel}
                    onChange={setOpenRouterUtilityOpusModel}
                    placeholder="~anthropic/claude-opus-latest"
                  />
                  <div style={helpStyle}>Nothing asks for this tier today; it exists so a future caller has somewhere to point.</div>
                </div>

                <div style={{ ...helpStyle, marginTop: 0 }}>
                  Leave a field blank to use OpenRouter&rsquo;s own <code style={{ fontSize: 11 }}>~anthropic/claude-&lt;tier&gt;-latest</code> alias, which
                  resolves server-side to the current model of that tier.
                </div>
              </>
            )}
          </div>
        </>
      )}

      {activeProvider === "acp" &&
        (() => {
          const vendor = (systemInfo?.acpProviders ?? []).find((v) => v.id === activeAcpProviderId);
          return vendor ? (
            <AcpProviderSection
              vendor={vendor}
              engine={engineFor("acp", vendor.id)}
              onRecheckEngines={handleRecheckEngines}
              onEnginesUpdated={handleEnginesUpdated}
              enginesLoading={enginesLoading}
              useOpenRouter={acpUseOpenRouter}
              onUseOpenRouterChange={setAcpUseOpenRouter}
              openRouterApiKey={acpOpenRouterApiKey}
              onOpenRouterApiKeyChange={setAcpOpenRouterApiKey}
              accountKeySet={Boolean(settings?.openRouterApiKey?.trim())}
            />
          ) : null;
        })()}

      {activeProvider === "codex" && (
        <>
          <EngineStatusCard engine={engineFor("codex")} loading={enginesLoading} onRecheck={handleRecheckEngines} onEnginesUpdated={handleEnginesUpdated} />
          <ReferenceLinksSection provider="codex" />

          <OpenRouterRoutingSection
            harness="Codex"
            enabled={codexUseOpenRouter}
            onToggle={setCodexUseOpenRouter}
            apiKey={codexOpenRouterApiKey}
            onApiKeyChange={setCodexOpenRouterApiKey}
            baseUrl={codexOpenRouterBaseUrl}
            onBaseUrlChange={setCodexOpenRouterBaseUrl}
            detected={Boolean(systemInfo?.codexOpenRouterDetected)}
            endpoint="https://openrouter.ai/api/v1"
            keyEnvLabel="OPENROUTER_API_KEY"
            caveats={
              <>
                Adds a <code>[model_providers.openrouter]</code> block to Codex&apos;s config with <code>wire_api=&quot;responses&quot;</code>. Only models that
                support the Responses API work reliably — <code>openai/*</code> slugs are listed first below. Non-OpenAI models may fail at runtime.
              </>
            }
          />

          {/* Codex — auth mode (managed by OpenRouter while routing is on). */}
          {!codexUseOpenRouter && (
            <div style={sectionStyle}>
              <div style={headerStyle}>
                <Terminal size={16} style={{ color: "var(--accent-text)" }} />
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>OpenAI Codex</span>
              </div>
              <div style={subtitleStyle}>
                Run chats on OpenAI Codex. Authenticate with your ChatGPT subscription (recommended on a personal machine — personal use only) or a raw OpenAI
                API key.
              </div>

              {/* Auth-mode toggle */}
              <div style={fieldWrap}>
                <label style={labelStyle}>Authentication mode</label>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  {[
                    { mode: "subscription" as const, label: "Subscription (ChatGPT login)" },
                    { mode: "api-key" as const, label: "API key" },
                  ].map(({ mode, label }) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setCodexAuthMode(mode)}
                      style={{
                        flex: 1,
                        padding: "8px 12px",
                        fontSize: 13,
                        fontWeight: 500,
                        borderRadius: 6,
                        border: codexAuthMode === mode ? "1px solid var(--accent)" : "1px solid var(--border)",
                        background: codexAuthMode === mode ? "var(--accent)" : "var(--surface)",
                        color: codexAuthMode === mode ? "var(--text-on-accent)" : "var(--text)",
                        cursor: "pointer",
                        transition: "all 0.15s",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {codexAuthMode === "subscription" ? (
                <>
                  {/* Auth status from /system-info (no key field in this mode). */}
                  <div style={{ marginBottom: 14 }}>
                    <div style={rowStyle}>
                      <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>Codex auth status</span>
                      <span style={{ fontFamily: "monospace", fontSize: 12, color: systemInfo?.codexConfigured ? "var(--text)" : "var(--text-muted)" }}>
                        {systemInfo?.codexAuthSource === "auth.json"
                          ? "Logged in (auth.json found)"
                          : systemInfo?.codexAuthSource === "config.toml"
                            ? "Configured via config.toml"
                            : systemInfo?.codexConfigured
                              ? "Configured"
                              : "Not configured"}
                      </span>
                    </div>
                  </div>
                  {!systemInfo?.codexConfigured && (
                    <div style={{ ...helpStyle, marginTop: 0, marginBottom: 14 }}>
                      Run <code style={{ fontSize: 11 }}>codex login</code> once in a terminal to authenticate with your ChatGPT account (credentials stored in{" "}
                      <code style={{ fontSize: 11 }}>$CODEX_HOME/auth.json</code>), or declare a <code style={{ fontSize: 11 }}>model_provider</code> in{" "}
                      <code style={{ fontSize: 11 }}>$CODEX_HOME/config.toml</code>. After configuring, click refresh below.
                    </div>
                  )}
                  <button
                    onClick={handleRefresh}
                    title="Re-check login status"
                    style={{
                      background: "var(--surface)",
                      color: "var(--text-muted)",
                      padding: "6px 12px",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <RefreshCw size={14} /> Re-check status
                  </button>
                </>
              ) : (
                <>
                  <div style={fieldWrap}>
                    <label htmlFor="codexApiKey" style={labelStyle}>
                      API Key<span style={envLabelStyle}>OPENAI_API_KEY</span>
                    </label>
                    <SecretField id="codexApiKey" value={codexApiKey} onChange={setCodexApiKey} placeholder="sk-..." />
                    <div style={helpStyle}>Billed to your OpenAI API account rather than your ChatGPT subscription.</div>
                  </div>
                  <div style={fieldWrap}>
                    <label htmlFor="codexBaseUrl" style={labelStyle}>
                      Base URL<span style={envLabelStyle}>OPENAI_BASE_URL</span>
                    </label>
                    <input
                      id="codexBaseUrl"
                      type="text"
                      value={codexBaseUrl}
                      onChange={(e) => setCodexBaseUrl(e.target.value)}
                      placeholder="https://api.openai.com/v1"
                      autoComplete="off"
                      spellCheck={false}
                      style={inputStyle}
                    />
                    <div style={helpStyle}>Optional. Override the OpenAI API endpoint (proxies / gateways).</div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Codex — model + sandbox */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Cpu size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Model &amp; Sandbox</span>
            </div>
            <div style={subtitleStyle}>Default model for new Codex chats and the sandbox the Codex agent runs commands under.</div>

            <div style={fieldWrap}>
              <label htmlFor="codexModel" style={labelStyle}>
                Default Model
              </label>
              {codexUseOpenRouter ? (
                <OpenRouterModelSelector
                  id="codexModel"
                  value={codexOpenRouterModel}
                  onChange={setCodexOpenRouterModel}
                  priorityPrefix="openai/"
                  placeholder="openai/gpt-5.5-codex"
                />
              ) : (
                <CodexModelSelector id="codexModel" value={codexModel} onChange={setCodexModel} placeholder="gpt-5.5" />
              )}
              <div style={helpStyle}>
                {codexUseOpenRouter
                  ? "OpenRouter model slug (openai/* recommended). Free text accepted — OpenRouter validates the model. Saved separately from your native Codex model, so turning routing off restores it."
                  : "Start typing to filter the live Codex model catalog. Free text accepted — the CLI validates the model. Saved separately from your OpenRouter model, so turning routing back on restores it."}
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="codexSandboxMode" style={labelStyle}>
                Sandbox Mode
              </label>
              <select
                id="codexSandboxMode"
                value={codexSandboxMode}
                onChange={(e) => setCodexSandboxMode(e.target.value as typeof codexSandboxMode)}
                style={{ ...inputStyle, fontFamily: "inherit", cursor: "pointer" }}
              >
                <option value="read-only">read-only — no writes or command execution</option>
                <option value="workspace-write">workspace-write — edit files in the working dir</option>
                <option value="danger-full-access">danger-full-access — unrestricted (use with care)</option>
              </select>
              <div style={helpStyle}>
                Per-chat permission toggles further constrain this when a session starts. <code style={{ fontSize: 11 }}>danger-full-access</code> lets the
                agent run any command without approval.
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="codexHome" style={labelStyle}>
                Codex Home<span style={envLabelStyle}>CODEX_HOME</span>
              </label>
              <input
                id="codexHome"
                type="text"
                value={codexHome}
                onChange={(e) => setCodexHome(e.target.value)}
                placeholder="~/.codex"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={helpStyle}>
                Optional. Directory where Codex stores <code style={{ fontSize: 11 }}>auth.json</code> and the sessions tree. Defaults to{" "}
                <code style={{ fontSize: 11 }}>~/.codex</code>.
              </div>
            </div>
          </div>

          {/* Codex — which binary. The interesting one, because the Codex card
              also offers `npm i -g @openai/codex` for a completely different
              reason: that install exists so `codex login` is a command you have.
              Until this field is set it changes nothing about chats, and the
              copy on both sides has to keep saying so — an install recipe that
              silently became "and now it runs your chats too" is the same class
              of surprise as a card claiming an override that is not in effect. */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <HardDrive size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Codex Binary</span>
            </div>
            <div style={subtitleStyle}>
              Which <code style={{ fontSize: 11 }}>codex</code> runs your chats. Leave this empty and Callboard uses the platform binary bundled with{" "}
              <code style={{ fontSize: 11 }}>@openai/codex-sdk</code>, which is what it has always done. There is no{" "}
              <code style={{ fontSize: 11 }}>PATH</code> search behind this field: it is your path or the bundled copy, nothing in between.
            </div>
            <BinaryOverrideField
              id="codexPathOverride"
              engineId="codex"
              value={codexPathOverride}
              onChange={setCodexPathOverride}
              placeholder={engineFor("codex")?.userCliPath || "/usr/local/bin/codex"}
              help={
                <>
                  {engineFor("codex")?.userCliPath ? (
                    <>
                      You already have a <code style={{ fontSize: 11 }}>codex</code> at{" "}
                      <code style={{ fontSize: 11 }}>{engineFor("codex")?.userCliPath}</code> — the one{" "}
                      <code style={{ fontSize: 11 }}>codex login</code> runs. Setting it here makes chats run it too.{" "}
                    </>
                  ) : (
                    <>
                      Absolute path on the machine running Callboard. If you installed the CLI globally with{" "}
                      <code style={{ fontSize: 11 }}>npm i -g @openai/codex</code>, <code style={{ fontSize: 11 }}>which codex</code> in a terminal will print
                      it.{" "}
                    </>
                  )}
                  Auth and sessions do not move: an overridden binary still reads{" "}
                  <code style={{ fontSize: 11 }}>$CODEX_HOME/auth.json</code> and writes to the same rollout tree. Clearing this returns to the bundled binary.
                  Point it at a real install rather than a loose binary if you can — the Codex SDK stops adding its own bundled helpers (
                  <code style={{ fontSize: 11 }}>rg</code>, <code style={{ fontSize: 11 }}>bwrap</code>) to the subprocess&rsquo;s{" "}
                  <code style={{ fontSize: 11 }}>PATH</code> once you name a binary yourself, so a copy that did not bring its own may lose search or
                  sandboxing inside chats.
                </>
              }
            />
          </div>
        </>
      )}

      {activeProvider === "pi" && (
        <>
          <EngineStatusCard engine={engineFor("pi")} loading={enginesLoading} onRecheck={handleRecheckEngines} onEnginesUpdated={handleEnginesUpdated} />
          <ReferenceLinksSection provider="pi" />

          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Key size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Provider &amp; Credentials</span>
            </div>
            <div style={subtitleStyle}>
              pi runs <strong>inside Callboard</strong> — no CLI to install, no account to sign into. It brings its own coding tools and talks directly to the
              model provider you pick here, using your key. Credentials are handed to the runtime per session and never written to your own{" "}
              <code style={{ fontSize: 11 }}>~/.pi/agent/auth.json</code>.
            </div>

            <div style={fieldWrap}>
              <label htmlFor="piProviderId" style={labelStyle}>
                Provider
              </label>
              <input
                id="piProviderId"
                type="text"
                list="pi-provider-ids"
                value={piProviderId}
                onChange={(e) => setPiProviderId(e.target.value)}
                onFocus={() => {
                  if (piProviders.length === 0) {
                    getPiProviders()
                      .then(({ providers }) => setPiProviders(providers))
                      .catch(() => {});
                  }
                }}
                placeholder="openrouter"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <datalist id="pi-provider-ids">
                {piProviders.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <div style={helpStyle}>
                Which model provider the pi runtime talks to. Blank means <code style={{ fontSize: 11 }}>openrouter</code> — pi is the agent underneath
                OpenRouter&rsquo;s Ori, and its bundled catalog carries ~300 OpenRouter models offline. The list comes from the installed package.
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="piApiKey" style={labelStyle}>
                API Key
              </label>
              <SecretField id="piApiKey" value={piApiKey} onChange={setPiApiKey} placeholder="sk-or-v1-..." />
              <div style={helpStyle}>
                Optional. Left blank, pi falls back to its own environment lookup (<code style={{ fontSize: 11 }}>OPENROUTER_API_KEY</code>, …). A key set here
                <strong> wins</strong> over one in the environment, so a shell variable cannot silently take over a chat you configured differently.
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="piBaseUrl" style={labelStyle}>
                Base URL
              </label>
              <input
                id="piBaseUrl"
                type="text"
                value={piBaseUrl}
                onChange={(e) => setPiBaseUrl(e.target.value)}
                placeholder="(the provider&rsquo;s own endpoint)"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={helpStyle}>
                Optional override for a self-hosted or proxying endpoint. Applied on top of the provider above, so its model catalog is kept — only the URL
                moves. Not needed for OpenRouter, which is a provider here rather than a mode.
              </div>
            </div>
          </div>

          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Cpu size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Model</span>
            </div>
            <div style={subtitleStyle}>Default model for new pi chats. Each chat can override it in the New Chat panel or the composer.</div>

            <div style={fieldWrap}>
              <label htmlFor="piModel" style={labelStyle}>
                Default Model
              </label>
              <PiModelSelector id="piModel" value={piModel} onChange={setPiModel} placeholder="google/gemini-3.6-flash" providerId={piProviderId} />
              <div style={helpStyle}>
                Type to filter — this catalog is large (~300 models on OpenRouter), so the list narrows as you type rather than showing everything. Free text is
                accepted for a slug newer than the bundled catalog; pi falls back to its own default if it does not recognise one.
              </div>
            </div>
          </div>
        </>
      )}

      {activeProvider === "cline" && (
        <>
          <EngineStatusCard engine={engineFor("cline")} loading={enginesLoading} onRecheck={handleRecheckEngines} onEnginesUpdated={handleEnginesUpdated} />
          <ReferenceLinksSection provider="cline" />

          {/* Cline — provider + credentials */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Key size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Provider &amp; Credentials</span>
            </div>
            <div style={subtitleStyle}>
              Cline runs <strong>inside Callboard</strong> — there is no CLI to install and no Cline account to sign into. It brings its own coding tools and
              talks directly to the model provider you pick here, using your key.
            </div>

            <div style={fieldWrap}>
              <label htmlFor="clineProviderId" style={labelStyle}>
                Provider
              </label>
              <input
                id="clineProviderId"
                type="text"
                list="cline-provider-ids"
                value={clineProviderId}
                onChange={(e) => setClineProviderId(e.target.value)}
                placeholder="anthropic"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <datalist id="cline-provider-ids">
                {clineProviders.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <div style={helpStyle}>
                Which model provider the Cline runtime talks to. Blank means <code style={{ fontSize: 11 }}>anthropic</code>. The list comes from the installed
                SDK. OpenRouter is one of them — pick <code style={{ fontSize: 11 }}>openrouter</code> and put your OpenRouter key below; no base URL needed.
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="clineApiKey" style={labelStyle}>
                API Key
              </label>
              <SecretField id="clineApiKey" value={clineApiKey} onChange={setClineApiKey} placeholder="sk-..." />
              <div style={helpStyle}>
                Optional. Left blank, the runtime falls back to its own environment lookup (<code style={{ fontSize: 11 }}>ANTHROPIC_API_KEY</code>,{" "}
                <code style={{ fontSize: 11 }}>OPENAI_API_KEY</code>, the AWS credential chain, …), so a machine that already has those configured needs nothing
                here.
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="clineBaseUrl" style={labelStyle}>
                Base URL
              </label>
              <input
                id="clineBaseUrl"
                type="text"
                value={clineBaseUrl}
                onChange={(e) => setClineBaseUrl(e.target.value)}
                placeholder="https://my-llm-host.internal/v1"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={helpStyle}>
                Optional. Endpoint override — needed only for a self-hosted or OpenAI-compatible service. OpenRouter has its own provider id and does not need
                one.
              </div>
            </div>
          </div>

          {/* Cline — model + loop ceiling */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Cpu size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Model &amp; Limits</span>
            </div>
            <div style={subtitleStyle}>Default model for new Cline chats, and how long a single turn may loop.</div>

            <div style={fieldWrap}>
              <label htmlFor="clineModel" style={labelStyle}>
                Default Model
              </label>
              {/* The same combobox the New Chat panel uses, scoped to the
                  provider selected above — so changing the provider re-scopes
                  the suggestions immediately, including to OpenRouter's list. */}
              <ClineModelSelector
                id="clineModel"
                value={clineModel}
                onChange={setClineModel}
                providerId={clineProviderId.trim() || "anthropic"}
                placeholder="claude-sonnet-5"
              />
              <div style={helpStyle}>
                Free text accepted — the provider validates the model. Leave empty and Cline uses its own default for the provider. An empty suggestion list
                means the provider could not be reached, not that it has no models.
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="clineMaxIterations" style={labelStyle}>
                Max Iterations
              </label>
              <input
                id="clineMaxIterations"
                type="number"
                min={1}
                value={clineMaxIterations}
                onChange={(e) => setClineMaxIterations(e.target.value)}
                placeholder="(SDK default)"
                autoComplete="off"
                style={inputStyle}
              />
              <div style={helpStyle}>
                Optional ceiling on agent-loop iterations per turn. A chat that hits it ends with &ldquo;max turns reached&rdquo; rather than an error.
              </div>
            </div>
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
      ) : activeProvider === "openrouter" ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 16, lineHeight: 1.5 }}>
          Overrides are applied as environment variables when Callboard spawns an OpenRouter session. They take effect for new sessions; resume an existing chat
          to pick up the new settings. Leave a field empty to fall back to the ambient environment.
        </div>
      ) : activeProvider === "acp" ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 16, lineHeight: 1.5 }}>
          An ACP agent&rsquo;s own credentials live in its CLI, so the only thing to set here is whether Callboard also hands it an OpenRouter key. Pick the
          model per chat in the New Chat panel or the composer, and set what it may do under Permissions.
        </div>
      ) : activeProvider === "pi" ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 16, lineHeight: 1.5 }}>
          These are read when a pi chat starts, so they take effect for new sessions; resume an existing chat to pick them up. The runtime is embedded, so
          nothing is spawned and no environment is rewritten — a blank field falls through to whatever the backend process already has, and an explicit key here
          takes priority over one in the environment. What the agent is allowed to do is set under Permissions, and Callboard asks before every tool call it has
          not been told to allow. Note that <strong>third-party MCP servers do not apply to pi chats</strong>: pi has no MCP client, so a pi chat sees
          Callboard&rsquo;s own tools and pi&rsquo;s seven built-ins, and nothing else.
        </div>
      ) : activeProvider === "cline" ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 16, lineHeight: 1.5 }}>
          These are read when a Cline chat starts, so they take effect for new sessions; resume an existing chat to pick them up. Nothing is spawned and no
          environment is rewritten — the runtime is embedded, so a blank field simply falls through to whatever the backend process already has. What the agent
          is allowed to do is set under Permissions, and Callboard asks before every tool call it has not been told to allow.
        </div>
      ) : (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 16, lineHeight: 1.5 }}>
          Codex settings are applied when Callboard spawns the Codex CLI. They take effect for new sessions; resume an existing chat to pick up the new
          settings. In subscription mode, auth is read from <code style={{ fontSize: 11 }}>$CODEX_HOME/auth.json</code> (run{" "}
          <code style={{ fontSize: 11 }}>codex login</code> once); in API-key mode, leave a field empty to fall back to the ambient environment.
        </div>
      )}
    </>
  );
}
