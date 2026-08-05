import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { X, ChevronDown, ChevronRight, Bot } from "lucide-react";
import { listAgents, getAgentIdentityPrompt, getSystemInfo, getAgentSettings, type DefaultPermissions, type AgentConfig, type AcpProviderInfo } from "../api";
import type { ModelRoutingConfig } from "shared/types/index.js";
import PermissionSettings from "./PermissionSettings";
import ConfirmModal from "./ConfirmModal";
import FolderSelector from "./FolderSelector";
import ProviderConfigPicker from "./ProviderConfigPicker";
import ModelRouterField from "./ModelRouterField";
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
  getDefaultOpenRouterModel,
  saveDefaultOpenRouterModel,
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
  // Provider selector — defaults to whatever the user last picked. OpenRouter
  // can only be selected once OPENROUTER_API_KEY is configured in Settings → API.
  const [provider, setProvider] = useState<AgentProviderKind>(getDefaultProvider);
  // OpenRouter-only knob — surfaced under the provider tile when "openrouter"
  // is selected. `undefined` means "don't send a reasoning payload" (preserves
  // each model's default behavior). Persisted in localStorage independently
  // of the provider so toggling back to OR restores the prior selection.
  const [effort, setEffort] = useState<EffortLevel | undefined>(getDefaultOpenRouterEffort);
  // OpenRouter model slug. Empty string = "use the global default from Settings → API".
  // Persisted across reloads via localStorage, like provider/effort.
  const [model, setModel] = useState<string>(getDefaultOpenRouterModel);
  // Anthropic model for Claude Code chats (alias or full ID). Empty string =
  // "use the global default from Settings → API". Stored separately from the
  // OR model so toggling providers restores each one's prior selection.
  const [claudeModel, setClaudeModel] = useState<string>(getDefaultClaudeModel);
  // Codex model. Empty string = "use the global default
  // from Settings → API". Stored separately from the OR/Claude models so
  // toggling providers restores each one's prior selection.
  const [codexModel, setCodexModel] = useState<string>(getDefaultCodexModel);
  // `null` until /system-info returns — Codex treated as available until an
  // explicit false (same tri-state as openRouterConfigured below).
  const [codexConfigured, setCodexConfigured] = useState<boolean | null>(null);
  // ACP vendors from /system-info. Empty until it returns, and empty is the
  // honest default — unlike the two tri-states above, an unknown ACP list means
  // there are no buttons to render at all, so there is no optimistic case.
  const [acpProviders, setAcpProviders] = useState<AcpProviderInfo[]>([]);
  const [acpProviderId, setAcpProviderId] = useState<string>(getDefaultAcpProviderId);
  // Per-chat ACP model, as the vendor names it. Empty = leave the vendor CLI's
  // own configured model alone; there is no callboard-side global ACP default,
  // because one kind covers many vendors whose catalogs share nothing.
  const [acpModel, setAcpModel] = useState<string>(getDefaultAcpModel);
  // Per-chat Cline model, within the provider configured in Settings → API.
  // Empty = that global default (and when that is blank too, the adapter asks
  // the SDK for the provider's own default — an empty model id is rejected by
  // Cline's config schema).
  const [clineModel, setClineModel] = useState<string>(getDefaultClineModel);
  // Which Cline provider scopes the model catalog. Surfaced by /system-info so
  // selecting `openrouter` there offers OpenRouter's models here.
  const [clineProviderId, setClineProviderId] = useState<string>("");
  const [piModel, setPiModel] = useState<string>(getDefaultPiModel);
  // `null` until the /system-info fetch returns. We use this tri-state to
  // avoid destroying a user's saved "openrouter" preference during the
  // first-paint race: if they click Create before the fetch resolves we
  // optimistically honor their stored choice rather than silently
  // downgrading to claude-code.
  const [openRouterConfigured, setOpenRouterConfigured] = useState<boolean | null>(null);
  // Effective per-session spend cap surfaced from /system-info. Shown
  // alongside the OR provider tile so users see the ceiling BEFORE hitting
  // "Agent reached the maximum budget limit." mid-session. `null` while the
  // fetch is in flight or unreachable — the cap line is suppressed in that
  // state rather than showing a confusing default.
  const [openRouterMaxBudgetUsd, setOpenRouterMaxBudgetUsd] = useState<number | null>(null);
  // Whether each native harness is routed through OpenRouter — flips the model
  // pickers to OpenRouter's catalog. Sourced from /system-info.
  const [claudeCodeUseOpenRouter, setClaudeCodeUseOpenRouter] = useState(false);
  const [codexUseOpenRouter, setCodexUseOpenRouter] = useState(false);
  // Model Routing (OpenRouter-only). Config is loaded from agent settings so we
  // know whether the feature is enabled and which ranks/tiers to offer. The
  // per-chat opt-in (`modelRouting`) resets to off each time the panel opens.
  const [routingConfig, setRoutingConfig] = useState<ModelRoutingConfig | null>(null);
  const [modelRouting, setModelRouting] = useState(false);
  const [modelRoutingRankId, setModelRoutingRankId] = useState<string>("");
  const routingAvailable = provider === "openrouter" && !!routingConfig?.enabled && routingConfig.ranks.length > 0;
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
    if (p === "openrouter" && openRouterConfigured === false) return "claude-code";
    if (p === "codex" && codexConfigured === false) return "claude-code";
    // No installed vendor means the request would be rejected by the route, so
    // downgrade here for the same reason the other two do.
    if (p === "acp" && !acpProviders.some((v) => v.id === acpProviderId && v.available)) return "claude-code";
    return p;
  };

  // Each provider carries its own model selection; forward the matching one.
  // ACP's is the vendor's own model id, applied after the session attaches.
  const modelForProvider = (p: AgentProviderKind): string =>
    p === "openrouter" ? model : p === "codex" ? codexModel : p === "acp" ? acpModel : p === "cline" ? clineModel : p === "pi" ? piModel : claudeModel;

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
    // Persist the user's INTENT (the radio's current value) rather than the
    // runtime fallback. If OR is selected but later disabled, we'd rather
    // remember "user prefers OR" so reconfiguring restores it, than silently
    // overwrite their preference with claude-code. The runtime fallback is
    // ephemeral.
    saveDefaultProvider(provider);
    saveDefaultOpenRouterEffort(effort);
    saveDefaultOpenRouterModel(model);
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
    // providers (openrouter, codex).
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
        ...((effectiveProvider === "openrouter" || effectiveProvider === "codex") && effort && { effort }),
        ...(trimmedModel && { model: trimmedModel }),
        ...(requireCompletion && { requireExplicitCompletion: true }),
        // Pass the router toggle as an explicit boolean (not only when true) so
        // Chat.tsx can tell "user unchecked it" (false) apart from "panel didn't
        // offer a choice" (undefined) — otherwise unchecking gets re-defaulted ON.
        ...(effectiveProvider === "openrouter" && routingAvailable && { modelRouting, modelRoutingRankId }),
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
    saveDefaultOpenRouterModel(model);
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
        // Pass the router toggle as an explicit boolean (not only when true) so
        // Chat.tsx can tell "user unchecked it" (false) apart from "panel didn't
        // offer a choice" (undefined) — otherwise unchecking gets re-defaulted ON.
        ...(effectiveProvider === "openrouter" && routingAvailable && { modelRouting, modelRoutingRankId }),
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

  // Fetch system info once to learn whether OpenRouter is configured. Until
  // the fetch resolves, openRouterConfigured stays `null` and the UI treats
  // OR as available — the actual gate is in the radio's disabled prop below.
  // If OR was selected from localStorage but turns out to be unconfigured,
  // we silently flip the in-memory state to claude-code without touching
  // localStorage (the user's saved preference is preserved for the next time
  // they re-enable OR).
  // Load the model-routing config so the panel can offer the router toggle +
  // rank selector when the feature is enabled. Best-effort — the toggle simply
  // stays hidden if this fails.
  useEffect(() => {
    let cancelled = false;
    getAgentSettings()
      .then((s) => {
        if (cancelled) return;
        const cfg = s.modelRouting ?? null;
        setRoutingConfig(cfg);
        if (cfg) {
          const ranks = [...cfg.ranks].sort((a, b) => a.order - b.order);
          setModelRoutingRankId(cfg.defaultRankId || ranks[0]?.id || "");
          // Default the per-chat router toggle ON when routing is enabled
          // globally, so configuring it in Settings actually takes effect for
          // new OpenRouter chats (opt-out per chat) rather than silently
          // requiring the toggle to be flipped every time.
          setModelRouting(cfg.enabled);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSystemInfo()
      .then((info) => {
        if (cancelled) return;
        const ok = Boolean(info.openRouterConfigured);
        setOpenRouterConfigured(ok);
        if (typeof info.openRouterMaxBudgetUsd === "number") {
          setOpenRouterMaxBudgetUsd(info.openRouterMaxBudgetUsd);
        }
        if (!ok && provider === "openrouter") {
          setProvider("claude-code");
        }
        const codexOk = Boolean(info.codexConfigured);
        setCodexConfigured(codexOk);
        if (!codexOk && provider === "codex") {
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
        const usable = vendors.find((v) => v.id === acpProviderId && v.available) ?? vendors.find((v) => v.available);
        if (usable && usable.id !== acpProviderId) setAcpProviderId(usable.id);
        // Nothing installed (or the saved vendor was uninstalled) — fall back
        // rather than leaving a selected provider that cannot start a chat.
        if (!usable && provider === "acp") setProvider("claude-code");
      })
      .catch(() => {
        // /system-info unreachable — assume unavailable and surface the
        // toggle as disabled rather than silently allowing a request that
        // will 500 on submit.
        if (!cancelled) {
          setOpenRouterConfigured(false);
          setCodexConfigured(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
              model={model}
              onModelChange={setModel}
              claudeModel={claudeModel}
              onClaudeModelChange={setClaudeModel}
              codexModel={codexModel}
              onCodexModelChange={setCodexModel}
              codexConfigured={codexConfigured}
              openRouterConfigured={openRouterConfigured}
              openRouterMaxBudgetUsd={openRouterMaxBudgetUsd}
              claudeCodeUseOpenRouter={claudeCodeUseOpenRouter}
              codexUseOpenRouter={codexUseOpenRouter}
              onOpenApiSettings={openApiSettings}
              // When routing is available, swap the plain model field for the
              // Manual/Router switcher so the two model sources stay mutually
              // exclusive instead of a router silently overriding a visible model.
              openRouterModelSlot={
                routingAvailable ? (
                  <ModelRouterField
                    mode="panel"
                    routingConfig={routingConfig}
                    useRouter={modelRouting}
                    onUseRouterChange={setModelRouting}
                    rankId={modelRoutingRankId}
                    onRankChange={setModelRoutingRankId}
                    model={model}
                    onModelChange={setModel}
                    idPrefix="newChat"
                  />
                ) : undefined
              }
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
              model={model}
              onModelChange={setModel}
              claudeModel={claudeModel}
              onClaudeModelChange={setClaudeModel}
              codexModel={codexModel}
              onCodexModelChange={setCodexModel}
              codexConfigured={codexConfigured}
              openRouterConfigured={openRouterConfigured}
              openRouterMaxBudgetUsd={openRouterMaxBudgetUsd}
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
