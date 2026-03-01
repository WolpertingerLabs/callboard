/**
 * ListenerConfigPanel — Auto-renders listener configuration forms from field schemas.
 *
 * Fetches config schema via `list_listener_configs` and renders appropriate
 * controls for each field type. Dynamic options are fetched lazily via
 * `resolve_listener_options` when the user focuses a select field.
 *
 * Currently read-only (displays current defaults/schema). Future: save
 * listener parameter overrides to config.
 */
import { useState, useEffect, useCallback } from "react";
import {
  X,
  Radio,
  Loader2,
  ChevronDown,
  ChevronRight,
  Info,
  Play,
  Square,
  RotateCw,
  Check,
  AlertTriangle,
  Zap,
} from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import { getListenerConfigs, resolveListenerOptions, controlListener } from "../api";
import type { ListenerConfigSchema, ListenerConfigField, ListenerConfigOption, IngestorStatus, LifecycleResult } from "../api";

interface ListenerConfigPanelProps {
  connectionAlias: string;
  connectionName: string;
  caller: string;
  ingestorStatus?: IngestorStatus;
  onClose: () => void;
  onStatusChange?: () => void;
}

export default function ListenerConfigPanel({
  connectionAlias,
  connectionName,
  caller,
  ingestorStatus,
  onClose,
  onStatusChange,
}: ListenerConfigPanelProps) {
  const [config, setConfig] = useState<ListenerConfigSchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [controlAction, setControlAction] = useState<string | null>(null);
  const [controlResult, setControlResult] = useState<{ success: boolean; message: string } | null>(null);

  // Dynamic options cache: fieldKey → options[]
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, ListenerConfigOption[]>>({});
  const [loadingOptions, setLoadingOptions] = useState<string | null>(null);

  // Expanded field groups
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["default"]));

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getListenerConfigs(caller);
      const match = data.configs.find((c) => c.connection === connectionAlias);
      setConfig(match || null);
      if (!match) {
        setError("No listener configuration found for this connection.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to load listener config");
    } finally {
      setLoading(false);
    }
  }, [caller, connectionAlias]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  const handleControl = async (action: "start" | "stop" | "restart") => {
    setControlAction(action);
    setControlResult(null);
    try {
      const result = await controlListener(connectionAlias, action, caller);
      const r = Array.isArray(result) ? result[0] : result;
      setControlResult({
        success: (r as LifecycleResult).success,
        message: (r as LifecycleResult).error || `Listener ${action}${action === "stop" ? "ped" : "ed"} successfully`,
      });
      onStatusChange?.();
    } catch (err: any) {
      setControlResult({ success: false, message: err.message || `Failed to ${action} listener` });
    } finally {
      setControlAction(null);
    }
  };

  const handleFetchDynamicOptions = async (field: ListenerConfigField) => {
    if (!field.dynamicOptions || dynamicOptions[field.key]) return;
    setLoadingOptions(field.key);
    try {
      const result = await resolveListenerOptions(connectionAlias, field.key, caller);
      if (result.success && result.options) {
        setDynamicOptions((prev) => ({ ...prev, [field.key]: result.options! }));
      }
    } catch {
      // silently fail — static options or placeholder will remain
    } finally {
      setLoadingOptions(null);
    }
  };

  const toggleGroup = (group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  // Group fields by their `group` property
  const groupedFields: Record<string, ListenerConfigField[]> = {};
  if (config?.fields) {
    for (const field of config.fields) {
      const group = field.group || "default";
      if (!groupedFields[group]) groupedFields[group] = [];
      groupedFields[group].push(field);
    }
  }

  // Ingestor state colors
  const stateColor = (state?: string) => {
    switch (state) {
      case "connected":
        return "var(--success)";
      case "starting":
      case "reconnecting":
        return "var(--warning)";
      case "error":
        return "var(--error)";
      case "stopped":
      default:
        return "var(--text-muted)";
    }
  };

  return (
    <ModalOverlay>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 0,
          maxWidth: 560,
          width: "calc(100% - 40px)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
              <Radio size={16} style={{ marginRight: 8, verticalAlign: "middle", color: "var(--accent)" }} />
              {connectionName} Listener
            </h2>
            {config && (
              <p
                style={{
                  fontSize: 13,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                  marginTop: 4,
                }}
              >
                {config.description || config.name}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              padding: 4,
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
              marginLeft: 12,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "20px 24px",
          }}
        >
          {/* Loading */}
          {loading && (
            <div
              style={{
                textAlign: "center",
                padding: "32px 0",
                color: "var(--text-muted)",
              }}
            >
              <Loader2 size={20} style={{ animation: "spin 1s linear infinite", marginBottom: 8 }} />
              <p style={{ fontSize: 13 }}>Loading listener configuration...</p>
            </div>
          )}

          {/* Error */}
          {!loading && error && !config && (
            <div
              style={{
                textAlign: "center",
                padding: "32px 0",
                color: "var(--text-muted)",
                fontSize: 13,
              }}
            >
              {error}
            </div>
          )}

          {/* Ingestor Status + Controls */}
          {ingestorStatus && (
            <div style={{ marginBottom: 20 }}>
              <h3
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: 12,
                }}
              >
                Listener Status
              </h3>
              <div
                style={{
                  background: "var(--bg)",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  padding: 14,
                }}
              >
                {/* Status row */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 10,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: stateColor(ingestorStatus.state),
                        boxShadow: ingestorStatus.state === "connected" ? `0 0 6px ${stateColor(ingestorStatus.state)}` : "none",
                      }}
                    />
                    <span style={{ fontSize: 14, fontWeight: 500, textTransform: "capitalize" }}>{ingestorStatus.state}</span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 6px",
                        borderRadius: 4,
                        background: "var(--bg-secondary)",
                        color: "var(--text-muted)",
                      }}
                    >
                      {ingestorStatus.type}
                    </span>
                  </div>
                </div>

                {/* Stats */}
                <div
                  style={{
                    display: "flex",
                    gap: 16,
                    fontSize: 12,
                    color: "var(--text-muted)",
                    marginBottom: 12,
                  }}
                >
                  <span>
                    <Zap size={10} style={{ marginRight: 3, verticalAlign: "middle" }} />
                    {ingestorStatus.totalEventsReceived} events
                  </span>
                  <span>Buffered: {ingestorStatus.bufferedEvents}</span>
                  {ingestorStatus.lastEventAt && (
                    <span>Last: {new Date(ingestorStatus.lastEventAt).toLocaleTimeString()}</span>
                  )}
                </div>

                {/* Error display */}
                {ingestorStatus.error && (
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--error)",
                      background: "color-mix(in srgb, var(--error) 8%, transparent)",
                      padding: "6px 10px",
                      borderRadius: 6,
                      marginBottom: 12,
                    }}
                  >
                    <AlertTriangle size={12} style={{ verticalAlign: "middle", marginRight: 4 }} />
                    {ingestorStatus.error}
                  </div>
                )}

                {/* Control buttons */}
                <div style={{ display: "flex", gap: 6 }}>
                  <button
                    onClick={() => handleControl("start")}
                    disabled={controlAction !== null || ingestorStatus.state === "connected"}
                    style={{
                      flex: 1,
                      padding: "7px 0",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background:
                        ingestorStatus.state === "connected" ? "var(--bg-secondary)" : "color-mix(in srgb, var(--success) 10%, var(--bg))",
                      color: ingestorStatus.state === "connected" ? "var(--text-muted)" : "var(--success)",
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: controlAction !== null || ingestorStatus.state === "connected" ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                      opacity: ingestorStatus.state === "connected" ? 0.5 : 1,
                    }}
                  >
                    {controlAction === "start" ? (
                      <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                    ) : (
                      <Play size={12} />
                    )}
                    Start
                  </button>
                  <button
                    onClick={() => handleControl("stop")}
                    disabled={controlAction !== null || ingestorStatus.state === "stopped"}
                    style={{
                      flex: 1,
                      padding: "7px 0",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background:
                        ingestorStatus.state === "stopped" ? "var(--bg-secondary)" : "color-mix(in srgb, var(--error) 10%, var(--bg))",
                      color: ingestorStatus.state === "stopped" ? "var(--text-muted)" : "var(--error)",
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: controlAction !== null || ingestorStatus.state === "stopped" ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                      opacity: ingestorStatus.state === "stopped" ? 0.5 : 1,
                    }}
                  >
                    {controlAction === "stop" ? (
                      <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                    ) : (
                      <Square size={12} />
                    )}
                    Stop
                  </button>
                  <button
                    onClick={() => handleControl("restart")}
                    disabled={controlAction !== null}
                    style={{
                      flex: 1,
                      padding: "7px 0",
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text)",
                      fontSize: 12,
                      fontWeight: 500,
                      cursor: controlAction !== null ? "wait" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 4,
                    }}
                  >
                    {controlAction === "restart" ? (
                      <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
                    ) : (
                      <RotateCw size={12} />
                    )}
                    Restart
                  </button>
                </div>

                {/* Control result */}
                {controlResult && (
                  <div
                    style={{
                      marginTop: 8,
                      padding: "6px 10px",
                      borderRadius: 6,
                      fontSize: 12,
                      background: controlResult.success
                        ? "color-mix(in srgb, var(--success) 10%, transparent)"
                        : "color-mix(in srgb, var(--error) 10%, transparent)",
                      color: controlResult.success ? "var(--success)" : "var(--error)",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {controlResult.success ? <Check size={12} /> : <AlertTriangle size={12} />}
                    {controlResult.message}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Config fields */}
          {!loading && config && config.fields.length > 0 && (
            <div>
              <h3
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: 12,
                }}
              >
                Configuration Schema
              </h3>

              {Object.entries(groupedFields).map(([group, fields]) => {
                const isExpanded = expandedGroups.has(group);
                const isDefault = group === "default";

                return (
                  <div key={group} style={{ marginBottom: 12 }}>
                    {!isDefault && (
                      <button
                        onClick={() => toggleGroup(group)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          background: "transparent",
                          color: "var(--text)",
                          fontSize: 13,
                          fontWeight: 500,
                          cursor: "pointer",
                          padding: "4px 0",
                          marginBottom: isExpanded ? 8 : 0,
                        }}
                      >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        {group}
                      </button>
                    )}

                    {(isDefault || isExpanded) && (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 12,
                        }}
                      >
                        {fields.map((field) => (
                          <FieldDisplay
                            key={field.key}
                            field={field}
                            dynamicOptions={dynamicOptions[field.key]}
                            loadingOptions={loadingOptions === field.key}
                            onFetchOptions={() => handleFetchDynamicOptions(field)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* No fields */}
          {!loading && config && config.fields.length === 0 && (
            <div
              style={{
                textAlign: "center",
                padding: "24px 0",
                color: "var(--text-muted)",
                fontSize: 13,
              }}
            >
              This listener has no configurable parameters.
            </div>
          )}

          {/* Metadata */}
          {!loading && config && (
            <div
              style={{
                marginTop: 16,
                padding: "10px 12px",
                borderRadius: 6,
                background: "var(--bg-secondary)",
                fontSize: 12,
                color: "var(--text-muted)",
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              {config.ingestorType && <span>Type: {config.ingestorType}</span>}
              <span>Multi-instance: {config.supportsMultiInstance ? "Yes" : "No"}</span>
              {config.instanceKeyField && <span>Instance key: {config.instanceKeyField}</span>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
            flexShrink: 0,
          }}
        >
          <button
            onClick={onClose}
            style={{
              padding: "8px 20px",
              borderRadius: 8,
              fontSize: 14,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            Close
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ── Field display component ──

function FieldDisplay({
  field,
  dynamicOptions,
  loadingOptions,
  onFetchOptions,
}: {
  field: ListenerConfigField;
  dynamicOptions?: ListenerConfigOption[];
  loadingOptions: boolean;
  onFetchOptions: () => void;
}) {
  const hasDynamic = !!field.dynamicOptions;
  const options = dynamicOptions || field.options || [];

  return (
    <div
      style={{
        background: "var(--bg)",
        borderRadius: 8,
        border: "1px solid var(--border)",
        padding: "12px 14px",
      }}
    >
      {/* Field header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: field.description ? 4 : 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              fontSize: 13,
              fontFamily: "monospace",
              fontWeight: 500,
              color: "var(--text)",
            }}
          >
            {field.label}
          </span>
          {field.required && (
            <span style={{ fontSize: 10, color: "var(--error)", fontWeight: 600 }}>Required</span>
          )}
          {field.instanceKey && (
            <span
              style={{
                fontSize: 10,
                padding: "1px 5px",
                borderRadius: 4,
                background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                color: "var(--accent)",
                fontWeight: 500,
              }}
            >
              Instance Key
            </span>
          )}
        </div>
        <span
          style={{
            fontSize: 11,
            padding: "2px 6px",
            borderRadius: 4,
            background: "var(--bg-secondary)",
            color: "var(--text-muted)",
            fontFamily: "monospace",
          }}
        >
          {field.type}
        </span>
      </div>

      {/* Description */}
      {field.description && (
        <p
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            lineHeight: 1.5,
            marginBottom: 8,
            display: "flex",
            alignItems: "flex-start",
            gap: 4,
          }}
        >
          <Info size={12} style={{ flexShrink: 0, marginTop: 2, opacity: 0.6 }} />
          {field.description}
        </p>
      )}

      {/* Default value */}
      {field.default !== undefined && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          Default:{" "}
          <code
            style={{
              fontFamily: "monospace",
              fontSize: 11,
              padding: "1px 4px",
              borderRadius: 3,
              background: "var(--bg-secondary)",
            }}
          >
            {JSON.stringify(field.default)}
          </code>
        </div>
      )}

      {/* Static/dynamic options */}
      {(field.type === "select" || field.type === "multiselect") && (
        <div style={{ marginTop: 6 }}>
          {options.length > 0 ? (
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {options.map((opt) => (
                <span
                  key={opt.value}
                  style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: "var(--bg-secondary)",
                    color: "var(--text)",
                    fontFamily: "monospace",
                  }}
                >
                  {opt.label}
                </span>
              ))}
            </div>
          ) : hasDynamic ? (
            <button
              onClick={onFetchOptions}
              disabled={loadingOptions}
              style={{
                fontSize: 12,
                color: "var(--accent)",
                background: "transparent",
                cursor: loadingOptions ? "wait" : "pointer",
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: 0,
              }}
            >
              {loadingOptions ? (
                <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} />
              ) : (
                <ChevronDown size={12} />
              )}
              Load options from API
            </button>
          ) : null}
        </div>
      )}

      {/* Validation hints */}
      {(field.min !== undefined || field.max !== undefined || field.pattern || field.placeholder) && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--text-muted)",
            display: "flex",
            gap: 10,
          }}
        >
          {field.min !== undefined && <span>Min: {field.min}</span>}
          {field.max !== undefined && <span>Max: {field.max}</span>}
          {field.pattern && <span>Pattern: {field.pattern}</span>}
          {field.placeholder && <span>Hint: {field.placeholder}</span>}
        </div>
      )}
    </div>
  );
}
