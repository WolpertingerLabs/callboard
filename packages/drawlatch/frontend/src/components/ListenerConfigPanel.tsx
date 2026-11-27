/**
 * ListenerConfigPanel — drawlatch listener configuration dialog.
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
 *
 * The shell is Modal: Escape closes only the topmost dialog (the delete
 * confirm, then this), and with unsaved edits the backdrop does nothing and
 * Escape/×/Close ask "Discard changes?" first.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
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
} from "lucide-react";
import { api, isDaemonDown, isUnreachable } from "../api";
import type {
  ListenerConfigEntry,
  ListenerField,
  ListenerInstancesResult,
  ListenerParamsResult,
  ResolveOptionsResult,
} from "../api";
import type { AdminIngestor } from "drawlatch-admin-types";
import ConfirmDialog from "./ConfirmDialog";
import DaemonOffline from "./DaemonOffline";
import EmptyState from "./EmptyState";
import Modal from "./Modal";
import { useToast } from "./Toast";
import { toolResult } from "../utils/toolResult";
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
type OptionValue = string | number | boolean;
type FieldOption = { value: OptionValue; label: string; description?: string };
type FormValues = Record<string, unknown>;
type Action = "start" | "stop" | "restart";

const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const DEFAULT_GROUP = "__default__";

const STATE_LABELS: Record<IngestorState, string> = {
  connected: "Connected",
  starting: "Starting",
  reconnecting: "Reconnecting",
  stopped: "Stopped",
  error: "Error",
};

const DONE: Record<Action, string> = { start: "started", stop: "stopped", restart: "restarted" };

/** `.status-dot` modifier (index.css) for an ingestor state. */
function dotClass(state: IngestorState): string {
  switch (state) {
    case "connected":
      return "up";
    case "error":
      return "down";
    case "starting":
    case "reconnecting":
      return "warn";
    case "stopped":
    default:
      return "stopped";
  }
}

/** Running, or trying to: offer Stop. Stopped or failed: offer Start. */
function isActive(state: IngestorState | undefined): boolean {
  return state === "connected" || state === "starting" || state === "reconnecting";
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
  const toast = useToast();
  const [config, setConfig] = useState<ListenerConfigEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [ingestors, setIngestors] = useState<AdminIngestor[]>([]);

  // Lifecycle control state
  const [controlBusy, setControlBusy] = useState<Action | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);

  // Per-instance control / delete state
  const [instanceBusy, setInstanceBusy] = useState<Record<string, Action>>({});
  const [deletingInstance, setDeletingInstance] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Multi-instance list
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [instancesError, setInstancesError] = useState<string | null>(null);

  // Create-instance form
  const [showCreate, setShowCreate] = useState(false);
  const [newInstanceId, setNewInstanceId] = useState("");
  const [newInstanceError, setNewInstanceError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Params form (single-instance, or editing a multi-instance)
  const [editingInstanceId, setEditingInstanceId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<FormValues>({});
  const [originalValues, setOriginalValues] = useState<FormValues>({});
  const [paramsLoading, setParamsLoading] = useState(false);
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Dynamic options cache: fieldKey → options[]
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, FieldOption[]>>({});
  const [loadingOptions, setLoadingOptions] = useState<string | null>(null);
  const [optionErrors, setOptionErrors] = useState<Record<string, string>>({});

  // Collapsible field groups (collapsed set; default group always open)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // "Discard changes?" holds the action to run once the user agrees.
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);

  // Async work can land after the panel is gone.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const isMulti = config?.supportsMultiInstance ?? supportsMultiInstance;

  const isDirty = useMemo(
    () => Object.keys(formValues).some((k) => !sameValue(formValues[k], originalValues[k])),
    [formValues, originalValues],
  );

  const showParamsForm =
    config !== null && config.fields.length > 0 && (!isMulti || editingInstanceId !== null);

  // Unsaved: params edited, or an instance ID typed but not created.
  const hasUnsaved = (isDirty && showParamsForm) || (showCreate && newInstanceId.trim() !== "");

  /** Run `action` now, or after "Discard changes?" when it would lose edits. */
  const guard = useCallback(
    (action: () => void) => {
      if (hasUnsaved) setPendingDiscard(() => action);
      else action();
    },
    [hasUnsaved],
  );

  const requestClose = useCallback(() => {
    if (saving) return;
    guard(onClose);
  }, [saving, guard, onClose]);

  const noteFailure = useCallback((res: Parameters<typeof isUnreachable>[0]) => {
    if (isUnreachable(res)) setOffline(true);
    return res.error;
  }, []);

  // ── Fetch config ────────────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError(null);
    void api.listenerConfigs(caller).then((res) => {
      if (!live) return;
      setLoading(false);
      if (isDaemonDown(res)) {
        setLoadError(noteFailure(res));
        return;
      }
      setOffline(false);
      const match = res.find((c) => c.connection === connection) ?? null;
      setConfig(match);
      if (!match) setLoadError("No listener configuration found for this connection.");
    });
    return () => {
      live = false;
    };
  }, [caller, connection, reloadKey, noteFailure]);

  // ── Poll ingestor statuses (~5s) ────────────────────────────────────────
  const fetchIngestors = useCallback(async () => {
    const res = await api.callerIngestors(caller);
    if (!mounted.current) return;
    if (isDaemonDown(res)) {
      noteFailure(res);
      return;
    }
    setOffline(false);
    setIngestors(res.filter((i) => i.connection === connection));
  }, [caller, connection, noteFailure]);

  useEffect(() => {
    void fetchIngestors();
    const id = window.setInterval(() => void fetchIngestors(), 5000);
    return () => window.clearInterval(id);
  }, [fetchIngestors]);

  // ── Fetch instances (multi-instance) ────────────────────────────────────
  const fetchInstances = useCallback(async () => {
    setLoadingInstances(true);
    const res = await api.listListenerInstances(caller, connection);
    if (!mounted.current) return;
    setLoadingInstances(false);
    if (isDaemonDown(res)) {
      setInstancesError(noteFailure(res));
      return;
    }
    setOffline(false);
    // list_listener_instances runs through runTool: its own failure is a 200
    // with success: false and no `instances`. Keep the last list then.
    const result = toolResult({ ok: true, data: res });
    if (!result.ok || !Array.isArray(res.instances)) {
      setInstancesError(result.ok ? "The daemon returned no instance list." : result.error);
      return;
    }
    setInstancesError(null);
    setInstances(res.instances);
  }, [caller, connection, noteFailure]);

  useEffect(() => {
    if (config && isMulti) void fetchInstances();
  }, [config, isMulti, fetchInstances]);
  // fetchParams reloads the list when its instance is gone, without
  // depending on (and re-running for) fetchInstances.
  const fetchInstancesRef = useRef(fetchInstances);
  fetchInstancesRef.current = fetchInstances;

  // ── Fetch params ────────────────────────────────────────────────────────
  // Each load gets a number; a response for an older one (the user switched
  // instance meanwhile) is dropped instead of overwriting the form.
  const paramsRequest = useRef(0);
  const fetchParams = useCallback(
    async (instanceId?: string) => {
      const ticket = ++paramsRequest.current;
      setParamsLoading(true);
      setFormValues({});
      setOriginalValues({});
      setSaveError(null);
      setParamsError(null);
      const res = await api.getListenerParams(caller, connection, instanceId);
      if (!mounted.current || ticket !== paramsRequest.current) return;
      setParamsLoading(false);
      if (isDaemonDown(res)) {
        setParamsError(noteFailure(res));
        return;
      }
      setOffline(false);
      // get_listener_params runs through runTool: a failure (an instance
      // removed elsewhere, say) is a 200 with success: false. Show it instead
      // of an editable form of defaults that Save could only fail on.
      const checked = toolResult({ ok: true, data: res });
      if (!checked.ok) {
        setParamsError(checked.error);
        if (instanceId) void fetchInstancesRef.current();
        return;
      }
      const result: ListenerParamsResult = res;
      const merged: FormValues = { ...result.defaults, ...result.params };
      setFormValues(merged);
      setOriginalValues(merged);
    },
    [caller, connection, noteFailure],
  );

  useEffect(() => {
    if (!config) return;
    if (isMulti) {
      if (editingInstanceId) void fetchParams(editingInstanceId);
      else paramsRequest.current++;
    } else {
      void fetchParams();
    }
  }, [config, isMulti, editingInstanceId, fetchParams]);

  // ── Lifecycle control (whole listener / bulk / single-instance) ─────────
  const runControl = useCallback(
    async (action: Action, instanceId?: string) => {
      if (instanceId) {
        setInstanceBusy((prev) => ({ ...prev, [instanceId]: action }));
      } else {
        setControlBusy(action);
        setControlError(null);
      }
      // Tool failures are HTTP 200 with success: false (or, for several
      // instances, an array with failed items): toolResult catches both.
      const res = toolResult(await api.controlListener(caller, connection, action, instanceId));
      if (!mounted.current) return;
      if (instanceId) {
        setInstanceBusy((prev) => {
          const next = { ...prev };
          delete next[instanceId];
          return next;
        });
      } else {
        setControlBusy(null);
      }
      const target = instanceId ? `Instance ${instanceId}` : isMulti ? "All instances" : "Listener";
      // Refresh either way: a partly failed bulk action still changed some.
      onChanged();
      void fetchIngestors();
      if (isMulti) void fetchInstances();
      if (res.ok) {
        toast.show(`${target} ${DONE[action]}`);
      } else if (instanceId) {
        toast.show(`Couldn't ${action} ${instanceId}: ${res.error}`, { kind: "error" });
      } else {
        setControlError(`Couldn't ${action} the listener: ${res.error}`);
      }
    },
    [caller, connection, onChanged, fetchIngestors, fetchInstances, isMulti, toast],
  );

  // ── Dynamic options ─────────────────────────────────────────────────────
  const fetchDynamicOptions = useCallback(
    async (field: ListenerField) => {
      if (!field.dynamicOptions || dynamicOptions[field.key] || loadingOptions === field.key)
        return;
      setLoadingOptions(field.key);
      setOptionErrors((prev) => {
        const next = { ...prev };
        delete next[field.key];
        return next;
      });
      const res = toolResult(await api.resolveListenerOptions(caller, connection, field.key));
      if (!mounted.current) return;
      setLoadingOptions(null);
      const data: ResolveOptionsResult | null = res.ok ? res.data : null;
      if (data?.options) {
        setDynamicOptions((prev) => ({ ...prev, [field.key]: data.options ?? [] }));
        return;
      }
      const message = !res.ok ? res.error : "The API returned no options.";
      setOptionErrors((prev) => ({ ...prev, [field.key]: message }));
    },
    [caller, connection, dynamicOptions, loadingOptions],
  );

  // ── Save params (only changed) ──────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const changed: FormValues = {};
    for (const [key, value] of Object.entries(formValues)) {
      if (!sameValue(value, originalValues[key])) changed[key] = value;
    }
    if (Object.keys(changed).length === 0 || saving) return;
    setSaving(true);
    setSaveError(null);
    // The form this save is for; if it was replaced meanwhile (another
    // instance loaded), the response must not become that form's baseline.
    const ticket = paramsRequest.current;
    const res = toolResult(
      await api.setListenerParams(caller, connection, changed, {
        instanceId: editingInstanceId ?? undefined,
      }),
    );
    if (!mounted.current) return;
    setSaving(false);
    if (res.ok) {
      if (ticket === paramsRequest.current) setOriginalValues({ ...formValues });
      toast.show(
        editingInstanceId
          ? `Saved ${editingInstanceId}'s parameters. The listener restarts with them.`
          : `Saved ${connectionName} listener parameters. The listener restarts with them.`,
      );
      onChanged();
      void fetchIngestors();
      if (isMulti) void fetchInstances();
    } else {
      setSaveError(res.error);
    }
  }, [
    formValues,
    originalValues,
    saving,
    caller,
    connection,
    connectionName,
    editingInstanceId,
    onChanged,
    fetchIngestors,
    fetchInstances,
    isMulti,
    toast,
  ]);

  // ── Create instance ─────────────────────────────────────────────────────
  const closeCreate = useCallback(() => {
    setShowCreate(false);
    setNewInstanceId("");
    setNewInstanceError(null);
  }, []);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    const id = newInstanceId.trim();
    if (!id) {
      setNewInstanceError("Instance ID is required.");
      return;
    }
    if (!INSTANCE_ID_PATTERN.test(id)) {
      setNewInstanceError(
        "Must start with a letter or number and contain only letters, numbers, _ or -.",
      );
      return;
    }
    if (instances.some((i) => i.instanceId === id)) {
      setNewInstanceError("An instance with that ID already exists.");
      return;
    }
    setCreating(true);
    setNewInstanceError(null);
    const res = toolResult(await api.createListenerInstance(caller, connection, id, {}));
    if (!mounted.current) return;
    setCreating(false);
    if (res.ok) {
      closeCreate();
      toast.show(`Instance ${id} created`);
      onChanged();
      void fetchInstances();
      void fetchIngestors();
    } else {
      setNewInstanceError(res.error);
    }
  }, [
    creating,
    newInstanceId,
    instances,
    caller,
    connection,
    closeCreate,
    onChanged,
    fetchInstances,
    fetchIngestors,
    toast,
  ]);

  // ── Delete instance ─────────────────────────────────────────────────────
  const handleDelete = useCallback(
    async (instanceId: string) => {
      if (deletingInstance) return;
      setDeletingInstance(instanceId);
      setDeleteError(null);
      const res = toolResult(await api.deleteListenerInstance(caller, connection, instanceId));
      if (!mounted.current) return;
      setDeletingInstance(null);
      if (!res.ok) {
        // Keep the dialog open with the reason, and reload the list: the
        // usual cause is an instance removed elsewhere.
        setDeleteError(res.error);
        void fetchInstances();
        return;
      }
      setConfirmDelete(null);
      if (editingInstanceId === instanceId) {
        setEditingInstanceId(null);
        setFormValues({});
        setOriginalValues({});
      }
      toast.show(`Instance ${instanceId} deleted`);
      onChanged();
      void fetchInstances();
      void fetchIngestors();
    },
    [
      deletingInstance,
      caller,
      connection,
      editingInstanceId,
      onChanged,
      fetchInstances,
      fetchIngestors,
      toast,
    ],
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

  const stopEditing = () => {
    setEditingInstanceId(null);
    setFormValues({});
    setOriginalValues({});
    setSaveError(null);
    setParamsError(null);
  };

  const singleState: IngestorState = singleStatus?.state ?? "stopped";
  const singleActive = isActive(singleState);

  const footer = (
    <>
      {(saveError || (isDirty && showParamsForm)) && (
        <div className="dl-lcp-footer-status">
          {saveError ? (
            <span className="dl-lcp-save-err" role="alert">
              <AlertTriangle size={12} aria-hidden="true" />
              {saveError}
            </span>
          ) : (
            isDirty &&
            showParamsForm && (
              <span className="dl-lcp-dirty">
                <AlertTriangle size={12} aria-hidden="true" />
                Unsaved changes
              </span>
            )
          )}
        </div>
      )}
      <button type="button" className="btn btn-secondary" onClick={requestClose} disabled={saving}>
        Close
      </button>
      {showParamsForm && (
        <button
          type="button"
          className="btn btn-primary"
          disabled={!isDirty || saving || offline || paramsLoading || paramsError !== null}
          onClick={() => void handleSave()}
        >
          {saving && <Loader2 size={14} className="spinner" aria-hidden="true" />}
          {saving ? "Saving…" : "Save"}
        </button>
      )}
    </>
  );

  return (
    <>
      <Modal
        open
        title={`${connectionName} listener`}
        subtitle={config ? (config.description ?? config.name) : undefined}
        icon={<Radio size={16} />}
        dismissible={!hasUnsaved}
        busy={saving}
        onClose={requestClose}
        footer={footer}
        bodyClassName="dl-lcp-body"
      >
        {offline && (
          <div className="dl-lcp-banner">
            <DaemonOffline action="control this listener" />
          </div>
        )}

        {loading && (
          <div className="dl-lcp-state" role="status">
            <Loader2 size={18} className="spinner" aria-hidden="true" />
            <span>Loading listener configuration…</span>
          </div>
        )}

        {!loading && loadError && !config && !offline && (
          <div className="modal-error dl-lcp-load-error" role="alert">
            <span>{loadError}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              <RotateCw size={13} aria-hidden="true" />
              Retry
            </button>
          </div>
        )}

        {/* ── Single-instance status card ── */}
        {!loading && config && !isMulti && (
          <section className="dl-lcp-section" aria-labelledby="dl-lcp-status-title">
            <h3 className="dl-lcp-section-title" id="dl-lcp-status-title">
              Status
            </h3>
            <div className="dl-lcp-card">
              <div className="dl-lcp-status-row">
                <span className={`status-dot ${dotClass(singleState)}`} aria-hidden="true" />
                <span className="dl-lcp-state-label">{STATE_LABELS[singleState]}</span>
                {singleStatus && <span className="dl-lcp-type-tag">{singleStatus.type}</span>}
              </div>

              <dl className="dl-lcp-stats">
                <div>
                  <dt>Events</dt>
                  <dd>{singleStatus?.totalEventsReceived ?? 0}</dd>
                </div>
                <div>
                  <dt>Buffered</dt>
                  <dd>{singleStatus?.bufferedEvents ?? 0}</dd>
                </div>
                <div>
                  <dt>Last event</dt>
                  <dd>{formatTime(singleStatus?.lastEventAt ?? null)}</dd>
                </div>
              </dl>

              {singleStatus?.error && (
                <div className="dl-lcp-error-box">
                  <AlertTriangle size={12} aria-hidden="true" />
                  <span>{singleStatus.error}</span>
                </div>
              )}

              <div className="dl-lcp-controls">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!!controlBusy || offline}
                  onClick={() => void runControl(singleActive ? "stop" : "start")}
                >
                  {controlBusy === "start" || controlBusy === "stop" ? (
                    <Loader2 size={13} className="spinner" aria-hidden="true" />
                  ) : singleActive ? (
                    <Square size={13} aria-hidden="true" />
                  ) : (
                    <Play size={13} aria-hidden="true" />
                  )}
                  {singleActive ? "Stop" : "Start"}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!!controlBusy || offline}
                  onClick={() => void runControl("restart")}
                >
                  {controlBusy === "restart" ? (
                    <Loader2 size={13} className="spinner" aria-hidden="true" />
                  ) : (
                    <RotateCw size={13} aria-hidden="true" />
                  )}
                  Restart
                </button>
              </div>

              {controlError && (
                <div className="modal-error dl-lcp-inline-error" role="alert">
                  {controlError}
                </div>
              )}
            </div>
          </section>
        )}

        {/* ── Multi-instance management ── */}
        {!loading && config && isMulti && (
          <section className="dl-lcp-section" aria-labelledby="dl-lcp-instances-title">
            <div className="dl-lcp-section-head">
              <h3 className="dl-lcp-section-title" id="dl-lcp-instances-title">
                Instances
              </h3>
              <div className="dl-lcp-bulk" role="group" aria-label="All instances">
                {(
                  [
                    ["start", Play, "Start all"],
                    ["stop", Square, "Stop all"],
                    ["restart", RotateCw, "Restart all"],
                  ] as const
                ).map(([action, Icon, label]) => (
                  <button
                    key={action}
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!!controlBusy || offline || instances.length === 0}
                    onClick={() => void runControl(action)}
                  >
                    {controlBusy === action ? (
                      <Loader2 size={12} className="spinner" aria-hidden="true" />
                    ) : (
                      <Icon size={12} aria-hidden="true" />
                    )}
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {controlError && (
              <div className="modal-error dl-lcp-inline-error" role="alert">
                {controlError}
              </div>
            )}

            {instancesError && (
              <div className="modal-error dl-lcp-load-error dl-lcp-inline-error" role="alert">
                <span>
                  Couldn&apos;t load the instances: {instancesError}
                  {instances.length > 0 && " Showing the last list."}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={loadingInstances}
                  onClick={() => void fetchInstances()}
                >
                  <RotateCw size={13} aria-hidden="true" />
                  Retry
                </button>
              </div>
            )}

            {loadingInstances && instances.length === 0 && !instancesError && (
              <div className="dl-lcp-state dl-lcp-state-sm" role="status">
                <Loader2 size={14} className="spinner" aria-hidden="true" />
                <span>Loading instances…</span>
              </div>
            )}

            {!loadingInstances && !instancesError && instances.length === 0 && (
              <EmptyState
                compact
                className="dl-lcp-empty"
                icon={<Radio size={20} />}
                title="No instances yet"
                body="Add an instance to start listening for events."
              />
            )}

            {instances.length > 0 && (
              <ul className="dl-lcp-instance-list">
                {instances.map((instance) => {
                  const st = statusFor(instance.instanceId);
                  const state: IngestorState = st?.state ?? "stopped";
                  const active = isActive(state);
                  const busy = instanceBusy[instance.instanceId];
                  const isDeleting = deletingInstance === instance.instanceId;
                  const isEditing = editingInstanceId === instance.instanceId;
                  const id = instance.instanceId;
                  return (
                    <li
                      key={id}
                      className={`dl-lcp-instance${instance.disabled ? " is-disabled" : ""}${isEditing ? " is-editing" : ""}`}
                    >
                      <div className="dl-lcp-instance-head">
                        <div className="dl-lcp-instance-id-wrap">
                          <span className={`status-dot ${dotClass(state)}`} aria-hidden="true" />
                          <span className="mono dl-lcp-instance-id" title={id}>
                            {id}
                          </span>
                          <span className="dl-lcp-instance-state">{STATE_LABELS[state]}</span>
                          {instance.disabled && <span className="badge badge-muted">Disabled</span>}
                        </div>
                        <div className="dl-lcp-instance-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm"
                            aria-pressed={isEditing}
                            aria-label={
                              isEditing ? `Close the editor for ${id}` : `Edit ${id}'s parameters`
                            }
                            title={isEditing ? "Close editor" : "Edit parameters"}
                            // Switching mid-save would hand this save's values
                            // to the next instance's form.
                            disabled={saving}
                            onClick={() =>
                              guard(() => {
                                if (isEditing) stopEditing();
                                else setEditingInstanceId(id);
                              })
                            }
                          >
                            <Pencil size={13} aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm dl-lcp-danger-icon"
                            aria-label={`Delete ${id}`}
                            title="Delete instance"
                            disabled={isDeleting || saving}
                            onClick={() => {
                              setDeleteError(null);
                              setConfirmDelete(id);
                            }}
                          >
                            {isDeleting ? (
                              <Loader2 size={13} className="spinner" aria-hidden="true" />
                            ) : (
                              <Trash2 size={13} aria-hidden="true" />
                            )}
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
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={!!busy || offline}
                          aria-label={`${active ? "Stop" : "Start"} ${id}`}
                          onClick={() => void runControl(active ? "stop" : "start", id)}
                        >
                          {busy === "start" || busy === "stop" ? (
                            <Loader2 size={12} className="spinner" aria-hidden="true" />
                          ) : active ? (
                            <Square size={12} aria-hidden="true" />
                          ) : (
                            <Play size={12} aria-hidden="true" />
                          )}
                          {active ? "Stop" : "Start"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={!!busy || offline}
                          aria-label={`Restart ${id}`}
                          onClick={() => void runControl("restart", id)}
                        >
                          {busy === "restart" ? (
                            <Loader2 size={12} className="spinner" aria-hidden="true" />
                          ) : (
                            <RotateCw size={12} aria-hidden="true" />
                          )}
                          Restart
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Create instance */}
            <div className="dl-lcp-create">
              {showCreate ? (
                <CreateInstanceForm
                  keyField={config.instanceKeyField}
                  value={newInstanceId}
                  error={newInstanceError}
                  creating={creating}
                  offline={offline}
                  onChange={(v) => {
                    setNewInstanceId(v);
                    setNewInstanceError(null);
                  }}
                  onSubmit={() => void handleCreate()}
                  onCancel={closeCreate}
                />
              ) : (
                <button
                  type="button"
                  className="dl-lcp-add-btn"
                  disabled={offline}
                  onClick={() => setShowCreate(true)}
                >
                  <Plus size={14} aria-hidden="true" />
                  Add instance
                </button>
              )}
            </div>
          </section>
        )}

        {/* ── Params form ── */}
        {!loading && config && showParamsForm && (
          <section className="dl-lcp-section" aria-labelledby="dl-lcp-config-title">
            {isMulti && editingInstanceId && (
              <div className="dl-lcp-editing-banner">
                <Pencil size={12} aria-hidden="true" />
                <span>
                  Editing instance <code className="mono">{editingInstanceId}</code>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm dl-lcp-editing-cancel"
                  disabled={saving}
                  onClick={() => guard(stopEditing)}
                >
                  Stop editing
                </button>
              </div>
            )}

            <h3 className="dl-lcp-section-title" id="dl-lcp-config-title">
              Configuration
            </h3>

            {paramsLoading ? (
              <div className="dl-lcp-state dl-lcp-state-sm" role="status">
                <Loader2 size={14} className="spinner" aria-hidden="true" />
                <span>Loading parameters…</span>
              </div>
            ) : paramsError ? (
              <div className="modal-error dl-lcp-load-error" role="alert">
                <span>Couldn&apos;t load the parameters: {paramsError}</span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void fetchParams(editingInstanceId ?? undefined)}
                >
                  <RotateCw size={13} aria-hidden="true" />
                  Retry
                </button>
              </div>
            ) : (
              groupedFields.map(({ group, fields }) => {
                const isDefault = group === DEFAULT_GROUP;
                const collapsed = collapsedGroups.has(group);
                return (
                  <div key={group} className="dl-lcp-group">
                    {!isDefault && (
                      <button
                        type="button"
                        className="dl-lcp-group-toggle"
                        aria-expanded={!collapsed}
                        onClick={() => toggleGroup(group)}
                      >
                        {collapsed ? (
                          <ChevronRight size={14} aria-hidden="true" />
                        ) : (
                          <ChevronDown size={14} aria-hidden="true" />
                        )}
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
                            optionsError={optionErrors[field.key]}
                            onFetchOptions={() => void fetchDynamicOptions(field)}
                            onChange={(val) =>
                              setFormValues((prev) => ({ ...prev, [field.key]: val }))
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </section>
        )}

        {!loading && config && config.fields.length === 0 && !isMulti && (
          <p className="dl-lcp-note">This listener has no configurable parameters.</p>
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
      </Modal>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete listener instance?"
          description={
            <>
              <code>{confirmDelete}</code> will stop and its config will be removed. This cannot be
              undone.
            </>
          }
          busy={deletingInstance === confirmDelete}
          error={deleteError}
          onConfirm={() => void handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}

      {pendingDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          description={
            <>
              Your changes to the <strong>{connectionName}</strong> listener haven&apos;t been
              saved.
            </>
          }
          onConfirm={() => {
            const action = pendingDiscard;
            setPendingDiscard(null);
            // Drop the edits first, so the action doesn't ask again.
            setFormValues(originalValues);
            closeCreate();
            action();
          }}
          onCancel={() => setPendingDiscard(null)}
        />
      )}
    </>
  );
}

// ── Create-instance form ───────────────────────────────────────────────────

function CreateInstanceForm({
  keyField,
  value,
  error,
  creating,
  offline,
  onChange,
  onSubmit,
  onCancel,
}: {
  keyField?: string;
  value: string;
  error: string | null;
  creating: boolean;
  offline: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <form
      className="dl-lcp-create-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!creating) onSubmit();
      }}
    >
      <label className="field-label" htmlFor={`${id}-input`}>
        {keyField ? `Instance ID (${keyField})` : "Instance ID"}
      </label>
      <div className="dl-lcp-create-row">
        <input
          ref={inputRef}
          id={`${id}-input`}
          className={`input mono dl-lcp-create-input${error ? " is-err" : ""}`}
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. my-instance-1"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint${error ? ` ${id}-err` : ""}`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // Escape cancels this form only; preventDefault keeps it from
            // closing the whole dialog (Modal skips handled keys).
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
        />
        <div className="dl-lcp-create-btns">
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={creating || !value.trim() || offline}
          >
            {creating && <Loader2 size={12} className="spinner" aria-hidden="true" />}
            Create
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
      {error && (
        <div className="dl-lcp-field-error" id={`${id}-err`} role="alert">
          <AlertTriangle size={11} aria-hidden="true" />
          {error}
        </div>
      )}
      <div className="dl-lcp-hint" id={`${id}-hint`}>
        Letters, numbers, _ or -, starting with a letter or number.
      </div>
    </form>
  );
}

// ── Field control ──────────────────────────────────────────────────────────

interface FieldControlProps {
  field: ListenerField;
  value: unknown;
  options?: FieldOption[];
  loadingOptions: boolean;
  optionsError?: string;
  onFetchOptions: () => void;
  onChange: (value: unknown) => void;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

function FieldControl({
  field,
  value,
  options,
  loadingOptions,
  optionsError,
  onFetchOptions,
  onChange,
}: FieldControlProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const controlId = `${id}-control`;
  const descId = field.description ? `${id}-desc` : undefined;
  const opts: FieldOption[] = options ?? field.options ?? [];
  const hasHints =
    field.min !== undefined ||
    field.max !== undefined ||
    field.pattern !== undefined ||
    field.placeholder !== undefined;

  // Native <select> values are strings; map back to the option's own value
  // so a number or boolean option is selected and saved as itself.
  const effective = value === undefined ? field.default : value;
  const selectValue =
    effective === undefined || effective === null || effective === "" ? "" : String(effective);
  const boolOn = effective === true;

  // A label element only where there is one control to point at.
  const labelsOne = ["text", "number", "select", "secret"].includes(field.type);

  return (
    <div className="dl-lcp-field">
      <div className="dl-lcp-field-head">
        <div className="dl-lcp-field-labels">
          {labelsOne ? (
            <label className="dl-lcp-field-label" id={labelId} htmlFor={controlId}>
              {field.label}
            </label>
          ) : (
            <span className="dl-lcp-field-label" id={labelId}>
              {field.label}
            </span>
          )}
          {field.required && <span className="dl-lcp-required">Required</span>}
          {field.instanceKey && <span className="dl-lcp-instance-key">Instance key</span>}
        </div>
        <span className="mono dl-lcp-field-type">{field.type}</span>
      </div>

      {field.description && (
        <p className="dl-lcp-field-desc" id={descId}>
          <Info size={12} className="dl-lcp-field-desc-icon" aria-hidden="true" />
          {field.description}
        </p>
      )}

      <div className="dl-lcp-field-control">
        {field.type === "text" && (
          <input
            id={controlId}
            className="input mono"
            type="text"
            value={typeof value === "string" ? value : ""}
            placeholder={field.placeholder ?? `Enter ${field.label.toLowerCase()}`}
            pattern={field.pattern}
            aria-describedby={descId}
            aria-required={field.required || undefined}
            onChange={(e) => onChange(e.target.value)}
          />
        )}

        {field.type === "number" && (
          <input
            id={controlId}
            className="input mono"
            type="number"
            value={typeof value === "number" ? value : ""}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder}
            aria-describedby={descId}
            aria-required={field.required || undefined}
            onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          />
        )}

        {field.type === "boolean" && (
          <button
            type="button"
            role="switch"
            aria-checked={boolOn}
            aria-labelledby={labelId}
            aria-describedby={descId}
            className={`dl-lcp-toggle dl-tap-compact${boolOn ? " is-on" : ""}`}
            onClick={() => onChange(!boolOn)}
          >
            <span className="dl-lcp-toggle-knob" aria-hidden="true" />
          </button>
        )}

        {field.type === "select" && (
          <select
            id={controlId}
            className="input"
            value={selectValue}
            aria-describedby={descId}
            aria-required={field.required || undefined}
            aria-busy={loadingOptions || undefined}
            onFocus={() => {
              if (field.dynamicOptions && !options) onFetchOptions();
            }}
            onChange={(e) => {
              const picked = opts.find((o) => String(o.value) === e.target.value);
              onChange(picked ? picked.value : undefined);
            }}
          >
            <option value="">Select…</option>
            {loadingOptions && <option disabled>Loading options…</option>}
            {/* Keep a saved value visible before its dynamic options load. */}
            {selectValue !== "" && !opts.some((o) => String(o.value) === selectValue) && (
              <option value={selectValue}>{selectValue}</option>
            )}
            {opts.map((opt) => (
              <option key={String(opt.value)} value={String(opt.value)}>
                {opt.label}
              </option>
            ))}
          </select>
        )}

        {field.type === "multiselect" && (
          <div
            className="dl-lcp-checklist"
            role="group"
            aria-labelledby={labelId}
            aria-describedby={descId}
          >
            {loadingOptions && (
              <span className="dl-lcp-hint" role="status">
                <Loader2 size={11} className="spinner" aria-hidden="true" /> Loading options…
              </span>
            )}
            {!loadingOptions &&
              !optionsError &&
              opts.length === 0 &&
              field.dynamicOptions !== undefined && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm dl-lcp-load-opts"
                  onClick={onFetchOptions}
                >
                  Load options from the API
                </button>
              )}
            {opts.map((opt) => {
              const selected = asStringArray(value).includes(String(opt.value));
              return (
                <label key={String(opt.value)} className="dl-lcp-check" title={opt.description}>
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
            id={controlId}
            className="input mono"
            type="password"
            autoComplete="off"
            value={typeof value === "string" ? value : ""}
            placeholder={field.placeholder ?? "Enter secret value"}
            aria-describedby={descId}
            aria-required={field.required || undefined}
            onChange={(e) => onChange(e.target.value)}
          />
        )}

        {field.type === "text[]" && (
          <TextListControl
            label={field.label}
            labelId={labelId}
            values={asStringArray(value)}
            placeholder={field.placeholder}
            onChange={(next) => onChange(next.length > 0 ? next : undefined)}
          />
        )}

        {optionsError && (
          <div className="dl-lcp-options-error" role="alert">
            <AlertTriangle size={11} aria-hidden="true" />
            <span>Couldn&apos;t load the options: {optionsError}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onFetchOptions}>
              Retry
            </button>
          </div>
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
  label,
  labelId,
  values,
  placeholder,
  onChange,
}: {
  label: string;
  labelId: string;
  values: string[];
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  // Stable row keys: an index key would hand one row's input state to its
  // neighbour when a row above it is removed.
  const keys = useRef<number[]>([]);
  const nextKey = useRef(0);
  while (keys.current.length < values.length) keys.current.push(nextKey.current++);
  if (keys.current.length > values.length) keys.current.length = values.length;

  return (
    <div className="dl-lcp-textlist" role="group" aria-labelledby={labelId}>
      {values.map((val, idx) => (
        <div key={keys.current[idx]} className="dl-lcp-textlist-row">
          <input
            className="input mono"
            type="text"
            value={val}
            placeholder={placeholder}
            aria-label={`${label} ${idx + 1}`}
            onChange={(e) => {
              const next = [...values];
              next[idx] = e.target.value;
              onChange(next);
            }}
          />
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm dl-lcp-danger-icon"
            aria-label={`Remove ${label} ${idx + 1}`}
            title="Remove"
            onClick={() => {
              keys.current.splice(idx, 1);
              onChange(values.filter((_, i) => i !== idx));
            }}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-ghost btn-sm dl-lcp-add-value"
        onClick={() => onChange([...values, ""])}
      >
        <Plus size={12} aria-hidden="true" />
        Add value
      </button>
    </div>
  );
}
