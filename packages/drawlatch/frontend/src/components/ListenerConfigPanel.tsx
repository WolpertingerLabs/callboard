/**
 * ListenerConfigPanel — drawlatch listener configuration modal.
 *
 * Auto-renders listener configuration forms from field schemas fetched via
 * `api.listenerConfigs`. Renders the appropriate control per field type, and
 * fetches dynamic select/multiselect options lazily via
 * `api.resolveListenerOptions` on focus.
 *
 * Single-instance listeners get a live status card plus start/stop/restart
 * controls and a params form. Multi-instance listeners (when
 * `supportsMultiInstance`) get full instance CRUD plus per-instance and bulk
 * lifecycle controls.
 *
 * drawlatch live-reloads on every change, so there is no local/remote split
 * and no "needs restart" banner — every mutation calls `onChanged` so the
 * parent refetches.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  Pencil,
  Play,
  Plus,
  Radio,
  RotateCw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { api, isDaemonDown } from "../api";
import type {
  ListenerConfigEntry,
  ListenerField,
  ListenerInstancesResult,
  ListenerParamsResult,
  ResolveOptionsResult,
} from "../api";
import type { AdminIngestor } from "drawlatch-admin-types";
import ConfirmDialog from "./ConfirmDialog";
import "./ListenerConfigPanel.css";

interface ListenerConfigPanelProps {
  caller: string;
  connection: string;
  connectionName: string;
  supportsMultiInstance: boolean;
  onClose: () => void;
  onChanged: () => void;
}

type IngestorState = AdminIngestor["state"];
type InstanceInfo = ListenerInstancesResult["instances"][number];
type FieldOption = { value: string | number | boolean; label: string; description?: string };
type FormValues = Record<string, unknown>;

const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const DEFAULT_GROUP = "__default__";

function stateClass(state: IngestorState): string {
  switch (state) {
    case "connected":
      return "dl-lcp-dot-connected";
    case "error":
      return "dl-lcp-dot-error";
    case "starting":
    case "reconnecting":
      return "dl-lcp-dot-starting";
    case "stopped":
    default:
      return "dl-lcp-dot-stopped";
  }
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString();
}

/** Deep-ish equality good enough for primitive / array param values. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function ListenerConfigPanel({
  caller,
  connection,
  connectionName,
  supportsMultiInstance,
  onClose,
  onChanged,
}: ListenerConfigPanelProps) {
  const [config, setConfig] = useState<ListenerConfigEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [ingestors, setIngestors] = useState<AdminIngestor[]>([]);

  // Lifecycle control state
  const [controlBusy, setControlBusy] = useState<string | null>(null);
  const [controlResult, setControlResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Per-instance control / delete state
  const [instanceBusy, setInstanceBusy] = useState<Record<string, string>>({});
  const [deletingInstance, setDeletingInstance] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Multi-instance list
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [loadingInstances, setLoadingInstances] = useState(false);

  // Create-instance form
  const [showCreate, setShowCreate] = useState(false);
  const [newInstanceId, setNewInstanceId] = useState("");
  const [newInstanceError, setNewInstanceError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Params form (single-instance, or editing a multi-instance)
  const [editingInstanceId, setEditingInstanceId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<FormValues>({});
  const [originalValues, setOriginalValues] = useState<FormValues>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Dynamic options cache: fieldKey → options[]
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, FieldOption[]>>({});
  const [loadingOptions, setLoadingOptions] = useState<string | null>(null);

  // Collapsible field groups (collapsed set; default group always open)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const isMulti = config?.supportsMultiInstance ?? supportsMultiInstance;

  const isDirty = useMemo(
    () => Object.keys(formValues).some((k) => !sameValue(formValues[k], originalValues[k])),
    [formValues, originalValues],
  );

  // ── Escape to close ─────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ── Fetch config ────────────────────────────────────────────────────────
  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await api.listenerConfigs(caller);
    if (isDaemonDown(res)) {
      setOffline(true);
      setLoading(false);
      return;
    }
    setOffline(false);
    const match = res.find((c) => c.connection === connection) ?? null;
    setConfig(match);
    if (!match) setLoadError("No listener configuration found for this connection.");
    setLoading(false);
  }, [caller, connection]);

  useEffect(() => {
    void fetchConfig();
  }, [fetchConfig]);

  // ── Poll ingestor statuses (~5s) ────────────────────────────────────────
  const fetchIngestors = useCallback(async () => {
    const res = await api.callerIngestors(caller);
    if (isDaemonDown(res)) {
      setOffline(true);
      return;
    }
    setOffline(false);
    setIngestors(res.filter((i) => i.connection === connection));
  }, [caller, connection]);

  useEffect(() => {
    void fetchIngestors();
    const id = window.setInterval(() => void fetchIngestors(), 5000);
    return () => window.clearInterval(id);
  }, [fetchIngestors]);

  // ── Fetch instances (multi-instance) ────────────────────────────────────
  const fetchInstances = useCallback(async () => {
    setLoadingInstances(true);
    const res = await api.listListenerInstances(caller, connection);
    setLoadingInstances(false);
    if (isDaemonDown(res)) {
      setOffline(true);
      return;
    }
    setOffline(false);
    setInstances(res.instances);
  }, [caller, connection]);

  useEffect(() => {
    if (config && isMulti) void fetchInstances();
  }, [config, isMulti, fetchInstances]);

  // ── Fetch params ────────────────────────────────────────────────────────
  const fetchParams = useCallback(
    async (instanceId?: string) => {
      const res = await api.getListenerParams(caller, connection, instanceId);
      if (isDaemonDown(res)) {
        setOffline(true);
        return;
      }
      setOffline(false);
      const result: ListenerParamsResult = res;
      const merged: FormValues = { ...result.defaults, ...result.params };
      setFormValues(merged);
      setOriginalValues(merged);
      setSaveResult(null);
    },
    [caller, connection],
  );

  useEffect(() => {
    if (!config) return;
    if (isMulti) {
      if (editingInstanceId) void fetchParams(editingInstanceId);
    } else {
      void fetchParams();
    }
  }, [config, isMulti, editingInstanceId, fetchParams]);

  // ── Lifecycle control (whole listener / bulk / single-instance) ─────────
  const runControl = useCallback(
    async (action: "start" | "stop" | "restart", instanceId?: string) => {
      const busyKey = instanceId ? `${instanceId}:${action}` : action;
      if (instanceId) {
        setInstanceBusy((prev) => ({ ...prev, [instanceId]: action }));
      } else {
        setControlBusy(action);
        setControlResult(null);
      }
      const res = await api.controlListener(caller, connection, action, instanceId);
      if (instanceId) {
        setInstanceBusy((prev) => {
          const next = { ...prev };
          delete next[instanceId];
          return next;
        });
      } else {
        setControlBusy(null);
        setControlResult(
          res.ok
            ? { ok: true, message: `Listener ${action} ok` }
            : { ok: false, message: res.error },
        );
      }
      if (res.ok) {
        onChanged();
        void fetchIngestors();
        if (isMulti) void fetchInstances();
      }
      return busyKey;
    },
    [caller, connection, onChanged, fetchIngestors, fetchInstances, isMulti],
  );

  // ── Dynamic options ─────────────────────────────────────────────────────
  const fetchDynamicOptions = useCallback(
    async (field: ListenerField) => {
      if (!field.dynamicOptions || dynamicOptions[field.key] || loadingOptions === field.key) return;
      setLoadingOptions(field.key);
      const res = await api.resolveListenerOptions(caller, connection, field.key);
      setLoadingOptions(null);
      if (res.ok) {
        const data: ResolveOptionsResult = res.data;
        if (data.options) {
          setDynamicOptions((prev) => ({ ...prev, [field.key]: data.options ?? [] }));
        }
      }
    },
    [caller, connection, dynamicOptions, loadingOptions],
  );

  // ── Save params (only changed) ──────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const changed: FormValues = {};
    for (const [key, value] of Object.entries(formValues)) {
      if (!sameValue(value, originalValues[key])) changed[key] = value;
    }
    if (Object.keys(changed).length === 0) return;
    setSaving(true);
    setSaveResult(null);
    const res = await api.setListenerParams(caller, connection, changed, {
      instanceId: editingInstanceId ?? undefined,
    });
    setSaving(false);
    if (res.ok) {
      setOriginalValues({ ...formValues });
      setSaveResult({ ok: true, message: "Parameters saved" });
      onChanged();
      void fetchIngestors();
      if (isMulti) void fetchInstances();
    } else {
      setSaveResult({ ok: false, message: res.error });
    }
  }, [
    formValues,
    originalValues,
    caller,
    connection,
    editingInstanceId,
    onChanged,
    fetchIngestors,
    fetchInstances,
    isMulti,
  ]);

  // ── Create instance ─────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    const id = newInstanceId.trim();
    if (!id) {
      setNewInstanceError("Instance ID is required.");
      return;
    }
    if (!INSTANCE_ID_PATTERN.test(id)) {
      setNewInstanceError("Must start with a letter/number and contain only letters, numbers, _ or -.");
      return;
    }
    if (instances.some((i) => i.instanceId === id)) {
      setNewInstanceError("An instance with that ID already exists.");
      return;
    }
    setCreating(true);
    setNewInstanceError(null);
    const res = await api.createListenerInstance(caller, connection, id, {});
    setCreating(false);
    if (res.ok) {
      setNewInstanceId("");
      setShowCreate(false);
      onChanged();
      void fetchInstances();
      void fetchIngestors();
    } else {
      setNewInstanceError(res.error);
    }
  }, [newInstanceId, instances, caller, connection, onChanged, fetchInstances, fetchIngestors]);

  // ── Delete instance ─────────────────────────────────────────────────────
  const handleDelete = useCallback(
    async (instanceId: string) => {
      setDeletingInstance(instanceId);
      const res = await api.deleteListenerInstance(caller, connection, instanceId);
      setDeletingInstance(null);
      setConfirmDelete(null);
      if (res.ok) {
        if (editingInstanceId === instanceId) {
          setEditingInstanceId(null);
          setFormValues({});
          setOriginalValues({});
        }
        onChanged();
        void fetchInstances();
        void fetchIngestors();
      }
    },
    [caller, connection, editingInstanceId, onChanged, fetchInstances, fetchIngestors],
  );

  // ── Grouped fields ──────────────────────────────────────────────────────
  const groupedFields = useMemo(() => {
    const groups: { group: string; fields: ListenerField[] }[] = [];
    const index = new Map<string, ListenerField[]>();
    for (const field of config?.fields ?? []) {
      const g = field.group ?? DEFAULT_GROUP;
      let bucket = index.get(g);
      if (!bucket) {
        bucket = [];
        index.set(g, bucket);
        groups.push({ group: g, fields: bucket });
      }
      bucket.push(field);
    }
    return groups;
  }, [config]);

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  // Single-instance status (first matching ingestor with no instanceId, else any)
  const singleStatus = useMemo(
    () => ingestors.find((i) => !i.instanceId) ?? ingestors[0],
    [ingestors],
  );

  const statusFor = useCallback(
    (instanceId: string): AdminIngestor | undefined =>
      ingestors.find((i) => i.instanceId === instanceId),
    [ingestors],
  );

  const overlayRef = useRef<HTMLDivElement>(null);

  const showParamsForm =
    config !== null &&
    config.fields.length > 0 &&
    (!isMulti || editingInstanceId !== null);

  return (
    <div
      className="dl-lcp-overlay"
      ref={overlayRef}
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div className="dl-lcp-panel" role="dialog" aria-modal="true">
        {/* ── Header ── */}
        <div className="dl-lcp-header">
          <div className="dl-lcp-header-text">
            <h2 className="dl-lcp-title">
              <Radio size={16} className="dl-lcp-title-icon" />
              {connectionName} Listener
            </h2>
            {config && (
              <p className="dl-lcp-subtitle">{config.description ?? config.name}</p>
            )}
          </div>
          <button className="dl-lcp-close" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="dl-lcp-body">
          {offline && (
            <div className="banner banner-offline dl-lcp-banner">
              <AlertTriangle size={16} />
              <span>Daemon is offline. Showing last known data; actions are unavailable.</span>
            </div>
          )}

          {loading && (
            <div className="dl-lcp-state">
              <Loader2 size={18} className="dl-lcp-spin" />
              <span>Loading listener configuration…</span>
            </div>
          )}

          {!loading && loadError && !config && (
            <div className="dl-lcp-state">{loadError}</div>
          )}

          {/* ── Single-instance status card ── */}
          {!loading && config && !isMulti && (
            <section className="dl-lcp-section">
              <h3 className="dl-lcp-section-title">Listener Status</h3>
              <div className="dl-lcp-card">
                <div className="dl-lcp-status-row">
                  <div className="dl-lcp-status-state">
                    <span
                      className={`status-dot dl-lcp-dot ${stateClass(singleStatus?.state ?? "stopped")}`}
                    />
                    <span className="dl-lcp-state-label">{singleStatus?.state ?? "stopped"}</span>
                    {singleStatus && <span className="tag dl-lcp-type-tag">{singleStatus.type}</span>}
                  </div>
                </div>

                <div className="dl-lcp-stats">
                  <span>Events: {singleStatus?.totalEventsReceived ?? 0}</span>
                  <span>Buffered: {singleStatus?.bufferedEvents ?? 0}</span>
                  <span>Last: {formatTime(singleStatus?.lastEventAt ?? null)}</span>
                </div>

                {singleStatus?.error && (
                  <div className="dl-lcp-error-box">
                    <AlertTriangle size={12} />
                    <span>{singleStatus.error}</span>
                  </div>
                )}

                <div className="dl-lcp-controls">
                  <button
                    className="dl-lcp-ctrl dl-lcp-ctrl-start"
                    disabled={!!controlBusy || offline}
                    onClick={() => void runControl("start")}
                  >
                    {controlBusy === "start" ? <Loader2 size={12} className="dl-lcp-spin" /> : <Play size={12} />}
                    Start
                  </button>
                  <button
                    className="dl-lcp-ctrl dl-lcp-ctrl-stop"
                    disabled={!!controlBusy || offline}
                    onClick={() => void runControl("stop")}
                  >
                    {controlBusy === "stop" ? <Loader2 size={12} className="dl-lcp-spin" /> : <Square size={12} />}
                    Stop
                  </button>
                  <button
                    className="dl-lcp-ctrl"
                    disabled={!!controlBusy || offline}
                    onClick={() => void runControl("restart")}
                  >
                    {controlBusy === "restart" ? <Loader2 size={12} className="dl-lcp-spin" /> : <RotateCw size={12} />}
                    Restart
                  </button>
                </div>

                {controlResult && (
                  <div className={`dl-lcp-inline-result ${controlResult.ok ? "is-ok" : "is-err"}`}>
                    {controlResult.ok ? <Check size={12} /> : <AlertTriangle size={12} />}
                    {controlResult.message}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ── Multi-instance management ── */}
          {!loading && config && isMulti && (
            <section className="dl-lcp-section">
              <div className="dl-lcp-section-head">
                <h3 className="dl-lcp-section-title">Listener Instances</h3>
                <div className="dl-lcp-bulk">
                  <button
                    className="dl-lcp-bulk-btn dl-lcp-ctrl-start dl-tap-compact"
                    disabled={!!controlBusy || offline}
                    title="Start all instances"
                    onClick={() => void runControl("start")}
                  >
                    {controlBusy === "start" ? <Loader2 size={10} className="dl-lcp-spin" /> : <Play size={10} />}
                    All
                  </button>
                  <button
                    className="dl-lcp-bulk-btn dl-lcp-ctrl-stop dl-tap-compact"
                    disabled={!!controlBusy || offline}
                    title="Stop all instances"
                    onClick={() => void runControl("stop")}
                  >
                    {controlBusy === "stop" ? <Loader2 size={10} className="dl-lcp-spin" /> : <Square size={10} />}
                    All
                  </button>
                  <button
                    className="dl-lcp-bulk-btn dl-tap-compact"
                    disabled={!!controlBusy || offline}
                    title="Restart all instances"
                    onClick={() => void runControl("restart")}
                  >
                    {controlBusy === "restart" ? <Loader2 size={10} className="dl-lcp-spin" /> : <RotateCw size={10} />}
                    All
                  </button>
                </div>
              </div>

              {controlResult && (
                <div className={`dl-lcp-inline-result ${controlResult.ok ? "is-ok" : "is-err"}`}>
                  {controlResult.ok ? <Check size={12} /> : <AlertTriangle size={12} />}
                  {controlResult.message}
                </div>
              )}

              {loadingInstances && (
                <div className="dl-lcp-state dl-lcp-state-sm">
                  <Loader2 size={14} className="dl-lcp-spin" />
                </div>
              )}

              {!loadingInstances && instances.length === 0 && (
                <div className="dl-lcp-empty">
                  No listener instances configured.
                  <span className="dl-lcp-empty-hint">Create an instance to start listening for events.</span>
                </div>
              )}

              {!loadingInstances && instances.length > 0 && (
                <div className="dl-lcp-instance-list">
                  {instances.map((instance) => {
                    const st = statusFor(instance.instanceId);
                    const busy = instanceBusy[instance.instanceId];
                    const isDeleting = deletingInstance === instance.instanceId;
                    const isEditing = editingInstanceId === instance.instanceId;
                    return (
                      <div
                        key={instance.instanceId}
                        className={`dl-lcp-instance ${instance.disabled ? "is-disabled" : ""}`}
                      >
                        <div className="dl-lcp-instance-head">
                          <div className="dl-lcp-instance-id-wrap">
                            <span
                              className={`status-dot dl-lcp-dot ${stateClass(st?.state ?? "stopped")}`}
                              title={st?.state ?? "stopped"}
                            />
                            <span className="mono dl-lcp-instance-id">{instance.instanceId}</span>
                            {instance.disabled && <span className="tag dl-lcp-disabled-badge">Disabled</span>}
                          </div>
                          <div className="dl-lcp-instance-actions">
                            <button
                              className={`dl-lcp-icon-btn ${isEditing ? "is-active" : ""}`}
                              title={isEditing ? "Close editor" : `Edit params for "${instance.instanceId}"`}
                              onClick={() => setEditingInstanceId(isEditing ? null : instance.instanceId)}
                            >
                              <Pencil size={12} />
                            </button>
                            <button
                              className="dl-lcp-icon-btn dl-lcp-icon-btn-danger"
                              title={`Delete instance "${instance.instanceId}"`}
                              disabled={isDeleting}
                              onClick={() => setConfirmDelete(instance.instanceId)}
                            >
                              {isDeleting ? <Loader2 size={12} className="dl-lcp-spin" /> : <Trash2 size={12} />}
                            </button>
                          </div>
                        </div>

                        {Object.keys(instance.params).length > 0 && (
                          <div className="dl-lcp-chips">
                            {Object.entries(instance.params).map(([k, v]) => (
                              <span key={k} className="mono dl-lcp-chip">
                                {k}={String(v)}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="dl-lcp-instance-ctrls">
                          <button
                            className="dl-lcp-ctrl dl-lcp-ctrl-start dl-lcp-ctrl-sm"
                            disabled={!!busy || offline}
                            onClick={() => void runControl("start", instance.instanceId)}
                          >
                            {busy === "start" ? <Loader2 size={10} className="dl-lcp-spin" /> : <Play size={10} />}
                            Start
                          </button>
                          <button
                            className="dl-lcp-ctrl dl-lcp-ctrl-stop dl-lcp-ctrl-sm"
                            disabled={!!busy || offline}
                            onClick={() => void runControl("stop", instance.instanceId)}
                          >
                            {busy === "stop" ? <Loader2 size={10} className="dl-lcp-spin" /> : <Square size={10} />}
                            Stop
                          </button>
                          <button
                            className="dl-lcp-ctrl dl-lcp-ctrl-sm"
                            disabled={!!busy || offline}
                            onClick={() => void runControl("restart", instance.instanceId)}
                          >
                            {busy === "restart" ? <Loader2 size={10} className="dl-lcp-spin" /> : <RotateCw size={10} />}
                            Restart
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Create instance */}
              <div className="dl-lcp-create">
                {showCreate ? (
                  <div className="dl-lcp-create-form">
                    <label className="dl-lcp-create-label">
                      {config.instanceKeyField ? `Instance ID (${config.instanceKeyField})` : "Instance ID"}
                    </label>
                    <div className="dl-lcp-create-row">
                      <input
                        className={`dl-lcp-input mono ${newInstanceError ? "is-err" : ""}`}
                        type="text"
                        autoFocus
                        placeholder="e.g. my-instance-1"
                        value={newInstanceId}
                        onChange={(e) => {
                          setNewInstanceId(e.target.value);
                          setNewInstanceError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void handleCreate();
                          if (e.key === "Escape") {
                            setShowCreate(false);
                            setNewInstanceId("");
                            setNewInstanceError(null);
                          }
                        }}
                      />
                      <button
                        className="dl-lcp-btn dl-lcp-btn-primary"
                        disabled={creating || !newInstanceId.trim() || offline}
                        onClick={() => void handleCreate()}
                      >
                        {creating && <Loader2 size={10} className="dl-lcp-spin" />}
                        Create
                      </button>
                      <button
                        className="dl-lcp-btn dl-lcp-btn-secondary"
                        onClick={() => {
                          setShowCreate(false);
                          setNewInstanceId("");
                          setNewInstanceError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                    {newInstanceError && (
                      <div className="dl-lcp-field-error">
                        <AlertTriangle size={10} />
                        {newInstanceError}
                      </div>
                    )}
                    <div className="dl-lcp-hint">Pattern: letters, numbers, _ or - (must start alphanumeric)</div>
                  </div>
                ) : (
                  <button
                    className="dl-lcp-add-btn"
                    disabled={offline}
                    onClick={() => setShowCreate(true)}
                  >
                    <Plus size={14} />
                    Add Instance
                  </button>
                )}
              </div>
            </section>
          )}

          {/* ── Params form ── */}
          {!loading && config && showParamsForm && (
            <section className="dl-lcp-section">
              {isMulti && editingInstanceId && (
                <div className="dl-lcp-editing-banner">
                  <Pencil size={12} />
                  <span>
                    Editing instance: <code className="mono">{editingInstanceId}</code>
                  </span>
                  <button
                    className="dl-lcp-editing-cancel dl-tap-compact"
                    onClick={() => {
                      setEditingInstanceId(null);
                      setFormValues({});
                      setOriginalValues({});
                      setSaveResult(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              <h3 className="dl-lcp-section-title">Configuration</h3>

              {groupedFields.map(({ group, fields }) => {
                const isDefault = group === DEFAULT_GROUP;
                const collapsed = collapsedGroups.has(group);
                return (
                  <div key={group} className="dl-lcp-group">
                    {!isDefault && (
                      <button className="dl-lcp-group-toggle" onClick={() => toggleGroup(group)}>
                        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                        {group}
                      </button>
                    )}
                    {(isDefault || !collapsed) && (
                      <div className="dl-lcp-fields">
                        {fields.map((field) => (
                          <FieldControl
                            key={field.key}
                            field={field}
                            value={formValues[field.key]}
                            options={dynamicOptions[field.key]}
                            loadingOptions={loadingOptions === field.key}
                            onFetchOptions={() => void fetchDynamicOptions(field)}
                            onChange={(val) => setFormValues((prev) => ({ ...prev, [field.key]: val }))}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {!loading && config && config.fields.length === 0 && !isMulti && (
            <div className="dl-lcp-state">This listener has no configurable parameters.</div>
          )}

          {/* ── Metadata ── */}
          {!loading && config && (
            <div className="dl-lcp-meta">
              {config.ingestorType && <span>Type: {config.ingestorType}</span>}
              <span>Multi-instance: {config.supportsMultiInstance ? "Yes" : "No"}</span>
              {config.instanceKeyField && <span>Instance key: {config.instanceKeyField}</span>}
              {isMulti && <span>Instances: {instances.length}</span>}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="dl-lcp-footer">
          <div className="dl-lcp-footer-status">
            {isDirty && showParamsForm && (
              <span className="dl-lcp-dirty">
                <AlertTriangle size={12} />
                Unsaved changes
              </span>
            )}
            {saveResult && (
              <span className={saveResult.ok ? "dl-lcp-save-ok" : "dl-lcp-save-err"}>
                {saveResult.ok ? <Check size={12} /> : <AlertTriangle size={12} />}
                {saveResult.message}
              </span>
            )}
          </div>
          <div className="dl-lcp-footer-actions">
            <button className="dl-lcp-btn dl-lcp-btn-secondary" onClick={onClose}>
              Close
            </button>
            {showParamsForm && (
              <button
                className="dl-lcp-btn dl-lcp-btn-primary"
                disabled={!isDirty || saving || offline}
                onClick={() => void handleSave()}
              >
                {saving && <Loader2 size={14} className="dl-lcp-spin" />}
                Save
              </button>
            )}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete listener instance?"
          description={
            <>
              <code>{confirmDelete}</code> will stop and its config will be
              removed. This cannot be undone.
            </>
          }
          busy={deletingInstance === confirmDelete}
          onConfirm={() => void handleDelete(confirmDelete)}
          onCancel={() => {
            if (deletingInstance === confirmDelete) return;
            setConfirmDelete(null);
          }}
        />
      )}
    </div>
  );
}

// ── Field control ──────────────────────────────────────────────────────────

interface FieldControlProps {
  field: ListenerField;
  value: unknown;
  options?: FieldOption[];
  loadingOptions: boolean;
  onFetchOptions: () => void;
  onChange: (value: unknown) => void;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

function FieldControl({ field, value, options, loadingOptions, onFetchOptions, onChange }: FieldControlProps) {
  const opts: FieldOption[] = options ?? field.options ?? [];
  const hasHints =
    field.min !== undefined ||
    field.max !== undefined ||
    field.pattern !== undefined ||
    field.placeholder !== undefined;

  return (
    <div className="dl-lcp-field">
      <div className="dl-lcp-field-head">
        <div className="dl-lcp-field-labels">
          <span className="mono dl-lcp-field-label">{field.label}</span>
          {field.required && <span className="dl-lcp-required">Required</span>}
          {field.instanceKey && <span className="tag dl-lcp-instance-key">Instance Key</span>}
        </div>
        <span className="tag dl-lcp-field-type">{field.type}</span>
      </div>

      {field.description && (
        <p className="dl-lcp-field-desc">
          <Info size={12} className="dl-lcp-field-desc-icon" />
          {field.description}
        </p>
      )}

      <div className="dl-lcp-field-control">
        {field.type === "text" && (
          <input
            className="dl-lcp-input mono"
            type="text"
            value={typeof value === "string" ? value : ""}
            placeholder={field.placeholder ?? `Enter ${field.label.toLowerCase()}`}
            pattern={field.pattern}
            onChange={(e) => onChange(e.target.value)}
          />
        )}

        {field.type === "number" && (
          <input
            className="dl-lcp-input mono"
            type="number"
            value={typeof value === "number" ? value : ""}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          />
        )}

        {field.type === "boolean" && (
          <button
            type="button"
            className={`dl-lcp-toggle dl-tap-compact ${value === true || (value === undefined && field.default === true) ? "is-on" : ""}`}
            onClick={() => onChange(!(value ?? field.default ?? false))}
            aria-pressed={value === true}
          >
            <span className="dl-lcp-toggle-knob" />
          </button>
        )}

        {field.type === "select" && (
          <select
            className="dl-lcp-input"
            value={typeof value === "string" ? value : value === undefined && typeof field.default === "string" ? field.default : ""}
            onFocus={() => {
              if (field.dynamicOptions && !options) onFetchOptions();
            }}
            onChange={(e) => onChange(e.target.value || undefined)}
          >
            <option value="">-- Select --</option>
            {loadingOptions && <option disabled>Loading options…</option>}
            {opts.map((opt) => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
        )}

        {field.type === "multiselect" && (
          <div className="dl-lcp-checklist">
            {loadingOptions && <span className="dl-lcp-hint">Loading options…</span>}
            {!loadingOptions && opts.length === 0 && field.dynamicOptions !== undefined && (
              <button type="button" className="dl-lcp-link" onClick={onFetchOptions}>
                Load options from API
              </button>
            )}
            {opts.map((opt) => {
              const selected = asStringArray(value).includes(String(opt.value));
              return (
                <label key={String(opt.value)} className="dl-lcp-check">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={(e) => {
                      const current = asStringArray(value);
                      const next = e.target.checked
                        ? [...current, String(opt.value)]
                        : current.filter((v) => v !== String(opt.value));
                      onChange(next.length > 0 ? next : undefined);
                    }}
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
        )}

        {field.type === "secret" && (
          <input
            className="dl-lcp-input mono"
            type="password"
            value={typeof value === "string" ? value : ""}
            placeholder={field.placeholder ?? "Enter secret value"}
            onChange={(e) => onChange(e.target.value)}
          />
        )}

        {field.type === "text[]" && (
          <TextListControl
            values={asStringArray(value)}
            placeholder={field.placeholder}
            onChange={(next) => onChange(next.length > 0 ? next : undefined)}
          />
        )}
      </div>

      {hasHints && (
        <div className="dl-lcp-field-hints">
          {field.min !== undefined && <span>Min: {field.min}</span>}
          {field.max !== undefined && <span>Max: {field.max}</span>}
          {field.pattern && <span>Pattern: {field.pattern}</span>}
          {field.placeholder && <span>Hint: {field.placeholder}</span>}
        </div>
      )}
    </div>
  );
}

// ── Editable text[] list ─────────────────────────────────────────────────────

function TextListControl({
  values,
  placeholder,
  onChange,
}: {
  values: string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="dl-lcp-textlist">
      {values.map((val, idx) => (
        <div key={idx} className="dl-lcp-textlist-row">
          <input
            className="dl-lcp-input mono"
            type="text"
            value={val}
            placeholder={placeholder}
            onChange={(e) => {
              const next = [...values];
              next[idx] = e.target.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            className="dl-lcp-icon-btn dl-lcp-icon-btn-danger"
            title="Remove"
            onClick={() => onChange(values.filter((_, i) => i !== idx))}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      <button type="button" className="dl-lcp-link" onClick={() => onChange([...values, ""])}>
        <Plus size={12} />
        Add value
      </button>
    </div>
  );
}
