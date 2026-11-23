import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { X, ChevronDown, ChevronRight, Bot } from "lucide-react";
import { listAgents, getAgentIdentityPrompt, cachedSystemInfo, updateSpace, type DefaultPermissions, type AgentConfig } from "../api";
import { useSpaces } from "../contexts/SpaceContext";
import { ALL_SPACES, DEFAULT_SPACE_ID } from "shared/types/space.js";
import { normalizePermissions } from "shared/types/permissions.js";
import { UI_AGENT_PROVIDER_KINDS } from "shared/types/providers.js";
import { spaceLabel } from "./SpaceChip";
import { spaceHasOwnDefaults, writesBrowserFallback } from "../utils/spaceDefaults";
import PermissionSettings from "./PermissionSettings";
import "./NewChatPanel.css";
import { useSystemInfo } from "../hooks/useSystemInfo";
import ConfirmRemoveRecentDirectory from "./ConfirmRemoveRecentDirectory";
import { useRecentDirectories } from "../hooks/useRecentDirectories";
import FolderSelector from "./FolderSelector";
import ProviderConfigPicker from "./ProviderConfigPicker";
import type { ChatRouteState } from "../types/chatRouteState";
import {
  getDefaultPermissions,
  saveDefaultPermissions,
  getDefaultModelReview,
  saveDefaultModelReview,
  getDefaultProvider,
  saveDefaultProvider,
  getDefaultOpenRouterEffort,
  saveDefaultOpenRouterEffort,
  getDefaultClaudeModel,
  saveDefaultClaudeModel,
  getDefaultCodexModel,
  saveDefaultCodexModel,
  getDefaultPiModel,
  saveDefaultPiModel,
  type AgentProviderKind,
  type EffortLevel,
} from "../utils/localStorage";

interface NewChatPanelProps {
  onClose: () => void;
}

function getPermissionsSummary(permissions: DefaultPermissions): string {
  const labels: Record<keyof DefaultPermissions, string> = {
    fileRead: "File Read",
    fileWrite: "File Write",
    codeExecution: "Code Execution",
    webAccess: "Web Access",
    browserControl: "Browser Use",
    computerControl: "Computer Use",
  };

  const values = Object.values(permissions);
  const allSame = values.every((v) => v === values[0]);
  if (allSame) {
    return `${values[0].charAt(0).toUpperCase() + values[0].slice(1)} all`;
  }

  const grouped: Record<string, string[]> = {};
  for (const [key, level] of Object.entries(permissions)) {
    const label = labels[key as keyof DefaultPermissions];
    if (!grouped[level]) grouped[level] = [];
    grouped[level].push(label);
  }

  const parts: string[] = [];
  for (const level of ["allow", "ask", "deny"]) {
    if (grouped[level]?.length) {
      parts.push(`${level.charAt(0).toUpperCase() + level.slice(1)} ${grouped[level].join(", ")}`);
    }
  }

  return parts.join("; ");
}

export default function NewChatPanel({ onClose }: NewChatPanelProps) {
  const navigate = useNavigate();
  /**
   * Whatever `/api/system-info` last told this tab, read synchronously so the
   * fields it feeds can be initial state rather than the result of an effect.
   *
   * Read once per mount and held, so the initializers below cannot disagree with
   * each other — a revalidation landing between two `useState` calls would
   * otherwise seed half the panel from one payload and half from the next.
   */
  const [seed] = useState(cachedSystemInfo);
  const [folder, setFolder] = useState("");
  const [defaultPermissions, setDefaultPermissions] = useState<DefaultPermissions>(getDefaultPermissions());
  // Model safety review for the new chat. No "parent can answer" here: a chat
  // started from this panel never has a parent.
  const [modelReview, setModelReview] = useState<boolean>(getDefaultModelReview);
  const [chatMode, setChatMode] = useState<"claude-code" | "agent">("claude-code");
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  // Behavior section (harness behavior toggles) — collapsible, default
  // closed to match the Permissions section.
  const [behaviorOpen, setBehaviorOpen] = useState(false);
  const [pathOpen, setPathOpen] = useState(true);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsFetched, setAgentsFetched] = useState(false);
  /** The recent folder awaiting a "remove?" confirmation, if any. */
  const [confirmRemovePath, setConfirmRemovePath] = useState<string | null>(null);
  // Explicit-completion requirement for the chat being created. Deliberately
  // NOT persisted to localStorage — it's a per-chat decision (the nudge loop
  // is only wanted for specific tasks), so it resets to off each time.
  const [requireCompletion, setRequireCompletion] = useState(false);
  // Provider selector — defaults to whatever the user last picked.
  const [provider, setProvider] = useState<AgentProviderKind>(getDefaultProvider);
  // Reasoning-effort knob — surfaced under the provider tile for the harnesses
  // that have one. `undefined` means "don't send a reasoning payload" (preserves
  // each model's default behavior). Persisted in localStorage independently
  // of the provider so toggling back restores the prior selection.
  const [effort, setEffort] = useState<EffortLevel | undefined>(getDefaultOpenRouterEffort);
  // True while the picker says `effort` is unsupported or unverified for the
  // selected provider/model. The stored effort is restored verbatim (a stale
  // level is the default state for anyone who changed model or route since), so
  // creation must wait for a supported level or an explicit clear — the server
  // rejects the first message otherwise.
  const [effortBlocked, setEffortBlocked] = useState(false);
  // Anthropic model for Claude Code chats (alias or full ID). Empty string =
  // "use the global default from Settings → API". Stored separately from the
  // other providers' models so toggling restores each one's prior selection.
  const [claudeModel, setClaudeModel] = useState<string>(getDefaultClaudeModel);
  // Codex model. Empty string = "use the global default
  // from Settings → API". Stored separately from the Claude model so
  // toggling providers restores each one's prior selection.
  const [codexModel, setCodexModel] = useState<string>(getDefaultCodexModel);
  // Fetch system info once to learn which harnesses are configured. Until the
  // fetch resolves, codexConfigured stays `null` and the UI treats Codex as
  // available — the actual gate is in the button's disabled prop. If Codex was
  // selected from localStorage but turns out to be unconfigured, we silently
  // flip the in-memory state to claude-code without touching localStorage (the
  // user's saved preference survives for the next time they reconfigure it).
  //
  // ## Why `refresh` here, when the seed above is what fixes the pop-in
  //
  // The two are separate jobs and only one of them is about speed. The
  // synchronous `cachedSystemInfo()` seed is what lets the cache-fed fields paint
  // on frame one; nothing about that requires *this* call to be cached as well.
  //
  // And it must not be. `getSystemInfo()`'s default resolves with the cached
  // payload and hands the revalidation to the module cache rather than to the
  // caller — so a panel that took the default was pinned to whatever this tab
  // last saw, for its whole lifetime, with no correction until the next open.
  // That is not a slower version of the truth, it is a different answer: when
  // the retired ACP harness still had a button here, uninstalling its CLI and
  // reopening left the button enabled, `downgradeProvider` read the same stale
  // list and agreed, and the chat failed at start instead of quietly falling
  // back. `main` always had fresh data one
  // frame in, so serving stale here was a regression rather than a trade.
  //
  // `refresh` restores that and keeps the instant paint — and it is still
  // exactly one payload per mount, so the flip-flop hazard the seed-plus-stale
  // arrangement was reaching for does not come back. The seed decides what is
  // *drawn* first; this decides what is *believed*. Do not drop the `refresh` to
  // save a round trip: the round trip is the point.
  //
  // The payload lands through `onLoad`, in the same tick as the downgrade it
  // drives, so the provider row never renders the fresh list against the
  // stale selection.
  const { info: systemInfo, failed: systemInfoFailed } = useSystemInfo({
    refresh: true,
    onLoad: (info) => {
      if (!info.codexConfigured && providerRef.current === "codex") {
        setProvider("claude-code");
      }
    },
  });
  // `null` until /system-info returns — Codex treated as available until an
  // explicit false.
  //
  // Deliberately **not** seeded from the cache, unlike the fields below. The
  // Codex button is hardcoded JSX either way, so a seed buys no paint here; all
  // it could change is the `disabled` prop, and there `null` strictly dominates.
  // A cached `true` is indistinguishable from `null` (both leave the button
  // live), while a cached `false` would disable a button that may well be fine —
  // turning "still loading, trust the user's choice" into a claim the tab has no
  // current evidence for.
  // An unreachable /system-info reads as an explicit false: surface the toggle
  // as disabled rather than silently allowing a request that will 500 on submit.
  const codexConfigured: boolean | null = systemInfo ? Boolean(systemInfo.codexConfigured) : systemInfoFailed ? false : null;
  const [piModel, setPiModel] = useState<string>(getDefaultPiModel);
  // Whether each native harness is routed through OpenRouter — flips the model
  // pickers to OpenRouter's catalog. Sourced from /system-info.
  const claudeCodeUseOpenRouter = Boolean((systemInfo ?? seed)?.claudeCodeUseOpenRouter);
  const codexUseOpenRouter = Boolean((systemInfo ?? seed)?.codexUseOpenRouter);
  const agentsLoading = chatMode === "agent" && !agentsFetched;

  // ── Space ────────────────────────────────────────────────────────
  // The new chat goes into the tab's active space unless the chip below says
  // otherwise. Each field is seeded from the picked space's own default, and
  // a field the space does not define is seeded from this browser's global
  // value AS IT WAS WHEN THE PANEL OPENED — so switching the chip from a space
  // with defaults to one without cannot carry the first space's choices over.
  const { enabled: spacesEnabled, spaces, activeSpaceId, spaceById, refreshSpaces } = useSpaces();
  const [targetSpaceId, setTargetSpaceId] = useState<string>(() => (activeSpaceId && activeSpaceId !== ALL_SPACES ? activeSpaceId : DEFAULT_SPACE_ID));
  const targetSpace = spaceById(targetSpaceId);
  // Where choices for this chat belong — see writesBrowserFallback.
  const fallback = writesBrowserFallback({ enabled: spacesEnabled, spaceId: targetSpace?.id ?? targetSpaceId, liveSpaceCount: spaces.length });
  const {
    recentDirectories: shownRecentDirs,
    removeRecent: removeRecentDir,
    recordRecent: recordRecentDir,
  } = useRecentDirectories({ fallback, targetSpace, refreshSpaces });
  /** This browser's global defaults at mount — the fallback for every field a space leaves unset. */
  const [globals] = useState(() => ({
    provider: getDefaultProvider(),
    effort: getDefaultOpenRouterEffort(),
    permissions: getDefaultPermissions(),
    modelReview: getDefaultModelReview(),
    models: {
      "claude-code": getDefaultClaudeModel(),
      codex: getDefaultCodexModel(),
      pi: getDefaultPiModel(),
    } as Record<AgentProviderKind, string>,
  }));
  /**
   * Fields the user changed since the panel was last seeded. Only these are
   * written back to the space — a value merely displayed (seeded from the
   * fallback) is not a choice, and saving it would turn the fallback into the
   * space's own default behind the user's back.
   */
  const touchedRef = useRef(new Set<"provider" | "model" | "effort" | "defaultPermissions" | "modelReview">());
  const touch =
    <T,>(field: "provider" | "model" | "effort" | "defaultPermissions" | "modelReview", set: (value: T) => void) =>
    (value: T) => {
      touchedRef.current.add(field);
      set(value);
    };
  // Seed once per space picked, never again after: re-seeding on every space
  // refresh would overwrite what the user just chose.
  const seededSpaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!targetSpace || seededSpaceRef.current === targetSpace.id) return;
    seededSpaceRef.current = targetSpace.id;
    // Fields the user already set by hand are their choice for THIS chat and
    // survive a change of space; only the rest are re-seeded.
    const touched = touchedRef.current;
    const d = targetSpace.defaults ?? {};
    // A space saved while a since-retired harness (e.g. "cline") was offered can
    // still name it; there is no button to land on, so use the fallback.
    const spaceProvider = d.provider && (UI_AGENT_PROVIDER_KINDS as readonly string[]).includes(d.provider) ? d.provider : undefined;
    const p = touched.has("provider") ? providerRef.current : (spaceProvider ?? globals.provider);
    // A model is chosen FOR an engine. If the new space switches the engine
    // the user did not pick, a model they picked for the old one would ride
    // along to the wrong engine — drop it and seed the new engine's instead.
    if (touched.has("model") && !touched.has("provider") && p !== providerRef.current) touched.delete("model");
    if (!touched.has("provider")) setProvider(p);
    if (!touched.has("defaultPermissions")) setDefaultPermissions(d.defaultPermissions ? normalizePermissions(d.defaultPermissions) : globals.permissions);
    if (!touched.has("modelReview")) setModelReview(d.modelReview ?? globals.modelReview);
    if (!touched.has("effort")) setEffort(d.effort ?? globals.effort);
    if (!touched.has("model")) {
      const model = (kind: AgentProviderKind) => (d.model && kind === p ? d.model : globals.models[kind]);
      setClaudeModel(model("claude-code"));
      setCodexModel(model("codex"));
      setPiModel(model("pi"));
    }
  }, [targetSpace, globals]);

  /**
   * Persist this chat's choices — see writesBrowserFallback for where they go.
   * A chat started in General (or with spaces unused) writes this browser's
   * fallback, as before spaces. A chat started in any other space writes only
   * the fields the user changed, and only to that space.
   */
  const persistChoices = () => {
    if (fallback) {
      saveDefaultPermissions(defaultPermissions);
      saveDefaultModelReview(modelReview);
      // Persist the user's INTENT (the toggle's current value) rather than the
      // runtime fallback. If Codex is selected but later unconfigured, we'd
      // rather remember "user prefers Codex" so reconfiguring restores it, than
      // silently overwrite their preference with claude-code. The runtime
      // fallback is ephemeral.
      saveDefaultProvider(provider);
      saveDefaultOpenRouterEffort(effort);
      saveDefaultClaudeModel(claudeModel);
      saveDefaultCodexModel(codexModel);
      saveDefaultPiModel(piModel);
    }
    const touched = touchedRef.current;
    if (!spacesEnabled || !targetSpace || touched.size === 0) return;
    // General's stored defaults only exist if someone set them in Settings;
    // otherwise General simply is the fallback written above.
    if (fallback && !spaceHasOwnDefaults(targetSpace)) return;
    void updateSpace(targetSpace.id, {
      defaults: {
        ...(touched.has("provider") && { provider }),
        // The model is meaningful only with its engine, so a changed engine
        // writes the model it now pairs with too.
        ...((touched.has("model") || touched.has("provider")) && { model: modelForProvider(provider).trim() || null }),
        ...(touched.has("effort") && { effort: effort ?? null }),
        ...(touched.has("defaultPermissions") && { defaultPermissions: normalizePermissions(defaultPermissions) }),
        ...(touched.has("modelReview") && { modelReview }),
      },
    })
      .then(() => refreshSpaces())
      .catch(() => {});
  };

  // UI-facing setters: each marks its field as the user's choice.
  const userSetProvider = touch("provider", setProvider);
  const userSetEffort = touch("effort", setEffort);
  const userSetPermissions = touch("defaultPermissions", setDefaultPermissions);
  const userSetModelReview = touch("modelReview", setModelReview);
  const userSetClaudeModel = touch("model", setClaudeModel);
  const userSetCodexModel = touch("model", setCodexModel);
  const userSetPiModel = touch("model", setPiModel);

  const displayPath = folder.trim() || (shownRecentDirs.length > 0 ? shownRecentDirs[0] : "");

  const handleRemoveRecentDir = (path: string) => {
    setConfirmRemovePath(path);
  };

  const openApiSettings = () => {
    onClose();
    navigate("/settings/api");
  };

  // Downgrade to claude-code only when we KNOW the chosen alt-provider is
  // unconfigured (explicit false; `null` = still loading, trust the choice).
  const downgradeProvider = (p: AgentProviderKind): AgentProviderKind => {
    if (p === "codex" && codexConfigured === false) return "claude-code";
    return p;
  };

  // Each provider carries its own model selection; forward the matching one.
  const modelForProvider = (p: AgentProviderKind): string => (p === "codex" ? codexModel : p === "pi" ? piModel : claudeModel);

  // Surface the picker's own validity message on the select and refuse to
  // create. `reportValidity` reads the `setCustomValidity` the picker set.
  // The picker evaluated `displayPath`; a different directory may carry its own
  // project config, so for one the server's fail-closed check decides instead.
  const refuseUnsupportedEffort = (target: string = displayPath): boolean => {
    if (!effortBlocked || target !== displayPath) return false;
    (document.getElementById("newChatEffort") as HTMLSelectElement | null)?.reportValidity();
    return true;
  };

  const handleCreate = (dir?: string) => {
    const target = dir || folder.trim();
    if (!target) return;
    if (refuseUnsupportedEffort(target)) return;

    recordRecentDir(target);
    persistChoices();
    // Runtime guard: only downgrade to claude-code when we KNOW the chosen
    // provider is not configured. While still loading (null), trust the user's
    // choice — sendMessage rejects loudly if creds are missing, so we get a
    // clear error rather than a silent downgrade.
    const effectiveProvider: AgentProviderKind = downgradeProvider(provider);
    // Each provider has its own model selection; forward the one matching
    // the effective provider. `effort` applies to the reasoning-capable
    // providers (codex, pi).
    const trimmedModel = modelForProvider(effectiveProvider).trim();

    setFolder("");
    onClose();
    navigate(`/chat/new?folder=${encodeURIComponent(target)}`, {
      state: {
        ...(spacesEnabled && { spaceId: targetSpaceId }),
        defaultPermissions,
        ...(modelReview && { modelReview: true }),
        provider: effectiveProvider,
        ...(["codex", "pi"].includes(effectiveProvider) && effort && { effort }),
        ...(trimmedModel && { model: trimmedModel }),
        ...(requireCompletion && { requireExplicitCompletion: true }),
      } satisfies ChatRouteState,
    });
  };

  const handleAgentCreate = async (agent: AgentConfig) => {
    if (!agent?.workspacePath) return;
    if (refuseUnsupportedEffort()) return;

    // Persist the provider/effort selection just like the folder path
    // (handleCreate) so the toggle remembers the user's choice regardless of
    // which path they created the chat from.
    persistChoices();

    const agentPermissions: DefaultPermissions = {
      fileRead: "allow",
      fileWrite: "allow",
      codeExecution: "allow",
      webAccess: "allow",
      browserControl: "deny",
      computerControl: "deny",
    };

    let systemPrompt: string | undefined;
    try {
      systemPrompt = await getAgentIdentityPrompt(agent.alias);
    } catch {
      // Continue without identity prompt if fetch fails
    }

    // Agent chats honor the same provider choice the user made on the
    // panel's top radio. Without this, picking OR + Agent would silently
    // create a Claude chat — the inverse of what the toggle implies.
    const effectiveProvider: AgentProviderKind = downgradeProvider(provider);
    const trimmedModel = modelForProvider(effectiveProvider).trim();
    onClose();
    navigate(`/chat/new?folder=${encodeURIComponent(agent.workspacePath)}`, {
      state: {
        ...(spacesEnabled && { spaceId: targetSpaceId }),
        defaultPermissions: agentPermissions,
        systemPrompt,
        agentAlias: agent.alias,
        provider: effectiveProvider,
        ...(["codex", "pi"].includes(effectiveProvider) && effort && { effort }),
        ...(trimmedModel && { model: trimmedModel }),
        ...(requireCompletion && { requireExplicitCompletion: true }),
      } satisfies ChatRouteState,
    });
  };

  // Behavior Section — collapsible, default closed (same pattern as
  // Permissions). Houses harness-behavior toggles for the chat being created;
  // rendered in both the Callboard and Agent modes.
  const renderBehaviorSection = () => (
    <div style={{ marginBottom: 8 }}>
      <button
        onClick={() => setBehaviorOpen(!behaviorOpen)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 0",
          background: "none",
          border: "none",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
          color: "var(--text-muted)",
          textAlign: "left",
        }}
      >
        {behaviorOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>Behavior: {requireCompletion ? "Require explicit completion" : "Default"}</span>
      </button>
      {behaviorOpen && (
        <div>
          {/* Require explicit completion — per-chat, resets to off */}
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "4px 0" }}>
            <input type="checkbox" checked={requireCompletion} onChange={(e) => setRequireCompletion(e.target.checked)} style={{ width: 16, height: 16 }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)" }}>Require explicit completion</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>— re-prompt until objective_complete is called</span>
          </label>
        </div>
      )}
    </div>
  );

  // The provider the user has selected *right now*, for the system-info
  // `onLoad` near the top of this component.
  //
  // That callback can downgrade the selection, and it must judge the selection as
  // it stands when the answer arrives rather than as it stood at mount: the
  // fetch is mount-only, so it must not lean on a render's closure, and a user who
  // picks a provider while the request is in flight would otherwise have that
  // click overruled by a decision made about a provider they had already moved
  // off. The window is short and — now that a cached payload resolves in a
  // microtask — usually zero, but it is exactly the interval in which someone
  // opening the popup and immediately clicking is acting.
  // Written from an effect rather than during render — a ref mutated in the
  // render body is a lint error and, under a re-render React discards, a lie.
  // Both start at the mount value, which is the answer for the whole window in
  // which nothing has been clicked yet.
  const providerRef = useRef(provider);
  useEffect(() => {
    providerRef.current = provider;
  }, [provider]);

  // Lazy fetch agents when agent mode is first selected
  useEffect(() => {
    if (chatMode !== "agent" || agentsFetched) return;
    let cancelled = false;
    listAgents()
      .then((result) => {
        if (!cancelled) {
          setAgents(result);
          setAgentsFetched(true);
        }
      })
      .catch(() => {
        if (!cancelled) setAgentsFetched(true);
      });
    return () => {
      cancelled = true;
    };
  }, [chatMode, agentsFetched]);

  return (
    <>
      {/* Layout (bounded height, internal scroll) lives in NewChatPanel.css. */}
      <div
        className="new-chat-panel"
        data-testid="new-chat-panel"
        style={{
          borderBottom: "1px solid var(--chatlist-header-border)",
          background: "var(--bg-popout)",
        }}
      >
        {spacesEnabled && spaces.length > 1 && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 13, color: "var(--text-muted)" }}>
            <span style={{ fontWeight: 600 }}>Space</span>
            <select
              aria-label="Space for the new chat"
              value={targetSpaceId}
              onChange={(e) => setTargetSpaceId(e.target.value)}
              style={{
                flex: 1,
                padding: "6px 8px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: 13,
              }}
            >
              {spaces.map((space) => (
                <option key={space.id} value={space.id}>
                  {spaceLabel(space)}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* Mode Toggle */}
        <div style={{ display: "flex", marginBottom: 12 }}>
          <button
            onClick={() => {
              setChatMode("claude-code");
            }}
            style={{
              flex: 1,
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 500,
              borderRadius: "8px 0 0 8px",
              border: chatMode === "claude-code" ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: chatMode === "claude-code" ? "var(--accent)" : "var(--bg-secondary)",
              color: chatMode === "claude-code" ? "var(--text-on-accent)" : "var(--text)",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            Callboard
          </button>
          <button
            onClick={() => setChatMode("agent")}
            style={{
              flex: 1,
              padding: "10px 16px",
              fontSize: 14,
              fontWeight: 500,
              borderRadius: "0 8px 8px 0",
              border: chatMode === "agent" ? "1px solid var(--accent)" : "1px solid var(--border)",
              borderLeft: "none",
              background: chatMode === "agent" ? "var(--accent)" : "var(--bg-secondary)",
              color: chatMode === "agent" ? "var(--text-on-accent)" : "var(--text)",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            Agent
          </button>
        </div>

        {chatMode === "claude-code" ? (
          <>
            <ProviderConfigPicker
              cwd={displayPath || undefined}
              provider={provider}
              onProviderChange={userSetProvider}
              piModel={piModel}
              onPiModelChange={userSetPiModel}
              effort={effort}
              onEffortChange={userSetEffort}
              onEffortValidityChange={setEffortBlocked}
              claudeModel={claudeModel}
              onClaudeModelChange={userSetClaudeModel}
              codexModel={codexModel}
              onCodexModelChange={userSetCodexModel}
              codexConfigured={codexConfigured}
              claudeCodeUseOpenRouter={claudeCodeUseOpenRouter}
              codexUseOpenRouter={codexUseOpenRouter}
              onOpenApiSettings={openApiSettings}
            />

            {/* Permissions Section — collapsible, default closed */}
            <div style={{ marginBottom: 8 }}>
              <button
                onClick={() => setPermissionsOpen(!permissionsOpen)}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 0",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textAlign: "left",
                }}
              >
                {permissionsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span>
                  Permissions: {getPermissionsSummary(defaultPermissions)}
                  {modelReview && " · model review"}
                </span>
              </button>
              {permissionsOpen && (
                <PermissionSettings
                  permissions={defaultPermissions}
                  onChange={userSetPermissions}
                  provider={provider}
                  review={{ value: { modelReview, parentAnswers: false }, onChange: (next) => userSetModelReview(next.modelReview) }}
                />
              )}
            </div>

            {/* Behavior Section — collapsible, default closed */}
            {renderBehaviorSection()}

            {/* Directory Section — collapsible, default open */}
            <div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "8px 0",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                }}
              >
                <button
                  onClick={() => setPathOpen(!pathOpen)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "inherit",
                    fontSize: "inherit",
                    fontWeight: "inherit",
                    padding: 0,
                  }}
                >
                  {pathOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <span>Directory{displayPath ? ":" : ""}</span>
                </button>
                {displayPath && !pathOpen ? (
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCreate(displayPath);
                    }}
                    style={{
                      cursor: "pointer",
                      color: "var(--accent-text)",
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      direction: "rtl",
                      flex: 1,
                    }}
                    title={`Open chat in ${displayPath}`}
                  >
                    <bdi dir="ltr">{displayPath}</bdi>
                  </span>
                ) : displayPath ? (
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      direction: "rtl",
                      flex: 1,
                    }}
                  >
                    <bdi dir="ltr">{displayPath}</bdi>
                  </span>
                ) : null}
              </div>

              {pathOpen && (
                <>
                  {shownRecentDirs.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Recent directories</div>
                      {shownRecentDirs.map((dir) => (
                        <div
                          key={dir}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            marginBottom: 4,
                          }}
                        >
                          <button
                            onClick={() => handleCreate(dir)}
                            title={dir}
                            style={{
                              flex: 1,
                              textAlign: "left",
                              background: "var(--surface)",
                              border: "1px solid var(--border)",
                              borderRadius: 8,
                              padding: "10px 12px",
                              fontSize: 14,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              direction: "rtl",
                            }}
                          >
                            <bdi dir="ltr">{dir}</bdi>
                          </button>
                          <button
                            onClick={() => handleRemoveRecentDir(dir)}
                            style={{
                              background: "var(--surface)",
                              border: "1px solid var(--border)",
                              borderRadius: 6,
                              padding: "8px",
                              fontSize: 12,
                              color: "var(--text-muted)",
                              cursor: "pointer",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              minWidth: 28,
                              height: 28,
                            }}
                            title={`Remove ${dir} from recent directories`}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                          margin: "10px 0 6px",
                        }}
                      >
                        Or enter a new path
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 8 }}>
                    <div style={{ flex: 1 }}>
                      <FolderSelector
                        value={folder}
                        onChange={setFolder}
                        placeholder="Project folder path (e.g. /home/user/myproject)"
                        recentDirectories={shownRecentDirs}
                        onRemoveRecentDirectory={removeRecentDir}
                      />
                    </div>
                    <button
                      onClick={() => handleCreate()}
                      disabled={!folder.trim() || effortBlocked}
                      title={effortBlocked ? "Choose a supported reasoning effort or clear it first." : undefined}
                      style={{
                        background: folder.trim() && !effortBlocked ? "var(--accent)" : "var(--border)",
                        color: "var(--text-on-accent)",
                        padding: "10px 16px",
                        borderRadius: 8,
                        fontSize: 14,
                        alignSelf: "flex-start",
                      }}
                    >
                      Create
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Same provider/effort knob as the folder path — the agent chat
                honors this selection (see handleAgentCreate), so it must be
                visible and editable here too. */}
            <ProviderConfigPicker
              provider={provider}
              onProviderChange={userSetProvider}
              piModel={piModel}
              onPiModelChange={userSetPiModel}
              effort={effort}
              onEffortChange={userSetEffort}
              onEffortValidityChange={setEffortBlocked}
              claudeModel={claudeModel}
              onClaudeModelChange={userSetClaudeModel}
              codexModel={codexModel}
              onCodexModelChange={userSetCodexModel}
              codexConfigured={codexConfigured}
              claudeCodeUseOpenRouter={claudeCodeUseOpenRouter}
              codexUseOpenRouter={codexUseOpenRouter}
              onOpenApiSettings={openApiSettings}
            />

            {/* Behavior Section — collapsible, default closed; the checkbox
                inside is forwarded by handleAgentCreate */}
            {renderBehaviorSection()}

            {agentsLoading ? (
              <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>Loading agents...</div>
            ) : agents.length === 0 ? (
              <div style={{ padding: "20px 0", textAlign: "center" }}>
                <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 12 }}>No agents yet.</p>
                <button
                  onClick={() => navigate("/agents/new")}
                  style={{
                    background: "var(--accent)",
                    color: "var(--text-on-accent)",
                    padding: "8px 16px",
                    borderRadius: 8,
                    fontSize: 14,
                    fontWeight: 500,
                  }}
                >
                  Create Agent
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 2 }}>Select an agent</div>
                {agents.map((agent) => (
                  <button
                    key={agent.alias}
                    onClick={() => handleAgentCreate(agent)}
                    disabled={!agent.workspacePath}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      textAlign: "left",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "10px 12px",
                      cursor: agent.workspacePath ? "pointer" : "not-allowed",
                      transition: "border-color 0.15s",
                      opacity: agent.workspacePath ? 1 : 0.5,
                    }}
                    onMouseEnter={(e) => {
                      if (agent.workspacePath) e.currentTarget.style.borderColor = "var(--accent)";
                    }}
                    onMouseLeave={(e) => {
                      if (agent.workspacePath) e.currentTarget.style.borderColor = "var(--border)";
                    }}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <Bot size={16} style={{ color: "var(--accent-text)" }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 500 }}>{agent.name}</div>
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {agent.description}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmRemoveRecentDirectory path={confirmRemovePath} onConfirm={removeRecentDir} onClose={() => setConfirmRemovePath(null)} />
    </>
  );
}
