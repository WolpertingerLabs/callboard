import { useEffect, useRef, useState } from "react";
import { Key, Globe, Cpu, Eye, EyeOff, RefreshCw, Bot, Network, Terminal, Boxes, ExternalLink, AlertTriangle, CheckCircle2, HardDrive } from "lucide-react";
import {
  getAgentSettings,
  updateAgentSettings,
  getSystemInfo,
  getOpenRouterCatalog,
  getPiProviders,
  getEngines,
  refreshEngines,
  checkEngineBinary,
} from "../../api";
import PiModelSelector from "../../components/PiModelSelector";
import { EMPTY_API_SETTINGS_FORM, formFromSettings, settingsFromForm, type ApiSettingsForm } from "./apiSettingsForm";
import { selectMaskedSecret } from "./maskedSecret";
import {
  readClaudeCredentialMode,
  writeClaudeCredentialMode,
  readCodexCredentialMode,
  writeCodexCredentialMode,
  claudeOpenRouterCredentialReady,
  codexOpenRouterCredentialReady,
  type ClaudeCredentialMode,
  type CodexCredentialMode,
} from "./credentialMode";
import EngineStatusCard, { EngineStatusDot } from "./EngineStatusCard";
import ChatRetentionSection from "./ChatRetentionSection";
import type { EngineRecheckOutcome } from "./EngineStatusCard";
import type { AgentSettings, OpenRouterModelInfo } from "shared/types/index.js";
import type { SystemInfo, EngineStatus, EngineBinaryCheckResponse } from "../../api";
import OpenRouterModelSelector from "../../components/OpenRouterModelSelector";
import CodexModelSelector from "../../components/CodexModelSelector";
import { getDefaultProvider } from "../../utils/localStorage";
import type { AgentProviderKind } from "../../utils/localStorage";
import { errorMessage } from "../../utils/errorMessage";
import { sectionStyle, headerStyle, subtitleStyle } from "./styles";

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
 * native harnesses' OpenRouter routing and the model catalog, so this page is where an
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
  // pi embeds a runtime rather than wrapping a service, so
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
        onFocus={selectMaskedSecret}
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

/**
 * A muted "this is configured but not in use" marker for a section header.
 *
 * The sections it sits on used to unmount instead. That hid the one fact the
 * page most needs to state — that both credentials are set up and only one is
 * running — and made turning routing on read as destroying the other setup
 * rather than parking it.
 */
function InactiveBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: "var(--text-muted)",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 999,
        padding: "2px 8px",
        lineHeight: 1.5,
      }}
    >
      {children}
    </span>
  );
}

interface OpenRouterRoutingSectionProps {
  /** Which native harness this routes — drives copy and the key env-var label. */
  harness: "Claude Code" | "Codex";
  /** What the Credentials control is on instead, or undefined while this one is live. */
  inactiveNote?: string;
  apiKey: string;
  onApiKeyChange: (v: string) => void;
  /** Default endpoint used when the override below is blank — shown as placeholder. */
  endpoint: string;
  /** Endpoint override (blank ⇒ use {@link endpoint}). Lets users pick a regional URL. */
  baseUrl: string;
  onBaseUrlChange: (v: string) => void;
  /** Env var the key is exposed as (ANTHROPIC_AUTH_TOKEN / OPENROUTER_API_KEY). */
  keyEnvLabel: string;
  /**
   * Harness-specific caveats — what this credential does to the harness's config
   * once it is the selected one. Rendered whichever credential is selected, so
   * they have to read as true in both states: an "Adds a … block" under an
   * `Inactive` badge contradicts the badge three lines above it.
   */
  caveats: React.ReactNode;
  /** True when the ambient env already routes this harness through OpenRouter. */
  detected: boolean;
}

/**
 * The OpenRouter half of a native harness's credentials: the key it is
 * authenticated with and the endpoint it points at. When it is the selected
 * mode, the harness's API endpoint points at OpenRouter and the model pickers
 * switch to OpenRouter's catalog. The endpoint defaults to OpenRouter's global
 * URL but is overridable so users can target regional (US/EU) endpoints.
 *
 * *Whether* it is selected belongs to the Credentials control at the top of the
 * tab; this section no longer owns a switch. The fields stay mounted and
 * editable when it is not selected, because the Credentials control disables its
 * OpenRouter segment until a key is stored — so "add a key first" has to name a
 * field the user can actually see from where they are standing.
 */
function OpenRouterRoutingSection({
  harness,
  inactiveNote,
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
        {inactiveNote && <InactiveBadge>Inactive — {inactiveNote}</InactiveBadge>}
      </div>
      <div style={subtitleStyle}>
        The OpenRouter half of {harness}&rsquo;s credentials: the key it authenticates with, and the endpoint it points at. Picking OpenRouter under Credentials
        above runs the native {harness} harness against these instead of its own vendor, and switches the model picker below to OpenRouter&apos;s catalog.
      </div>
      {detected && (
        <div style={{ ...helpStyle, marginTop: 0, marginBottom: 12, color: "var(--accent-text)" }}>
          {/* Two sentences rather than one, because the two harnesses genuinely
              differ here — see codexOpenRouterCredentialReady for why a detected
              env is enough on its own for Claude Code and not for Codex. */}
          {harness === "Claude Code"
            ? "Detected OpenRouter in your environment. Picking OpenRouter under Credentials above will use that environment's endpoint and key as-is; set them here instead, and Save, to manage them through Callboard."
            : "Detected OpenRouter in your environment. Callboard leaves that wiring alone rather than replacing it with its own — so to run Codex on OpenRouter through Callboard, add a key here, or an endpoint above to override the environment's, and Save first."}
        </div>
      )}
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
    </div>
  );
}

/**
 * The instant-save controls on this page, as keys.
 *
 * Three of them, and their saving/error state is keyed by these rather than
 * shared — see `credentialErrors`.
 */
type CredentialControl = "claude" | "codex" | "codexParkedAuth";

interface SegmentOption<M extends string> {
  mode: M;
  label: string;
  /**
   * Why this segment cannot be picked, or undefined when it can. Rendered under
   * the control, so a disabled segment says what would enable it.
   */
  disabledReason?: string;
}

/**
 * The two native Codex credentials, named once.
 *
 * The parked-login picker inside the Codex section offers the same two the
 * Credentials control's first two segments do, and giving them two sets of names
 * ("Subscription (ChatGPT login)" against "ChatGPT subscription") read as two
 * different settings rather than one setting seen from two places.
 */
const CODEX_NATIVE_CREDENTIALS: SegmentOption<"subscription" | "api-key">[] = [
  { mode: "subscription", label: "ChatGPT subscription" },
  { mode: "api-key", label: "OpenAI API key" },
];

/**
 * One row of mutually exclusive buttons.
 *
 * Shared because the Codex tab renders two of them and they are *not* the same
 * decision — Credentials picks what runs now, the picker inside the parked Codex
 * section picks what "switching back" will land on. Two copies of this markup is
 * how they came to look like one control duplicated.
 *
 * A blocked segment is dimmed even when it is the selected one: selection and
 * effect can disagree (a stored flag whose key was later cleared), and a segment
 * that is both cannot be allowed to render as fully live.
 */
function SegmentedControl<M extends string>({
  value,
  options,
  onSelect,
  busy,
}: {
  value: M;
  options: SegmentOption<M>[];
  onSelect: (mode: M) => void;
  /** A write is already in flight somewhere on the page; nothing is clickable until it lands. */
  busy: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
      {options.map(({ mode, label, disabledReason }) => {
        const selected = value === mode;
        const blocked = Boolean(disabledReason);
        return (
          <button
            key={mode}
            type="button"
            disabled={busy || blocked}
            // Re-picking what is already picked writes nothing. It can afford to
            // now: the control is seeded from the stored flag alone, so what is
            // displayed is what the daemon holds, and the PUT would only set
            // `apiFieldsTouched` and drop the SDK info cache for a value that did
            // not move. `cursor: default` below already says as much.
            onClick={() => {
              if (!selected) onSelect(mode);
            }}
            style={{
              flex: 1,
              padding: "8px 12px",
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 6,
              border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: selected ? "var(--accent)" : "var(--surface)",
              color: selected ? "var(--text-on-accent)" : blocked ? "var(--text-muted)" : "var(--text)",
              opacity: blocked ? 0.6 : 1,
              cursor: selected ? "default" : blocked ? "not-allowed" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * "Which account pays for this harness's chats", as one control.
 *
 * It is the first thing on the tab because it decides what everything under it
 * means, and it writes through immediately rather than waiting for the page's
 * Save: this is the switch a user flips to compare two setups, and a switch that
 * needs a scroll and a second click is one they stop using. The PUT carries only
 * the routing fields, so every unsaved edit elsewhere on the page survives it.
 *
 * The segments show what is *stored*; {@link notInEffect} shows where that and
 * what the daemon actually does come apart. Saying so here is the only honest
 * place for it — every other surface on the tab reports effective routing, and
 * an `Inactive` badge that silently swaps which section it sits on is a worse
 * lie than an unselected segment.
 */
function CredentialModeSection<M extends string>({
  harness,
  value,
  options,
  onSelect,
  saving,
  busy,
  error,
  notInEffect,
}: {
  harness: "Claude Code" | "Codex";
  value: M;
  options: SegmentOption<M>[];
  onSelect: (mode: M) => void;
  /** This control's own write is in flight. */
  saving: boolean;
  /** Any write is in flight, here or elsewhere on the page. */
  busy: boolean;
  /** This control's own failure. Never another control's — see `credentialErrors`. */
  error: string;
  /** Why the stored selection is not what the daemon is doing, when the two disagree. */
  notInEffect?: string;
}) {
  const hints = options.filter((o) => o.disabledReason);
  return (
    <div style={sectionStyle}>
      <div style={headerStyle}>
        <Key size={16} style={{ color: "var(--accent-text)" }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Credentials</span>
        {saving && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Saving&hellip;</span>}
      </div>
      <div style={subtitleStyle}>
        Which credential {harness} chats run on. Every setup below stays configured whichever one is selected — this picks the one in use, it does not clear the
        others.
      </div>

      <SegmentedControl value={value} options={options} onSelect={onSelect} busy={busy} />

      {notInEffect && <div style={{ ...helpStyle, color: "var(--warning)" }}>{notInEffect}</div>}

      {hints.map(({ mode, label, disabledReason }) => (
        <div key={mode} style={helpStyle}>
          <strong style={{ fontWeight: 500 }}>{label}:</strong> {disabledReason}
        </div>
      ))}

      {error && <div style={{ ...helpStyle, color: "var(--error)" }}>{error}</div>}

      <div style={{ ...helpStyle, marginTop: 8 }}>
        Saved as soon as you pick it — the page&rsquo;s Save button below is for everything else. Credentials are read when a session starts, so this applies to
        new chats and to any chat you resume, but not to one that is already running.
      </div>
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

  // Editable form state — mirrors the override fields on AgentSettings. See
  // `apiSettingsForm.ts` for the field-by-field load/save mapping.
  const [form, setForm] = useState<ApiSettingsForm>(EMPTY_API_SETTINGS_FORM);
  const setField = <K extends keyof ApiSettingsForm>(key: K, value: ApiSettingsForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));
  /** `setField` pre-applied to one key, for the inputs that take a value-only `onChange`. */
  const bind =
    <K extends keyof ApiSettingsForm>(key: K) =>
    (value: ApiSettingsForm[K]) =>
      setField(key, value);
  const {
    apiBaseUrl,
    apiKey,
    authToken,
    model,
    defaultOpusModel,
    defaultSonnetModel,
    defaultHaikuModel,
    subagentModel,
    pathToClaudeCodeExecutable,
    codexPathOverride,
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
    codexAuthMode,
    codexApiKey,
    codexBaseUrl,
    codexModel,
    codexHome,
    codexSandboxMode,
    codexUseOpenRouter,
    codexOpenRouterApiKey,
    codexOpenRouterBaseUrl,
    codexOpenRouterModel,
    piProviderId,
    piModel,
    piApiKey,
    piBaseUrl,
  } = form;
  // Catalog models, for the role-model placeholders on the routed-harness tabs.
  const [orModels, setOrModels] = useState<OpenRouterModelInfo[]>([]);
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
      // `refresh` on every one of this page's five system-info reads, this one
      // included. It is the page where the things this payload reports get
      // *changed* — keys, binary overrides, routing toggles, engine installs —
      // and `getSystemInfo`'s cached default resolves with the last payload this
      // tab saw and hands the revalidation to the cache rather than to the
      // caller, so a stale read here is not "current, a moment late"; it is what
      // the page displays until something else refetches.
      //
      // The initial load in particular: `loadAll` is what runs on every arrival
      // at this route, including the arrival straight after a user changed one
      // of these settings somewhere else in the app, and its answer is what the
      // form fields are populated from.
      const [s, sys] = await Promise.all([getAgentSettings(), getSystemInfo({ refresh: true }).catch(() => null)]);
      setSettings(s);
      setSystemInfo(sys);
      setForm(formFromSettings(s));
      // Catalog (for supportedParameters); best-effort — fields still work offline.
      getOpenRouterCatalog()
        .then(({ models }) => setOrModels(models))
        .catch(() => {});
    } catch (err) {
      setError(errorMessage(err, "Failed to load settings"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  /**
   * Which instant-save control is mid-write, and what each one's last write
   * failed with.
   *
   * Keyed rather than one shared pair, because the page renders three of these:
   * Claude Code's Credentials, Codex's Credentials, and Codex's parked-login
   * picker. A shared slot rendered a Claude Code failure under Codex's heading
   * the moment the user changed tabs, and put the parked picker's failure
   * several sections and a scroll above the button that caused it.
   */
  const [credentialSavingControl, setCredentialSavingControl] = useState<CredentialControl | null>(null);
  const [credentialErrors, setCredentialErrors] = useState<Partial<Record<CredentialControl, string>>>({});
  // Every instant-save control is unclickable while any write is in flight,
  // this page's own Save included: both writes carry the same fields, so two
  // concurrent PUTs would settle by whichever the daemon served last.
  const credentialsBusy = credentialSavingControl !== null || saving;

  const handleSave = async () => {
    // A Credentials click followed straight away by Save would otherwise issue
    // two PUTs carrying the same routing fields, one of them with the pre-click
    // value still in local state. The button is disabled for this too.
    if (saving || credentialSavingControl) return;
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
      // Every field, every time — see `settingsFromForm`.
      const updated = await updateAgentSettings(settingsFromForm(form));
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
      //
      // **One** request id for this whole post-save follow-up, claimed once and
      // shared by both reads below. Two `++`s would be worse than none: the
      // second would immediately invalidate the first's guard, so the engine
      // list would fetch and then discard its own answer.
      const requestId = ++enginesRequestId.current;
      if (overridesChanged) {
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
      //
      // Guarded like its neighbours, which this one was not — pre-existing, and
      // the 800ms delay is what makes it bite: a Recheck or an install
      // completing inside that window sets `systemInfo` from a *newer* probe,
      // and then this older response landed on top and reverted the page to the
      // pre-Recheck answer. `handleRecheckEngines` and `handleEnginesUpdated`
      // already claim the id for exactly this reason, so all three writers to
      // this state now settle by who asked last rather than by who replied last.
      setTimeout(() => {
        getSystemInfo({ refresh: true })
          .then((sys) => {
            if (enginesRequestId.current === requestId) setSystemInfo(sys);
          })
          .catch(() => {});
      }, 800);
    } catch (err) {
      setError(errorMessage(err, "Failed to save settings"));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Write one harness's credential choice on its own, immediately.
   *
   * Deliberately **not** routed through {@link handleSave}, for the reason
   * `persistEngineInstalls` is not routed through Remote Access's Apply: that
   * function submits every field on the page, so a switch meant for flipping
   * back and forth would also commit whatever half-typed key or model slug
   * happened to be sitting in another tab's form. Sending only the routing
   * fields keeps `binaryOverrideFieldsTouched` false as well, so no engine
   * probe caches are dropped for a change that moves no binary.
   *
   * `apply`/`revert` close over the values rather than taking a setter plus a
   * next-and-previous pair. The pair version type-checked with its two
   * same-typed arguments swapped, which inverts the optimistic update in
   * silence; thunks remove both the hazard and the argument order that carried
   * it, and match `persistEngineInstalls`.
   *
   * `settings` is left alone on success even though the PUT returns the merged
   * object: nothing this control writes is read back off `settings` — the
   * segments read the local flag, which `apply` has already moved. (It also
   * kept the retired ACP tab's re-seed effect from discarding an unsaved
   * Default Model edit, back when that tab existed.)
   *
   * `systemInfo` is a different matter and *is* refetched. Nothing derives
   * editable state from it, but plenty of this page's *claims*
   * come out of it, and one of them is computed from the very flag just written:
   * `codexConfigured` is forced true while Codex is routed, so a click that
   * turned routing off left the Codex tab reporting credentials that the flag
   * behind them no longer implies.
   */
  const persistCredentialFields = async (control: CredentialControl, fields: Partial<AgentSettings>, apply: () => void, revert: () => void) => {
    if (credentialsBusy) return;
    setCredentialSavingControl(control);
    setCredentialErrors((prev) => ({ ...prev, [control]: "" }));
    apply();
    try {
      await updateAgentSettings(fields);
      // Not awaited: this is the switch a user flips to compare two setups, and
      // holding every segment disabled through a full system-info probe is what
      // made the checkbox it replaces feel like a page-wide Save.
      //
      // Reads the request id rather than claiming one. Claiming is what the
      // three writers below do because each of them also owns the engine list,
      // and bumping the counter here would strand `loadAll`'s in-flight
      // `getEngines` — its `finally` is the only thing that clears
      // `enginesLoading`. Reading still drops this answer if a newer asker
      // appeared meanwhile, which is the half that matters.
      const requestId = enginesRequestId.current;
      void getSystemInfo({ refresh: true })
        .then((sys) => {
          if (enginesRequestId.current === requestId) setSystemInfo(sys);
        })
        .catch(() => {
          // The write landed; a stale badge is a smaller lie than an error on a
          // control that actually saved.
        });
    } catch (e) {
      // Put the control back rather than leaving it showing a credential the
      // daemon will not use.
      revert();
      setCredentialErrors((prev) => ({ ...prev, [control]: errorMessage(e, "Failed to save") }));
    } finally {
      setCredentialSavingControl(null);
    }
  };

  const handleClaudeCredentialMode = (mode: ClaudeCredentialMode) => {
    const fields = writeClaudeCredentialMode(mode);
    const previous = claudeCodeUseOpenRouter;
    void persistCredentialFields(
      "claude",
      fields,
      () => setField("claudeCodeUseOpenRouter", fields.claudeCodeUseOpenRouter),
      () => setField("claudeCodeUseOpenRouter", previous),
    );
  };

  const handleCodexCredentialMode = (mode: CodexCredentialMode) => {
    const fields = writeCodexCredentialMode(mode);
    const previousUseOpenRouter = codexUseOpenRouter;
    const previousAuthMode = codexAuthMode;
    void persistCredentialFields(
      "codex",
      fields,
      () => {
        setField("codexUseOpenRouter", fields.codexUseOpenRouter);
        // Absent when selecting OpenRouter, because the native choice is parked
        // rather than overwritten — so there is nothing to move locally either.
        if (fields.codexAuthMode) setField("codexAuthMode", fields.codexAuthMode);
      },
      () => {
        setField("codexUseOpenRouter", previousUseOpenRouter);
        setField("codexAuthMode", previousAuthMode);
      },
    );
  };

  /**
   * The parked native Codex credential — what leaving OpenRouter will land on.
   *
   * The same field the Credentials control writes, from a picker that renders
   * only while OpenRouter is selected. With routing off it would be a second
   * live control for the decision the Credentials segments already own, which is
   * the gap this feature exists to close; with routing on it answers a question
   * the top control has no way to ask.
   */
  const handleCodexParkedAuthMode = (mode: "subscription" | "api-key") => {
    const previous = codexAuthMode;
    void persistCredentialFields(
      "codexParkedAuth",
      { codexAuthMode: mode },
      () => setField("codexAuthMode", mode),
      () => setField("codexAuthMode", previous),
    );
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
   * `systemInfo` is refreshed alongside it so the page's system-info-derived
   * claims do not keep the pre-install answer while the card shows the new one.
   * (The retired ACP harness's `acpProviders[].available`, read off the same
   * PATH lookup, was the case that first needed this.)
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
   * `systemInfo` is refreshed alongside it for the same reason as in
   * {@link handleRecheckEngines}.
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
  const engineFor = (tab: SettingsTab): EngineStatus | undefined => {
    if (tab === "openrouter") return undefined;
    return engines.find((e) => e.id === tab);
  };

  // Inline alias validation — mirrors the backend's write-time rules so the
  // user sees the problem before Save bounces with a 400.

  const claudeCredentialMode = readClaudeCredentialMode({ claudeCodeUseOpenRouter });
  const codexCredentialMode = readCodexCredentialMode({ codexUseOpenRouter, codexAuthMode });

  /**
   * Whether picking OpenRouter would actually route anything.
   *
   * `isClaudeCodeRoutedThroughOpenRouter` / `isCodexRoutedThroughOpenRouter`
   * both return false when the flag is on but the credentials they need are not
   * there, so the segment would set a flag that changes nothing — the worst kind
   * of switch. What "not there" means is **different for the two harnesses**;
   * `credentialMode.ts` holds each mirror next to the predicate it copies, and
   * one line of that file is the whole reason a Codex user with `openrouter.ai`
   * in their `config.toml` used to get an enabled segment that did nothing.
   *
   * Compared against `settings`, the last server response, rather than the
   * editable field: a key that has been typed but not saved is not a key the
   * daemon has.
   */
  const claudeOpenRouterReady = claudeOpenRouterCredentialReady(settings ?? {}, Boolean(systemInfo?.claudeCodeOpenRouterDetected));
  const codexOpenRouterReady = codexOpenRouterCredentialReady(settings ?? {}, Boolean(systemInfo?.codexOpenRouterDetected));
  const openRouterKeyHint = "Add an OpenRouter key below and Save first.";
  const claudeOpenRouterUnready = claudeOpenRouterReady ? undefined : openRouterKeyHint;
  const codexOpenRouterUnready = codexOpenRouterReady
    ? undefined
    : systemInfo?.codexOpenRouterDetected
      ? "Your environment already routes Codex through OpenRouter, and Callboard leaves that wiring alone. Add a key below — or an endpoint to override the environment's with — and Save first."
      : openRouterKeyHint;

  /**
   * What the daemon is *doing*, as opposed to what is selected.
   *
   * The two come apart in one reachable state — a stored flag whose key was
   * later cleared and saved — and everything on this page that asserts a state
   * reads this rather than the selection: the `Inactive` badges, the "is
   * handling this" copy. Letting a badge follow the selection inverted it, so
   * the section actually in effect was the one labelled inactive.
   *
   * Not `systemInfo.<harness>UseOpenRouter`, which computes the same thing
   * server-side but is a page-load-old answer: this control writes the flag
   * without refetching system-info, so a click would leave every badge on the
   * tab stale until something else happened to refresh it.
   */
  const claudeRoutingInEffect = claudeCredentialMode === "openrouter" && claudeOpenRouterReady;
  const codexRoutingInEffect = codexCredentialMode === "openrouter" && codexOpenRouterReady;

  /**
   * What is running instead, on the badge of the routing section that is not.
   *
   * "Claude Code is on your Anthropic credentials" is a claim about the process
   * env, and callboard only knows half of that env. `getApiEnvOverrides`'s native
   * branch sets `ANTHROPIC_BASE_URL` from `apiBaseUrl` — it never *unsets* an
   * inherited one — so a user whose shell exports the OpenRouter gateway
   * (exactly what `detectClaudeCodeOpenRouterEnv` matches) has chats really
   * running through OpenRouter while this badge told them they were on
   * Anthropic. Taking the native branch says callboard added nothing; it does
   * not say the ambient env was undone.
   *
   * So when the env is detected and callboard is not the one routing, the badge
   * says only what callboard knows — that it is not driving this — and the
   * banner inside the section says the rest. The Codex detect is a looser grep,
   * which makes the same sentence *more* necessary there: "Codex is on your
   * ChatGPT login" sat four lines above "Callboard leaves that wiring alone".
   *
   * That detected sentence then has the mirror image of the same bug, and this
   * one callboard *can* check: the native branch never unsets an inherited
   * `ANTHROPIC_BASE_URL`, but with `apiBaseUrl` stored it overwrites it, so
   * "your environment's own already does" is false for exactly the user who
   * filled in the API Endpoint field below. Naming which value wins is true
   * whichever host that field holds, so the split is on the field being set at
   * all. Read from `settings` rather than the editable box, like every other
   * assertion here: an unsaved endpoint is not one the daemon injects.
   */
  const claudeInactiveNote = claudeRoutingInEffect
    ? undefined
    : !systemInfo?.claudeCodeOpenRouterDetected
      ? "Claude Code is on your Anthropic credentials"
      : settings?.apiBaseUrl?.trim()
        ? "Callboard is not routing this; the API Endpoint below overrides your environment's ANTHROPIC_BASE_URL"
        : "Callboard is not routing this; your environment's own ANTHROPIC_BASE_URL already does";
  const codexInactiveNote = codexRoutingInEffect
    ? undefined
    : systemInfo?.codexOpenRouterDetected
      ? "Callboard is not routing this; your environment's own Codex wiring stands"
      : // `codexAuthMode` rather than the credential mode: when the flag is on
        // but not in effect the mode reads "openrouter", and the native
        // credential actually running is still whichever one is parked.
        codexAuthMode === "api-key"
        ? "Codex is on your OpenAI API key"
        : "Codex is on your ChatGPT login";

  return (
    <>
      {/* Integration toggle — Claude and OpenRouter as first-class providers */}
      <div
        style={{
          display: "flex",
          // Wraps: the row was built for three fixed tabs, and the retired ACP
          // harness once added one per configured vendor.
          flexWrap: "wrap",
          borderRadius: 8,
          border: "1px solid var(--border)",
          overflow: "hidden",
          marginBottom: 16,
        }}
      >
        {[
          { kind: "claude-code" as SettingsTab, label: "Claude", icon: <Bot size={14} /> },
          { kind: "openrouter" as SettingsTab, label: "OpenRouter", icon: <Network size={14} /> },
          { kind: "codex" as SettingsTab, label: "Codex", icon: <Terminal size={14} /> },
          { kind: "pi" as SettingsTab, label: "pi", icon: <Boxes size={14} /> },
        ].map(({ kind, label, icon }, idx, arr) => {
          const isActiveTab = activeProvider === kind;
          return (
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
                const engine = engineFor(kind);
                return engine ? <EngineStatusDot engine={engine} /> : null;
              })()}
            </button>
          );
        })}
      </div>

      {activeProvider === "claude-code" && (
        <>
          <EngineStatusCard engine={engineFor("claude-code")} loading={enginesLoading} onRecheck={handleRecheckEngines} onEnginesUpdated={handleEnginesUpdated} />

          <CredentialModeSection
            harness="Claude Code"
            value={claudeCredentialMode}
            onSelect={handleClaudeCredentialMode}
            saving={credentialSavingControl === "claude"}
            busy={credentialsBusy}
            error={credentialErrors.claude ?? ""}
            notInEffect={
              claudeCredentialMode === "openrouter" && !claudeRoutingInEffect
                ? "Selected, but not in effect — no OpenRouter key is stored, so Claude Code chats are still running on your Anthropic credentials. Add one below and Save."
                : undefined
            }
            options={[
              { mode: "anthropic", label: "Anthropic" },
              { mode: "openrouter", label: "OpenRouter", disabledReason: claudeOpenRouterUnready },
            ]}
          />

          <ReferenceLinksSection provider="claude-code" />

          <ChatRetentionSection engine="claude-code" />

          <OpenRouterRoutingSection
            harness="Claude Code"
            inactiveNote={claudeInactiveNote}
            apiKey={claudeCodeOpenRouterApiKey}
            onApiKeyChange={bind("claudeCodeOpenRouterApiKey")}
            baseUrl={claudeCodeOpenRouterBaseUrl}
            onBaseUrlChange={bind("claudeCodeOpenRouterBaseUrl")}
            detected={Boolean(systemInfo?.claudeCodeOpenRouterDetected)}
            endpoint="https://openrouter.ai/api"
            keyEnvLabel="ANTHROPIC_AUTH_TOKEN"
            caveats={
              <>
                While this is the selected credential, Callboard sets <code>ANTHROPIC_BASE_URL</code> to the endpoint above and forces{" "}
                <code>ANTHROPIC_API_KEY</code> empty. Claude Code is optimized for Anthropic models — pick <code>anthropic/*</code> slugs below for best results.
                If you previously logged in to Anthropic directly, run <code>/logout</code> in a chat to clear any cached session conflict.
              </>
            }
          />

          {/* API Endpoint — rendered whichever credential is selected, for the
              reason Authentication below it is: it is part of the native setup,
              the page's Save still submits it, and someone preparing to switch
              back cannot set a field that is not on the screen. Unmounting it
              also made "is this configured?" a question only answerable by
              flipping the switch that changes the answer. */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Globe size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>API Endpoint</span>
              {claudeRoutingInEffect && <InactiveBadge>Inactive — OpenRouter is handling this</InactiveBadge>}
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
                onChange={(e) => setField("apiBaseUrl", e.target.value)}
                placeholder="https://api.anthropic.com"
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
              />
              <div style={helpStyle}>
                When set to a non-first-party host, MCP tool search is disabled by default.
                {claudeRoutingInEffect ? " The OpenRouter endpoint above wins over this one while OpenRouter is the selected credential." : ""}
              </div>
            </div>
          </div>

          {/* Authentication — rendered whichever credential is selected, so the
              page can state that both are configured. */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Key size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Authentication</span>
              {claudeRoutingInEffect && <InactiveBadge>Inactive — OpenRouter is handling this</InactiveBadge>}
            </div>
            <div style={subtitleStyle}>
              {claudeRoutingInEffect
                ? "Claude Code normally authenticates through your Claude subscription, and an API key or auth token here overrides that. Neither is in use while OpenRouter is the selected credential — they stay editable so the setup you switch back to is ready when you get there."
                : "Claude Code normally authenticates through your Claude subscription. Set an API key or auth token here to override that — for example, to use a different account or a gateway that requires a bearer token."}
            </div>

            {/* Current source (view-only) */}
            <div style={{ marginBottom: 14 }}>
              <div style={rowStyle}>
                <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>Current token source</span>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)" }}>{namedSource(account?.tokenSource) ?? "—"}</span>
              </div>
              <div style={rowStyle}>
                <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>Current API key source</span>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)" }}>{truncateSensitive(namedSource(account?.apiKeySource), 4)}</span>
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
              <SecretField id="apiKey" value={apiKey} onChange={bind("apiKey")} placeholder="sk-ant-..." />
              <div style={helpStyle}>Sent as the X-Api-Key header. Takes precedence over your subscription login.</div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="authToken" style={labelStyle}>
                Auth Token<span style={envLabelStyle}>ANTHROPIC_AUTH_TOKEN</span>
              </label>
              <SecretField id="authToken" value={authToken} onChange={bind("authToken")} placeholder="Bearer token value" />
              <div style={helpStyle}>Sent as the Authorization: Bearer header. Use for gateways that require a bearer token.</div>
            </div>
          </div>

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
              onChange={bind("pathToClaudeCodeExecutable")}
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
              {claudeCredentialMode === "openrouter"
                ? "Pick OpenRouter slugs for the session model and the opus / sonnet / haiku aliases (anthropic/* listed first). Blank role fields default to the newest matching anthropic/* model in the OpenRouter catalog. Saved separately from your direct-endpoint models, so setting Credentials back to Anthropic restores those."
                : "Override which model is used for the session and what the `opus`, `sonnet`, and `haiku` aliases resolve to. Saved separately from your OpenRouter models, so setting Credentials to OpenRouter restores those."}
            </div>

            {/* Currently available models (SDK catalog — the OpenRouter catalog
                replaces it when OpenRouter is the selected credential). */}
            {claudeCredentialMode !== "openrouter" && models.length > 0 && (
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
              {claudeCredentialMode === "openrouter" ? (
                <OpenRouterModelSelector
                  id="model"
                  value={claudeCodeOpenRouterModel}
                  onChange={bind("claudeCodeOpenRouterModel")}
                  priorityPrefix="anthropic/"
                  placeholder="anthropic/claude-opus-4.7"
                />
              ) : (
                <input
                  id="model"
                  type="text"
                  value={model}
                  onChange={(e) => setField("model", e.target.value)}
                  placeholder="e.g. opus, sonnet, claude-opus-4-7"
                  autoComplete="off"
                  spellCheck={false}
                  style={inputStyle}
                />
              )}
              <div style={helpStyle}>
                {claudeCredentialMode === "openrouter"
                  ? // "Applies to new sessions" is only true once the selection
                    // is also in effect — the routed model fields are read by the
                    // routed branch of `getApiEnvOverrides`, which a flag with no
                    // key never reaches.
                    claudeRoutingInEffect
                    ? "OpenRouter model slug (or a configured alias). Applies to new sessions."
                    : "OpenRouter model slug (or a configured alias). Nothing runs on it until OpenRouter is in effect — see Credentials above."
                  : "Alias (opus, sonnet, haiku, opusplan) or full model ID. Applies to new sessions."}
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="opusModel" style={labelStyle}>
                Opus Alias Target<span style={envLabelStyle}>ANTHROPIC_DEFAULT_OPUS_MODEL</span>
              </label>
              {claudeCredentialMode === "openrouter" ? (
                <OpenRouterModelSelector
                  id="opusModel"
                  value={claudeCodeOpenRouterOpusModel}
                  onChange={bind("claudeCodeOpenRouterOpusModel")}
                  priorityPrefix="anthropic/"
                  placeholder={latestAnthropicRoleSlug(orModels, "opus") ?? "anthropic/claude-opus-4.8"}
                />
              ) : (
                <input
                  id="opusModel"
                  type="text"
                  value={defaultOpusModel}
                  onChange={(e) => setField("defaultOpusModel", e.target.value)}
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
              {claudeCredentialMode === "openrouter" ? (
                <OpenRouterModelSelector
                  id="sonnetModel"
                  value={claudeCodeOpenRouterSonnetModel}
                  onChange={bind("claudeCodeOpenRouterSonnetModel")}
                  priorityPrefix="anthropic/"
                  placeholder={latestAnthropicRoleSlug(orModels, "sonnet") ?? "anthropic/claude-sonnet-4.6"}
                />
              ) : (
                <input
                  id="sonnetModel"
                  type="text"
                  value={defaultSonnetModel}
                  onChange={(e) => setField("defaultSonnetModel", e.target.value)}
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
              {claudeCredentialMode === "openrouter" ? (
                <OpenRouterModelSelector
                  id="haikuModel"
                  value={claudeCodeOpenRouterHaikuModel}
                  onChange={bind("claudeCodeOpenRouterHaikuModel")}
                  priorityPrefix="anthropic/"
                  placeholder={latestAnthropicRoleSlug(orModels, "haiku") ?? "anthropic/claude-haiku-4.5"}
                />
              ) : (
                <input
                  id="haikuModel"
                  type="text"
                  value={defaultHaikuModel}
                  onChange={(e) => setField("defaultHaikuModel", e.target.value)}
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
              {claudeCredentialMode === "openrouter" ? (
                <OpenRouterModelSelector
                  id="subagentModel"
                  value={claudeCodeOpenRouterSubagentModel}
                  onChange={bind("claudeCodeOpenRouterSubagentModel")}
                  priorityPrefix="anthropic/"
                  placeholder={latestAnthropicRoleSlug(orModels, "sonnet") ?? "anthropic/claude-sonnet-4.6"}
                />
              ) : (
                <input
                  id="subagentModel"
                  type="text"
                  value={subagentModel}
                  onChange={(e) => setField("subagentModel", e.target.value)}
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
              &ldquo;Route through OpenRouter&rdquo; on the Claude or Codex tab — each keeps its own key.
            </div>

            <div style={fieldWrap}>
              <label htmlFor="openRouterApiKey" style={labelStyle}>
                API Key<span style={envLabelStyle}>OPENROUTER_API_KEY</span>
              </label>
              <SecretField id="openRouterApiKey" value={openRouterApiKey} onChange={bind("openRouterApiKey")} placeholder="sk-or-..." />
              <div style={helpStyle}>
                Create one at openrouter.ai/keys.
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
                onChange={(e) => setField("openRouterBaseUrl", e.target.value)}
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
                onChange={(e) => setField("openRouterUtilityCompletions", e.target.checked)}
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
                    onChange={bind("openRouterUtilityHaikuModel")}
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
                    onChange={bind("openRouterUtilitySonnetModel")}
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
                    onChange={bind("openRouterUtilityOpusModel")}
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

      {activeProvider === "codex" && (
        <>
          <EngineStatusCard engine={engineFor("codex")} loading={enginesLoading} onRecheck={handleRecheckEngines} onEnginesUpdated={handleEnginesUpdated} />

          <CredentialModeSection
            harness="Codex"
            value={codexCredentialMode}
            onSelect={handleCodexCredentialMode}
            saving={credentialSavingControl === "codex"}
            busy={credentialsBusy}
            error={credentialErrors.codex ?? ""}
            notInEffect={
              codexCredentialMode === "openrouter" && !codexRoutingInEffect
                ? systemInfo?.codexOpenRouterDetected
                  ? // Not "still running on your native login": callboard injected
                    // nothing, so what the chats run on is whatever the user's own
                    // config.toml / $OPENAI_BASE_URL says, which is not ours to
                    // report.
                    "Selected, but not in effect — Callboard is not routing Codex. Your environment's own wiring stands until you give Callboard a key, or an endpoint to override it with, below."
                  : "Selected, but not in effect — no OpenRouter key is stored, so Codex chats are still running on your native login. Add one below and Save."
                : undefined
            }
            options={[...CODEX_NATIVE_CREDENTIALS, { mode: "openrouter", label: "OpenRouter", disabledReason: codexOpenRouterUnready }]}
          />

          <ReferenceLinksSection provider="codex" />

          <ChatRetentionSection engine="codex" />

          <OpenRouterRoutingSection
            harness="Codex"
            inactiveNote={codexInactiveNote}
            apiKey={codexOpenRouterApiKey}
            onApiKeyChange={bind("codexOpenRouterApiKey")}
            baseUrl={codexOpenRouterBaseUrl}
            onBaseUrlChange={bind("codexOpenRouterBaseUrl")}
            detected={Boolean(systemInfo?.codexOpenRouterDetected)}
            endpoint="https://openrouter.ai/api/v1"
            keyEnvLabel="OPENROUTER_API_KEY"
            caveats={
              <>
                While this is the selected credential, Callboard adds a <code>[model_providers.openrouter]</code> block to Codex&apos;s config with{" "}
                <code>wire_api=&quot;responses&quot;</code>. Only models that support the Responses API work reliably — <code>openai/*</code> slugs are listed
                first below. Non-OpenAI models may fail at runtime.
              </>
            }
          />

          {/* Codex — the native credential, rendered whichever mode is selected
              so its setup is configurable from the mode you are about to leave. */}
          <div style={sectionStyle}>
            <div style={headerStyle}>
              <Terminal size={16} style={{ color: "var(--accent-text)" }} />
              <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>OpenAI Codex</span>
              {codexRoutingInEffect && <InactiveBadge>Inactive — OpenRouter is handling this</InactiveBadge>}
            </div>
            <div style={subtitleStyle}>
              Run chats on OpenAI Codex. Authenticate with your ChatGPT subscription (recommended on a personal machine — personal use only) or a raw OpenAI API
              key.
            </div>

            {/* Which native login is *parked* — rendered only while OpenRouter is
                selected. With routing off, `codexAuthMode` is exactly what the
                Credentials segments above already write, and a second
                accent-highlighted row for the same decision is the gap this
                feature set out to close; it survives here because it answers a
                question the top control has no way to ask. Its labels are the
                top control's, deliberately: one credential, one name. */}
            {codexCredentialMode === "openrouter" && (
              <div style={fieldWrap}>
                <label style={labelStyle}>When you switch back</label>
                <SegmentedControl value={codexAuthMode} options={CODEX_NATIVE_CREDENTIALS} onSelect={handleCodexParkedAuthMode} busy={credentialsBusy} />
                {credentialSavingControl === "codexParkedAuth" && <div style={helpStyle}>Saving&hellip;</div>}
                {credentialErrors.codexParkedAuth && <div style={{ ...helpStyle, color: "var(--error)" }}>{credentialErrors.codexParkedAuth}</div>}
                <div style={helpStyle}>
                  Saved as soon as you pick it, like Credentials above — and unlike the key field below it, which still needs the page&rsquo;s Save. Nothing runs
                  on it until you set Credentials back to a native Codex login.
                </div>
              </div>
            )}

            {codexAuthMode === "subscription" ? (
              <>
                {/* Auth status from /system-info (no key field in this mode).
                    Read off `codexAuthSource`, never off `codexConfigured`:
                    routing through OpenRouter forces that flag true so the New
                    Chat gate lets Codex through on an OpenRouter key alone, and
                    this row is answering a different question — whether there is
                    a native login here to switch *back* to. Reading the forced
                    flag told a routed user with no auth.json they were logged
                    in, and suppressed the one instruction that would fix it. */}
                <div style={{ marginBottom: 14 }}>
                  <div style={rowStyle}>
                    <span style={{ color: "var(--text-muted)", fontWeight: 500 }}>Codex auth status</span>
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: systemInfo?.codexAuthSource ? "var(--text)" : "var(--text-muted)" }}>
                      {systemInfo?.codexAuthSource === "auth.json"
                        ? "Logged in (auth.json found)"
                        : systemInfo?.codexAuthSource === "config.toml"
                          ? "Configured via config.toml"
                          : systemInfo?.codexAuthSource === "api-key"
                            ? "Configured (API key)"
                            : "Not configured"}
                    </span>
                  </div>
                </div>
                {systemInfo?.codexAuthNote && <div style={{ ...helpStyle, marginTop: 0, marginBottom: 14 }}>{systemInfo.codexAuthNote}</div>}
                {!systemInfo?.codexAuthSource && (
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
                  <SecretField id="codexApiKey" value={codexApiKey} onChange={bind("codexApiKey")} placeholder="sk-..." />
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
                    onChange={(e) => setField("codexBaseUrl", e.target.value)}
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
              {codexCredentialMode === "openrouter" ? (
                <OpenRouterModelSelector
                  id="codexModel"
                  value={codexOpenRouterModel}
                  onChange={bind("codexOpenRouterModel")}
                  priorityPrefix="openai/"
                  placeholder="openai/gpt-5.5-codex"
                />
              ) : (
                <CodexModelSelector id="codexModel" value={codexModel} onChange={bind("codexModel")} placeholder="gpt-5.5" />
              )}
              <div style={helpStyle}>
                {codexCredentialMode === "openrouter"
                  ? "OpenRouter model slug (openai/* recommended). Free text accepted — OpenRouter validates the model. Saved separately from your native Codex model, so setting Credentials back to a native Codex login restores it."
                  : "Start typing to filter the live Codex model catalog. Free text accepted — the CLI validates the model. Saved separately from your OpenRouter model, so setting Credentials to OpenRouter restores it."}
              </div>
            </div>

            <div style={fieldWrap}>
              <label htmlFor="codexSandboxMode" style={labelStyle}>
                Sandbox Mode
              </label>
              <select
                id="codexSandboxMode"
                value={codexSandboxMode}
                onChange={(e) => setField("codexSandboxMode", e.target.value as typeof codexSandboxMode)}
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
                onChange={(e) => setField("codexHome", e.target.value)}
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
              onChange={bind("codexPathOverride")}
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
          <ChatRetentionSection engine="pi" />

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
                onChange={(e) => setField("piProviderId", e.target.value)}
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
              <SecretField id="piApiKey" value={piApiKey} onChange={bind("piApiKey")} placeholder="sk-or-v1-..." />
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
                onChange={(e) => setField("piBaseUrl", e.target.value)}
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
              <PiModelSelector id="piModel" value={piModel} onChange={bind("piModel")} placeholder="google/gemini-3.6-flash" providerId={piProviderId} />
              <div style={helpStyle}>
                Type to filter — this catalog is large (~300 models on OpenRouter), so the list narrows as you type rather than showing everything. Free text is
                accepted for a slug newer than the bundled catalog; pi falls back to its own default if it does not recognise one.
              </div>
            </div>
          </div>
        </>
      )}

      {error && <div style={{ fontSize: 13, color: "var(--error)", marginBottom: 12 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
        {/* Also held down while a Credentials click is in flight: that write and
            this one carry the same routing fields, and this one would send the
            pre-click value. */}
        <button
          onClick={handleSave}
          disabled={credentialsBusy}
          style={{
            background: credentialsBusy ? "var(--surface)" : "var(--accent)",
            color: credentialsBusy ? "var(--text-muted)" : "var(--text-on-accent)",
            padding: "10px 20px",
            borderRadius: 8,
            border: credentialsBusy ? "1px solid var(--border)" : "none",
            fontSize: 14,
            fontWeight: 500,
            cursor: credentialsBusy ? "not-allowed" : "pointer",
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

      ) : activeProvider === "pi" ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 16, lineHeight: 1.5 }}>
          These are read when a pi chat starts, so they take effect for new sessions; resume an existing chat to pick them up. The runtime is embedded, so
          nothing is spawned and no environment is rewritten — a blank field falls through to whatever the backend process already has, and an explicit key here
          takes priority over one in the environment. What the agent is allowed to do is set under Permissions, and Callboard asks before every tool call it has
          not been told to allow. Note that <strong>third-party MCP servers do not apply to pi chats</strong>: pi has no MCP client, so a pi chat sees
          Callboard&rsquo;s own tools and pi&rsquo;s own built-ins, and nothing else.
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
