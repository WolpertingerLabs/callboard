import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { X, ChevronDown, ChevronRight, Bot } from "lucide-react";
import { listAgents, getAgentIdentityPrompt, getSystemInfo, cachedSystemInfo, type DefaultPermissions, type AgentConfig, type AcpProviderInfo } from "../api";
import PermissionSettings from "./PermissionSettings";
import ConfirmModal from "./ConfirmModal";
import FolderSelector from "./FolderSelector";
import ProviderConfigPicker from "./ProviderConfigPicker";
import {
  getDefaultPermissions,
  saveDefaultPermissions,
  getRecentDirectories,
  addRecentDirectory,
  removeRecentDirectory,
  getDefaultProvider,
  saveDefaultProvider,
  getDefaultOpenRouterEffort,
  saveDefaultOpenRouterEffort,
  getDefaultClaudeModel,
  saveDefaultClaudeModel,
  getDefaultCodexModel,
  saveDefaultCodexModel,
  getDefaultAcpProviderId,
  saveDefaultAcpProviderId,
  getDefaultAcpModel,
  getDefaultPiModel,
  saveDefaultAcpModel,
  getDefaultClineModel,
  saveDefaultClineModel,
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
  const [recentDirs, setRecentDirs] = useState(() => getRecentDirectories().map((r) => r.path));
  const [chatMode, setChatMode] = useState<"claude-code" | "agent">("claude-code");
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  // Behavior section (harness behavior toggles) — collapsible, default
  // closed to match the Permissions section.
  const [behaviorOpen, setBehaviorOpen] = useState(false);
  const [pathOpen, setPathOpen] = useState(true);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsFetched, setAgentsFetched] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; path: string }>({ isOpen: false, path: "" });
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
  // Anthropic model for Claude Code chats (alias or full ID). Empty string =
  // "use the global default from Settings → API". Stored separately from the
  // other providers' models so toggling restores each one's prior selection.
  const [claudeModel, setClaudeModel] = useState<string>(getDefaultClaudeModel);
  // Codex model. Empty string = "use the global default
  // from Settings → API". Stored separately from the Claude model so
  // toggling providers restores each one's prior selection.
  const [codexModel, setCodexModel] = useState<string>(getDefaultCodexModel);
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
  const [codexConfigured, setCodexConfigured] = useState<boolean | null>(null);
  // ACP vendors from /system-info. Empty until it returns, and empty is the
  // honest default — unlike the two tri-states above, an unknown ACP list means
  // there are no buttons to render at all, so there is no optimistic case.
  //
  // Seeded from the tab's cached payload, and that seed is the entire fix for
  // the OpenCode button arriving late. This panel is conditionally mounted, so
  // every popup open remounted it with an empty list; the other four provider
  // buttons are hardcoded JSX and painted on frame one while this one waited on
  // a round trip, which showed up as a visible pop-in and a row reflow. The
  // effect below cannot close that gap no matter how fast the fetch is —
  // `useEffect` runs after the first paint by definition. `null` from the cache
  // means "never fetched in this tab", which still yields the empty list.
  //
  // It is a seed and not an answer: the effect re-fetches with `refresh` and
  // overwrites this a frame later, which is what keeps a vendor uninstalled
  // since the cache warmed from staying clickable. The window in which this list
  // is both stale and interactive is that one round trip — the price of drawing
  // anything at all before the daemon has answered.
  const [acpProviders, setAcpProviders] = useState<AcpProviderInfo[]>(() => seed?.acpProviders ?? []);
  const [acpProviderId, setAcpProviderId] = useState<string>(getDefaultAcpProviderId);
  // Per-chat ACP model, as the vendor names it. Empty falls back to this
  // vendor's entry in `AgentSettings.acpProviderModels` (Settings → API), and
  // to the vendor CLI's own configured model when that is blank too. That
  // settings field is keyed by vendor id rather than flat precisely because one
  // kind covers many vendors whose catalogs share nothing — there is still no
  // single global ACP default, only a per-vendor one.
  const [acpModel, setAcpModel] = useState<string>(getDefaultAcpModel);
  // Per-chat Cline model, within the provider configured in Settings → API.
  // Empty = that global default (and when that is blank too, the adapter asks
  // the SDK for the provider's own default — an empty model id is rejected by
  // Cline's config schema).
  const [clineModel, setClineModel] = useState<string>(getDefaultClineModel);
  // Which Cline provider scopes the model catalog. Surfaced by /system-info so
  // selecting `openrouter` there offers OpenRouter's models here.
  const [clineProviderId, setClineProviderId] = useState<string>(() => seed?.clineProviderId ?? "");
  const [piModel, setPiModel] = useState<string>(getDefaultPiModel);
  // Whether each native harness is routed through OpenRouter — flips the model
  // pickers to OpenRouter's catalog. Sourced from /system-info.
  const [claudeCodeUseOpenRouter, setClaudeCodeUseOpenRouter] = useState(() => Boolean(seed?.claudeCodeUseOpenRouter));
  const [codexUseOpenRouter, setCodexUseOpenRouter] = useState(() => Boolean(seed?.codexUseOpenRouter));
  const agentsLoading = chatMode === "agent" && !agentsFetched;

  const displayPath = folder.trim() || (recentDirs.length > 0 ? recentDirs[0] : "");

  const updateRecentDirs = () => {
    setRecentDirs(getRecentDirectories().map((r) => r.path));
  };

  const handleRemoveRecentDir = (path: string) => {
    setConfirmModal({ isOpen: true, path });
  };

  const openApiSettings = () => {
    onClose();
    navigate("/settings/api");
  };

  // Downgrade to claude-code only when we KNOW the chosen alt-provider is
  // unconfigured (explicit false; `null` = still loading, trust the choice).
  const downgradeProvider = (p: AgentProviderKind): AgentProviderKind => {
    if (p === "codex" && codexConfigured === false) return "claude-code";
    // No installed vendor means the request would be rejected by the route, so
    // downgrade here for the same reason the other two do.
    if (p === "acp" && !acpProviders.some((v) => v.id === acpProviderId && v.available)) return "claude-code";
    return p;
  };

  // Each provider carries its own model selection; forward the matching one.
  // ACP's is the vendor's own model id, applied after the session attaches.
  const modelForProvider = (p: AgentProviderKind): string =>
    p === "codex" ? codexModel : p === "acp" ? acpModel : p === "cline" ? clineModel : p === "pi" ? piModel : claudeModel;

  const confirmRemoveRecentDir = () => {
    removeRecentDirectory(confirmModal.path);
    updateRecentDirs();
    setConfirmModal({ isOpen: false, path: "" });
  };

  const handleCreate = (dir?: string) => {
    const target = dir || folder.trim();
    if (!target) return;

    saveDefaultPermissions(defaultPermissions);
    addRecentDirectory(target);
    updateRecentDirs();
    // Persist the user's INTENT (the toggle's current value) rather than the
    // runtime fallback. If Codex is selected but later unconfigured, we'd rather
    // remember "user prefers Codex" so reconfiguring restores it, than silently
    // overwrite their preference with claude-code. The runtime fallback is
    // ephemeral.
    saveDefaultProvider(provider);
    saveDefaultOpenRouterEffort(effort);
    saveDefaultClaudeModel(claudeModel);
    saveDefaultCodexModel(codexModel);
    saveDefaultAcpProviderId(acpProviderId);
    saveDefaultAcpModel(acpModel);
    saveDefaultClineModel(clineModel);
    saveDefaultPiModel(piModel);
    // Runtime guard: only downgrade to claude-code when we KNOW the chosen
    // provider is not configured. While still loading (null), trust the user's
    // choice — sendMessage rejects loudly if creds are missing, so we get a
    // clear error rather than a silent downgrade.
    const effectiveProvider: AgentProviderKind = downgradeProvider(provider);
    // Each provider has its own model selection; forward the one matching
    // the effective provider. `effort` applies to the reasoning-capable
    // providers (codex, cline, pi).
    const trimmedModel = modelForProvider(effectiveProvider).trim();

    setFolder("");
    onClose();
    navigate(`/chat/new?folder=${encodeURIComponent(target)}`, {
      state: {
        defaultPermissions,
        provider: effectiveProvider,
        // The vendor travels with the kind — `provider: "acp"` alone does not
        // say which harness runs the chat, and the route rejects it without this.
        ...(effectiveProvider === "acp" && { acpProviderId }),
        ...(effectiveProvider === "codex" && effort && { effort }),
        ...(trimmedModel && { model: trimmedModel }),
        ...(requireCompletion && { requireExplicitCompletion: true }),
      },
    });
  };

  const handleAgentCreate = async (agent: AgentConfig) => {
    if (!agent?.workspacePath) return;

    // Persist the provider/effort selection just like the folder path
    // (handleCreate) so the toggle remembers the user's choice regardless of
    // which path they created the chat from.
    saveDefaultProvider(provider);
    saveDefaultOpenRouterEffort(effort);
    saveDefaultClaudeModel(claudeModel);
    saveDefaultCodexModel(codexModel);
    saveDefaultAcpProviderId(acpProviderId);
    saveDefaultAcpModel(acpModel);
    saveDefaultClineModel(clineModel);
    saveDefaultPiModel(piModel);

    const agentPermissions: DefaultPermissions = {
      fileRead: "allow",
      fileWrite: "allow",
      codeExecution: "allow",
      webAccess: "allow",
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
        defaultPermissions: agentPermissions,
        systemPrompt,
        agentAlias: agent.alias,
        provider: effectiveProvider,
        ...(effectiveProvider === "acp" && { acpProviderId }),
        ...(trimmedModel && { model: trimmedModel }),
        ...(requireCompletion && { requireExplicitCompletion: true }),
      },
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

  // The provider the user has selected *right now*, for the effect below.
  //
  // That effect can downgrade the selection, and it must judge the selection as
  // it stands when the answer arrives rather than as it stood at mount: it has
  // `[]` deps, so its closure is frozen at the first render, and a user who
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
  const acpProviderIdRef = useRef(acpProviderId);
  useEffect(() => {
    providerRef.current = provider;
    acpProviderIdRef.current = acpProviderId;
  }, [provider, acpProviderId]);

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
  // synchronous `cachedSystemInfo()` seed is the entire reason the OpenCode
  // button paints on frame one; nothing about that requires *this* call to be
  // cached as well.
  //
  // And it must not be. `getSystemInfo()`'s default resolves with the cached
  // payload and hands the revalidation to the module cache rather than to the
  // caller — so a panel that took the default was pinned to whatever this tab
  // last saw, for its whole lifetime, with no correction until the next open.
  // That is not a slower version of the truth, it is a different answer:
  // uninstall the OpenCode CLI and reopen, and the button rendered enabled,
  // `downgradeProvider` read the same stale list and agreed, and the chat failed
  // at start instead of quietly falling back. `main` always had fresh data one
  // frame in, so serving stale here was a regression rather than a trade.
  //
  // `refresh` restores that and keeps the instant paint — and it is still
  // exactly one payload per mount, so the flip-flop hazard the seed-plus-stale
  // arrangement was reaching for does not come back. The seed decides what is
  // *drawn* first; this decides what is *believed*. Do not drop the `refresh` to
  // save a round trip: the round trip is the point.
  useEffect(() => {
    let cancelled = false;
    getSystemInfo({ refresh: true })
      .then((info) => {
        if (cancelled) return;
        const codexOk = Boolean(info.codexConfigured);
        setCodexConfigured(codexOk);
        if (!codexOk && providerRef.current === "codex") {
          setProvider("claude-code");
        }
        setClaudeCodeUseOpenRouter(Boolean(info.claudeCodeUseOpenRouter));
        setCodexUseOpenRouter(Boolean(info.codexUseOpenRouter));
        // Scopes the Cline model catalog. No availability check to match the
        // ACP block below: Cline is embedded and falls back to the backend's
        // own environment credentials, so there is no unavailable state to
        // fall back FROM.
        setClineProviderId(info.clineProviderId ?? "");

        // The stored ACP vendor is validated here rather than in localStorage,
        // because this is the only place that knows the live list — vendors are
        // server-side data and can appear or disappear without a frontend build.
        const vendors = info.acpProviders ?? [];
        setAcpProviders(vendors);
        const selectedAcpId = acpProviderIdRef.current;
        const usable = vendors.find((v) => v.id === selectedAcpId && v.available) ?? vendors.find((v) => v.available);
        if (usable && usable.id !== selectedAcpId) setAcpProviderId(usable.id);
        // Nothing installed (or the saved vendor was uninstalled) — fall back
        // rather than leaving a selected provider that cannot start a chat.
        if (!usable && providerRef.current === "acp") setProvider("claude-code");
      })
      .catch(() => {
        // /system-info unreachable — assume unavailable and surface the
        // toggle as disabled rather than silently allowing a request that
        // will 500 on submit.
        if (!cancelled) setCodexConfigured(false);
      });
    return () => {
      cancelled = true;
    };
    // No suppression needed any more: reading the two mutable selections through
    // refs is what took `provider` and `acpProviderId` out of this closure, so
    // the empty dependency list is now honest rather than asserted over a lint
    // rule that disagreed with it.
  }, []);

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
      <div
        style={{
          padding: "12px 20px",
          borderBottom: "1px solid var(--chatlist-header-border)",
          background: "var(--bg-popout)",
        }}
      >
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
              provider={provider}
              onProviderChange={setProvider}
              acpProviders={acpProviders}
              acpProviderId={acpProviderId}
              onAcpProviderChange={setAcpProviderId}
              acpModel={acpModel}
              onAcpModelChange={setAcpModel}
              clineModel={clineModel}
              onClineModelChange={setClineModel}
              clineProviderId={clineProviderId}
              piModel={piModel}
              onPiModelChange={setPiModel}
              effort={effort}
              onEffortChange={setEffort}
              claudeModel={claudeModel}
              onClaudeModelChange={setClaudeModel}
              codexModel={codexModel}
              onCodexModelChange={setCodexModel}
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
                <span>Permissions: {getPermissionsSummary(defaultPermissions)}</span>
              </button>
              {permissionsOpen && <PermissionSettings permissions={defaultPermissions} onChange={setDefaultPermissions} provider={provider} />}
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
                    {displayPath}
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
                    {displayPath}
                  </span>
                ) : null}
              </div>

              {pathOpen && (
                <>
                  {recentDirs.length > 0 && (
                    <div style={{ marginBottom: 10 }}>
                      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Recent directories</div>
                      {recentDirs.map((dir) => (
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
                            {dir}
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
                      <FolderSelector value={folder} onChange={setFolder} placeholder="Project folder path (e.g. /home/user/myproject)" />
                    </div>
                    <button
                      onClick={() => handleCreate()}
                      disabled={!folder.trim()}
                      style={{
                        background: folder.trim() ? "var(--accent)" : "var(--border)",
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
              onProviderChange={setProvider}
              acpProviders={acpProviders}
              acpProviderId={acpProviderId}
              onAcpProviderChange={setAcpProviderId}
              acpModel={acpModel}
              onAcpModelChange={setAcpModel}
              clineModel={clineModel}
              onClineModelChange={setClineModel}
              clineProviderId={clineProviderId}
              piModel={piModel}
              onPiModelChange={setPiModel}
              effort={effort}
              onEffortChange={setEffort}
              claudeModel={claudeModel}
              onClaudeModelChange={setClaudeModel}
              codexModel={codexModel}
              onCodexModelChange={setCodexModel}
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

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal({ isOpen: false, path: "" })}
        onConfirm={confirmRemoveRecentDir}
        title="Remove Recent Directory"
        message={`Are you sure you want to remove "${confirmModal.path}" from your recent directories? This action cannot be undone.`}
        confirmText="Remove"
        confirmStyle="danger"
      />
    </>
  );
}
