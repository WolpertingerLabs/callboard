/**
 * ListenerConfigPanel — Auto-renders listener configuration forms from field schemas.
 *
 * Fetches config schema via `list_listener_configs` and renders appropriate
 * controls for each field type. Dynamic options are fetched lazily via
 * `resolve_listener_options` when the user focuses a select field.
 *
 * When `supportsMultiInstance` is true, shows an instance management section
 * with CRUD operations for listener instances (local mode only) and
 * per-instance start/stop/restart controls.
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { X, Radio, Loader2, ChevronDown, ChevronRight, Info, Play, Square, RotateCw, Check, AlertTriangle, Zap, Plus, Trash2, Edit3 } from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import {
  getListenerConfigs,
  resolveListenerOptions,
  controlListener,
  getListenerInstances,
  createListenerInstance,
  deleteListenerInstanceApi,
  getListenerParams,
  setListenerParams,
  deleteListenerInstanceViaProxy,
} from "../api";
import type { ListenerConfigSchema, ListenerConfigField, ListenerConfigOption, IngestorStatus, LifecycleResult, ListenerInstanceInfo } from "../api";

interface ListenerConfigPanelProps {
  connectionAlias: string;
  connectionName: string;
  caller: string;
  ingestorStatus?: IngestorStatus;
  localModeActive?: boolean;
  onClose: () => void;
  onStatusChange?: () => void;
}

export default function ListenerConfigPanel({
  connectionAlias,
  connectionName,
  caller,
  ingestorStatus,
  localModeActive,
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

  // Multi-instance state
  const [instances, setInstances] = useState<ListenerInstanceInfo[]>([]);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [showNewInstanceForm, setShowNewInstanceForm] = useState(false);
  const [newInstanceId, setNewInstanceId] = useState("");
  const [newInstanceError, setNewInstanceError] = useState<string | null>(null);
  const [creatingInstance, setCreatingInstance] = useState(false);
  const [deletingInstance, setDeletingInstance] = useState<string | null>(null);
  const [instanceControlAction, setInstanceControlAction] = useState<Record<string, string>>({});

  // Editable form state
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [originalValues, setOriginalValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);
  const [editingInstanceId, setEditingInstanceId] = useState<string | null>(null);

  const isDirty = useMemo(() => {
    return Object.keys(formValues).some((key) => JSON.stringify(formValues[key]) !== JSON.stringify(originalValues[key]));
  }, [formValues, originalValues]);

  // ── Fetch config ──

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

  // ── Fetch instances (local mode, multi-instance only) ──

  const fetchInstances = useCallback(async () => {
    if (!localModeActive) return;
    setLoadingInstances(true);
    try {
      const data = await getListenerInstances(connectionAlias, caller);
      setInstances(data.instances);
    } catch {
      // silently fail — instance list is supplementary
    } finally {
      setLoadingInstances(false);
    }
  }, [connectionAlias, caller, localModeActive]);

  useEffect(() => {
    if (config?.supportsMultiInstance) {
      fetchInstances();
    }
  }, [config?.supportsMultiInstance, fetchInstances]);

  // ── Fetch params ──

  const fetchParams = useCallback(
    async (instanceId?: string) => {
      try {
        const data = await getListenerParams(connectionAlias, caller, instanceId);
        if (data.success) {
          const merged: Record<string, unknown> = { ...data.defaults, ...data.params };
          setFormValues(merged);
          setOriginalValues(merged);
          setSaveResult(null);
        }
      } catch {
        // Fall back to defaults only — params API might not be supported
      }
    },
    [connectionAlias, caller],
  );

  useEffect(() => {
    if (config) {
      if (config.supportsMultiInstance) {
        // For multi-instance, fetch params when editingInstanceId is set
        if (editingInstanceId) {
          fetchParams(editingInstanceId);
        }
      } else {
        fetchParams();
      }
    }
  }, [config, editingInstanceId, fetchParams]);

  // ── Listener control handlers ──

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

  // ── Instance CRUD handlers ──

  const handleCreateInstance = async () => {
    const id = newInstanceId.trim();
    if (!id) return;
    setCreatingInstance(true);
    setNewInstanceError(null);
    try {
      await createListenerInstance(connectionAlias, id, {}, caller);
      setNewInstanceId("");
      setShowNewInstanceForm(false);
      await fetchInstances();
      onStatusChange?.();
    } catch (err: any) {
      setNewInstanceError(err.message || "Failed to create instance");
    } finally {
      setCreatingInstance(false);
    }
  };

  const handleDeleteInstance = async (instanceId: string) => {
    setDeletingInstance(instanceId);
    try {
      // Use proxy tool (works in both local and remote mode)
      const result = await deleteListenerInstanceViaProxy(connectionAlias, instanceId, caller);
      if (!result.success) throw new Error(result.error);
      if (editingInstanceId === instanceId) {
        setEditingInstanceId(null);
        setFormValues({});
        setOriginalValues({});
      }
      await fetchInstances();
      onStatusChange?.();
    } catch {
      // Fallback to direct API for local mode if proxy tool not available
      try {
        await deleteListenerInstanceApi(connectionAlias, instanceId, caller);
        if (editingInstanceId === instanceId) {
          setEditingInstanceId(null);
          setFormValues({});
          setOriginalValues({});
        }
        await fetchInstances();
        onStatusChange?.();
      } catch {
        // silently fail
      }
    } finally {
      setDeletingInstance(null);
    }
  };

  const handleInstanceControl = async (instanceId: string, action: "start" | "stop" | "restart") => {
    setInstanceControlAction((prev) => ({ ...prev, [instanceId]: action }));
    try {
      await controlListener(connectionAlias, action, caller, instanceId);
      onStatusChange?.();
    } catch {
      // silently fail
    } finally {
      setInstanceControlAction((prev) => {
        const next = { ...prev };
        delete next[instanceId];
        return next;
      });
    }
  };

  // ── Dynamic options ──

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

  const handleSave = async () => {
    const changedParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(formValues)) {
      if (JSON.stringify(value) !== JSON.stringify(originalValues[key])) {
        changedParams[key] = value;
      }
    }
    if (Object.keys(changedParams).length === 0) return;

    setSaving(true);
    setSaveResult(null);
    try {
      const result = await setListenerParams(connectionAlias, changedParams, caller, editingInstanceId ?? undefined);
      if (result.success) {
        const merged = { ...formValues };
        setOriginalValues(merged);
        setSaveResult({ success: true, message: "Parameters saved successfully" });
        onStatusChange?.();
      } else {
        setSaveResult({ success: false, message: result.error || "Failed to save" });
      }
    } catch (err: any) {
      setSaveResult({ success: false, message: err.message || "Failed to save parameters" });
    } finally {
      setSaving(false);
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

  const isMultiInstance = config?.supportsMultiInstance ?? false;

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

          {/* Ingestor Status + Controls (single-instance only) */}
          {ingestorStatus && !isMultiInstance && (
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
                  {ingestorStatus.lastEventAt && <span>Last: {new Date(ingestorStatus.lastEventAt).toLocaleTimeString()}</span>}
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
                      background: ingestorStatus.state === "connected" ? "var(--bg-secondary)" : "color-mix(in srgb, var(--success) 10%, var(--bg))",
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
                    {controlAction === "start" ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={12} />}
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
                      background: ingestorStatus.state === "stopped" ? "var(--bg-secondary)" : "color-mix(in srgb, var(--error) 10%, var(--bg))",
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
                    {controlAction === "stop" ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Square size={12} />}
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
                    {controlAction === "restart" ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <RotateCw size={12} />}
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

          {/* ── Multi-instance management section ── */}
          {!loading && config && isMultiInstance && (
            <div style={{ marginBottom: 20 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 12,
                }}
              >
                <h3
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text-muted)",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                  }}
                >
                  Listener Instances
                </h3>

                {/* Bulk controls */}
                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    onClick={() => handleControl("start")}
                    disabled={controlAction !== null}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 5,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--success)",
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: controlAction !== null ? "wait" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                    }}
                    title="Start all instances"
                  >
                    {controlAction === "start" ? <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={10} />}
                    All
                  </button>
                  <button
                    onClick={() => handleControl("stop")}
                    disabled={controlAction !== null}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 5,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--error)",
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: controlAction !== null ? "wait" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                    }}
                    title="Stop all instances"
                  >
                    {controlAction === "stop" ? <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} /> : <Square size={10} />}
                    All
                  </button>
                  <button
                    onClick={() => handleControl("restart")}
                    disabled={controlAction !== null}
                    style={{
                      padding: "3px 8px",
                      borderRadius: 5,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text-muted)",
                      fontSize: 11,
                      fontWeight: 500,
                      cursor: controlAction !== null ? "wait" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 3,
                    }}
                    title="Restart all instances"
                  >
                    {controlAction === "restart" ? <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} /> : <RotateCw size={10} />}
                    All
                  </button>
                </div>
              </div>

              {/* Bulk control result */}
              {controlResult && (
                <div
                  style={{
                    marginBottom: 10,
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

              {/* Loading instances */}
              {loadingInstances && (
                <div
                  style={{
                    textAlign: "center",
                    padding: "16px 0",
                    color: "var(--text-muted)",
                    fontSize: 12,
                  }}
                >
                  <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                </div>
              )}

              {/* Instance list */}
              {!loadingInstances && instances.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {instances.map((instance) => {
                    const iAction = instanceControlAction[instance.instanceId];
                    const isDeleting = deletingInstance === instance.instanceId;

                    return (
                      <div
                        key={instance.instanceId}
                        style={{
                          background: "var(--bg)",
                          borderRadius: 8,
                          border: "1px solid var(--border)",
                          padding: "10px 14px",
                          opacity: instance.disabled ? 0.6 : 1,
                        }}
                      >
                        {/* Instance header */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            marginBottom: 8,
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                            <span
                              style={{
                                fontSize: 13,
                                fontWeight: 500,
                                fontFamily: "monospace",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {instance.instanceId}
                            </span>
                            {instance.disabled && (
                              <span
                                style={{
                                  fontSize: 10,
                                  padding: "1px 5px",
                                  borderRadius: 4,
                                  background: "var(--bg-secondary)",
                                  color: "var(--text-muted)",
                                  fontWeight: 500,
                                }}
                              >
                                Disabled
                              </span>
                            )}
                          </div>

                          {/* Edit + Delete buttons */}
                          <div style={{ display: "flex", gap: 4 }}>
                            <button
                              onClick={() => setEditingInstanceId(editingInstanceId === instance.instanceId ? null : instance.instanceId)}
                              style={{
                                background: "transparent",
                                padding: 4,
                                borderRadius: 4,
                                color: editingInstanceId === instance.instanceId ? "var(--accent)" : "var(--text-muted)",
                                cursor: "pointer",
                                flexShrink: 0,
                                opacity: editingInstanceId === instance.instanceId ? 1 : 0.6,
                                transition: "opacity 0.15s, color 0.15s",
                              }}
                              title={editingInstanceId === instance.instanceId ? "Close editor" : `Edit parameters for "${instance.instanceId}"`}
                            >
                              <Edit3 size={12} />
                            </button>
                            <button
                              onClick={() => handleDeleteInstance(instance.instanceId)}
                              disabled={isDeleting}
                              style={{
                                background: "transparent",
                                padding: 4,
                                borderRadius: 4,
                                color: "var(--text-muted)",
                                cursor: isDeleting ? "wait" : "pointer",
                                flexShrink: 0,
                                opacity: 0.6,
                                transition: "opacity 0.15s, color 0.15s",
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.opacity = "1";
                                e.currentTarget.style.color = "var(--error)";
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.opacity = "0.6";
                                e.currentTarget.style.color = "var(--text-muted)";
                              }}
                              title={`Delete instance "${instance.instanceId}"`}
                            >
                              {isDeleting ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : <Trash2 size={12} />}
                            </button>
                          </div>
                        </div>

                        {/* Instance params (if any) */}
                        {instance.params && Object.keys(instance.params).length > 0 && (
                          <div
                            style={{
                              display: "flex",
                              gap: 6,
                              flexWrap: "wrap",
                              marginBottom: 8,
                              fontSize: 11,
                            }}
                          >
                            {Object.entries(instance.params).map(([key, value]) => (
                              <span
                                key={key}
                                style={{
                                  padding: "2px 6px",
                                  borderRadius: 4,
                                  background: "var(--bg-secondary)",
                                  color: "var(--text-muted)",
                                  fontFamily: "monospace",
                                }}
                              >
                                {key}: {String(value)}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Per-instance control buttons */}
                        <div style={{ display: "flex", gap: 4 }}>
                          <button
                            onClick={() => handleInstanceControl(instance.instanceId, "start")}
                            disabled={!!iAction}
                            style={{
                              padding: "4px 10px",
                              borderRadius: 5,
                              border: "1px solid var(--border)",
                              background: "color-mix(in srgb, var(--success) 8%, var(--bg))",
                              color: "var(--success)",
                              fontSize: 11,
                              fontWeight: 500,
                              cursor: iAction ? "wait" : "pointer",
                              display: "flex",
                              alignItems: "center",
                              gap: 3,
                            }}
                            title="Start this instance"
                          >
                            {iAction === "start" ? <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} /> : <Play size={10} />}
                            Start
                          </button>
                          <button
                            onClick={() => handleInstanceControl(instance.instanceId, "stop")}
                            disabled={!!iAction}
                            style={{
                              padding: "4px 10px",
                              borderRadius: 5,
                              border: "1px solid var(--border)",
                              background: "color-mix(in srgb, var(--error) 8%, var(--bg))",
                              color: "var(--error)",
                              fontSize: 11,
                              fontWeight: 500,
                              cursor: iAction ? "wait" : "pointer",
                              display: "flex",
                              alignItems: "center",
                              gap: 3,
                            }}
                            title="Stop this instance"
                          >
                            {iAction === "stop" ? <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} /> : <Square size={10} />}
                            Stop
                          </button>
                          <button
                            onClick={() => handleInstanceControl(instance.instanceId, "restart")}
                            disabled={!!iAction}
                            style={{
                              padding: "4px 10px",
                              borderRadius: 5,
                              border: "1px solid var(--border)",
                              background: "var(--bg)",
                              color: "var(--text-muted)",
                              fontSize: 11,
                              fontWeight: 500,
                              cursor: iAction ? "wait" : "pointer",
                              display: "flex",
                              alignItems: "center",
                              gap: 3,
                            }}
                            title="Restart this instance"
                          >
                            {iAction === "restart" ? <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} /> : <RotateCw size={10} />}
                            Restart
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* No instances message */}
              {!loadingInstances && instances.length === 0 && localModeActive && (
                <div
                  style={{
                    textAlign: "center",
                    padding: "16px 12px",
                    color: "var(--text-muted)",
                    fontSize: 12,
                    background: "var(--bg)",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                  }}
                >
                  No listener instances configured.
                  <br />
                  <span style={{ fontSize: 11, opacity: 0.8 }}>Create an instance to start listening for events.</span>
                </div>
              )}

              {/* Add instance form / button (local mode only) */}
              {localModeActive && (
                <div style={{ marginTop: 10 }}>
                  {showNewInstanceForm ? (
                    <div
                      style={{
                        background: "var(--bg)",
                        borderRadius: 8,
                        border: "1px solid var(--border)",
                        padding: "10px 14px",
                      }}
                    >
                      <label
                        style={{
                          fontSize: 12,
                          fontWeight: 500,
                          color: "var(--text-muted)",
                          display: "block",
                          marginBottom: 6,
                        }}
                      >
                        {config?.instanceKeyField ? `Instance ID (${config.instanceKeyField})` : "Instance ID"}
                      </label>
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input
                          type="text"
                          placeholder="e.g. my-instance-1"
                          value={newInstanceId}
                          onChange={(e) => {
                            setNewInstanceId(e.target.value);
                            setNewInstanceError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleCreateInstance();
                            if (e.key === "Escape") {
                              setShowNewInstanceForm(false);
                              setNewInstanceId("");
                              setNewInstanceError(null);
                            }
                          }}
                          autoFocus
                          style={{
                            flex: 1,
                            padding: "6px 8px",
                            borderRadius: 6,
                            border: `1px solid ${newInstanceError ? "var(--error)" : "var(--border)"}`,
                            background: "var(--surface)",
                            color: "var(--text)",
                            fontSize: 12,
                            fontFamily: "monospace",
                            outline: "none",
                            minWidth: 0,
                          }}
                        />
                        <button
                          onClick={handleCreateInstance}
                          disabled={creatingInstance || !newInstanceId.trim()}
                          style={{
                            padding: "5px 12px",
                            borderRadius: 6,
                            background: "var(--accent)",
                            color: "#fff",
                            fontSize: 12,
                            fontWeight: 500,
                            cursor: creatingInstance || !newInstanceId.trim() ? "not-allowed" : "pointer",
                            flexShrink: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            opacity: creatingInstance || !newInstanceId.trim() ? 0.6 : 1,
                          }}
                        >
                          {creatingInstance && <Loader2 size={10} style={{ animation: "spin 1s linear infinite" }} />}
                          Create
                        </button>
                        <button
                          onClick={() => {
                            setShowNewInstanceForm(false);
                            setNewInstanceId("");
                            setNewInstanceError(null);
                          }}
                          style={{
                            padding: "5px 10px",
                            borderRadius: 6,
                            border: "1px solid var(--border)",
                            background: "var(--bg-secondary)",
                            color: "var(--text-muted)",
                            fontSize: 12,
                            cursor: "pointer",
                            flexShrink: 0,
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                      {newInstanceError && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--error)",
                            marginTop: 6,
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <AlertTriangle size={10} />
                          {newInstanceError}
                        </div>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowNewInstanceForm(true)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "8px 12px",
                        borderRadius: 8,
                        border: "1px dashed var(--border)",
                        background: "transparent",
                        color: "var(--accent)",
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: "pointer",
                        width: "100%",
                        transition: "background 0.15s",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 6%, transparent)")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                    >
                      <Plus size={14} />
                      Add Instance
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Config fields */}
          {(!isMultiInstance || editingInstanceId) && !loading && config && config.fields.length > 0 && (
            <div>
              {editingInstanceId && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: "6px 10px",
                    borderRadius: 6,
                    background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                    color: "var(--accent)",
                    fontSize: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <Edit3 size={12} />
                  Editing instance: <code style={{ fontFamily: "monospace", fontWeight: 600 }}>{editingInstanceId}</code>
                  <button
                    onClick={() => {
                      setEditingInstanceId(null);
                      setFormValues({});
                      setOriginalValues({});
                      setSaveResult(null);
                    }}
                    style={{
                      marginLeft: "auto",
                      background: "transparent",
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      fontSize: 11,
                      padding: "2px 6px",
                      borderRadius: 4,
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}

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
                Configuration
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
                            value={formValues[field.key]}
                            onChange={(val) => setFormValues((prev) => ({ ...prev, [field.key]: val }))}
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
          {!loading && config && config.fields.length === 0 && !isMultiInstance && (
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
              {isMultiInstance && instances.length > 0 && <span>Instances: {instances.length}</span>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {isDirty && (
              <span style={{ fontSize: 12, color: "var(--warning)", display: "flex", alignItems: "center", gap: 4 }}>
                <AlertTriangle size={12} />
                Unsaved changes
              </span>
            )}
            {saveResult && (
              <span style={{ fontSize: 12, color: saveResult.success ? "var(--success)" : "var(--error)", display: "flex", alignItems: "center", gap: 4 }}>
                {saveResult.success ? <Check size={12} /> : <AlertTriangle size={12} />}
                {saveResult.message}
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
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
            {config?.fields && config.fields.length > 0 && (
              <button
                onClick={handleSave}
                disabled={!isDirty || saving}
                style={{
                  padding: "8px 20px",
                  borderRadius: 8,
                  fontSize: 14,
                  background: isDirty ? "var(--accent)" : "var(--bg-secondary)",
                  border: "none",
                  color: isDirty ? "#fff" : "var(--text-muted)",
                  cursor: !isDirty || saving ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  opacity: !isDirty ? 0.5 : 1,
                }}
              >
                {saving && <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />}
                Save
              </button>
            )}
          </div>
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
  value,
  onChange,
}: {
  field: ListenerConfigField;
  dynamicOptions?: ListenerConfigOption[];
  loadingOptions: boolean;
  onFetchOptions: () => void;
  value?: unknown;
  onChange?: (value: unknown) => void;
}) {
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
          {field.required && <span style={{ fontSize: 10, color: "var(--error)", fontWeight: 600 }}>Required</span>}
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

      {/* Editable control */}
      <div style={{ marginTop: 8 }}>
        {field.type === "text" && (
          <input
            type="text"
            value={(value as string) ?? ""}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={field.placeholder || `Enter ${field.label.toLowerCase()}`}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "monospace",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        )}
        {field.type === "number" && (
          <input
            type="number"
            value={(value as number) ?? ""}
            onChange={(e) => onChange?.(e.target.value === "" ? undefined : Number(e.target.value))}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "monospace",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        )}
        {field.type === "boolean" && (
          <button
            onClick={() => onChange?.(!(value ?? field.default ?? false))}
            style={{
              width: 40,
              height: 22,
              borderRadius: 11,
              border: "none",
              background: (value ?? field.default) ? "var(--accent)" : "var(--bg-secondary)",
              cursor: "pointer",
              position: "relative",
              transition: "background 0.2s",
            }}
          >
            <div
              style={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "#fff",
                position: "absolute",
                top: 3,
                left: (value ?? field.default) ? 21 : 3,
                transition: "left 0.2s",
              }}
            />
          </button>
        )}
        {field.type === "select" && (
          <select
            value={(value as string) ?? (field.default as string) ?? ""}
            onChange={(e) => onChange?.(e.target.value || undefined)}
            onFocus={() => {
              if (field.dynamicOptions && !dynamicOptions) onFetchOptions();
            }}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 12,
              outline: "none",
              boxSizing: "border-box",
            }}
          >
            <option value="">-- Select --</option>
            {loadingOptions && <option disabled>Loading options...</option>}
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        )}
        {field.type === "multiselect" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {loadingOptions && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Loading options...</span>}
            {!loadingOptions && options.length === 0 && field.dynamicOptions && (
              <button
                onClick={onFetchOptions}
                style={{
                  fontSize: 12,
                  color: "var(--accent)",
                  background: "transparent",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  padding: 0,
                }}
              >
                Load options from API
              </button>
            )}
            {options.map((opt) => {
              const selected = Array.isArray(value) ? (value as string[]).includes(opt.value) : false;
              return (
                <label key={opt.value} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) => {
                      const current = Array.isArray(value) ? [...(value as string[])] : [];
                      onChange?.(e.target.checked ? [...current, opt.value] : current.filter((v) => v !== opt.value));
                    }}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
        )}
        {field.type === "secret" && (
          <input
            type="password"
            value={(value as string) ?? ""}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={field.placeholder || "Enter secret value"}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "monospace",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        )}
        {field.type === "text[]" && (
          <input
            type="text"
            value={Array.isArray(value) ? (value as string[]).join(", ") : ((value as string) ?? "")}
            onChange={(e) => {
              const items = e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              onChange?.(items.length > 0 ? items : undefined);
            }}
            placeholder={field.placeholder || "Comma-separated values"}
            style={{
              width: "100%",
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 12,
              fontFamily: "monospace",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
        )}
      </div>

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
