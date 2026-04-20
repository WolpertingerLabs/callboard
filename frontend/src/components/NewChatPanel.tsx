import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { X, ChevronDown, ChevronRight, Bot } from "lucide-react";
import { listAgents, getAgentIdentityPrompt, type DefaultPermissions, type AgentConfig } from "../api";
import PermissionSettings from "./PermissionSettings";
import ConfirmModal from "./ConfirmModal";
import FolderSelector from "./FolderSelector";
import { getDefaultPermissions, saveDefaultPermissions, getRecentDirectories, addRecentDirectory, removeRecentDirectory } from "../utils/localStorage";

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
  const [pathOpen, setPathOpen] = useState(true);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentsFetched, setAgentsFetched] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; path: string }>({ isOpen: false, path: "" });
  const agentsLoading = chatMode === "agent" && !agentsFetched;

  const displayPath = folder.trim() || (recentDirs.length > 0 ? recentDirs[0] : "");

  const updateRecentDirs = () => {
    setRecentDirs(getRecentDirectories().map((r) => r.path));
  };

  const handleRemoveRecentDir = (path: string) => {
    setConfirmModal({ isOpen: true, path });
  };

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

    setFolder("");
    onClose();
    navigate(`/chat/new?folder=${encodeURIComponent(target)}`, {
      state: { defaultPermissions },
    });
  };

  const handleAgentCreate = async (agent: AgentConfig) => {
    if (!agent?.workspacePath) return;

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

    onClose();
    navigate(`/chat/new?folder=${encodeURIComponent(agent.workspacePath)}`, {
      state: { defaultPermissions: agentPermissions, systemPrompt, agentAlias: agent.alias },
    });
  };

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
              {permissionsOpen && <PermissionSettings permissions={defaultPermissions} onChange={setDefaultPermissions} />}
            </div>

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
                      color: "var(--accent)",
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
                      <Bot size={16} style={{ color: "var(--accent)" }} />
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
