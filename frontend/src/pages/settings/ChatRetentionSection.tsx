import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import type { EngineRetention } from "shared/types/index.js";
import { getEngineRetention, setClaudeRetention } from "../../api";
import { errorMessage } from "../../utils/errorMessage";
import { sectionStyle, headerStyle, subtitleStyle, inputStyle, helpStyle } from "./styles";

type RetentionEngine = EngineRetention["engine"];
type ClaudeRetention = Extract<EngineRetention, { engine: "claude-code" }>;

/** What Callboard writes for "keep forever" — the backend's ceiling, ~100 years. */
export const FOREVER_DAYS = 36500;

const ENGINE_LABEL: Record<RetentionEngine, string> = { "claude-code": "Claude", codex: "Codex", pi: "pi" };

const PRESETS: { label: string; days: number | null }[] = [
  { label: "Default", days: null },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "Forever", days: FOREVER_DAYS },
];

/** "90 days", "1 day". Callers handle the forever case themselves, because no sentence reads well with "forever" dropped into a day count. */
export function describeDays(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

const isForever = (days: number) => days >= FOREVER_DAYS;

const toDraft = (days: number | null) => (days === null ? "" : String(days));

/**
 * Parse the days box. Digits only: `Number()` would accept "1e3", "0x10" and
 * "90.0", and a number input would report anything it cannot parse as "",
 * which reads as "use the default" and would save as exactly that.
 */
export function parseDays(draft: string): { valid: true; days: number | null } | { valid: false } {
  const trimmed = draft.trim();
  if (trimmed === "") return { valid: true, days: null };
  if (!/^\d+$/.test(trimmed)) return { valid: false };
  const days = Number(trimmed);
  return days >= 1 && days <= FOREVER_DAYS ? { valid: true, days } : { valid: false };
}

/**
 * "Chat retention" on an engine's tab in Settings → API: how long the engine
 * keeps its own transcripts before deleting them itself.
 *
 * Self-contained, with its own Save, rather than another field on the page's
 * form: the page's Save writes Callboard's `agent-settings.json`, while this
 * writes Claude's own `~/.claude/settings.json`. Folding the two into one
 * button would make one click commit to two files with different failure
 * modes.
 *
 * Only Claude has a policy to edit. Codex and pi keep sessions until deleted,
 * so their tabs say so and offer nothing to change.
 */
export default function ChatRetentionSection({ engine }: { engine: RetentionEngine }) {
  // undefined: still loading. null: loaded, but the server did not report this engine.
  const [retention, setRetention] = useState<EngineRetention | null | undefined>(undefined);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getEngineRetention()
      .then((all) => {
        if (cancelled) return;
        setRetention(all.find((r) => r.engine === engine) ?? null);
        setLoadError("");
      })
      .catch((err) => {
        if (!cancelled) setLoadError(errorMessage(err, "Failed to read chat retention"));
      });
    return () => {
      cancelled = true;
    };
  }, [engine]);

  /** Re-read after a failed save, so a file that changed underneath (now unparseable, now policy-locked) shows as such. */
  const reload = async () => {
    try {
      const all = await getEngineRetention();
      const next = all.find((r) => r.engine === engine);
      if (next) setRetention(next);
    } catch {
      /* the save error is already on screen; a failed re-read adds nothing */
    }
  };

  return (
    <div style={sectionStyle}>
      <div style={headerStyle}>
        <History size={16} style={{ color: "var(--accent-text)" }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Chat retention</span>
      </div>
      {loadError ? (
        <div style={{ color: "var(--danger)", fontSize: 13 }}>{loadError}</div>
      ) : retention === undefined ? (
        <div style={subtitleStyle}>Checking…</div>
      ) : retention === null ? (
        <div style={subtitleStyle}>This server doesn&rsquo;t report chat retention for {ENGINE_LABEL[engine]}.</div>
      ) : retention.engine === "claude-code" ? (
        <ClaudeRetentionEditor retention={retention} onSaved={setRetention} onSaveFailed={reload} />
      ) : (
        <>
          <div style={{ ...subtitleStyle, marginBottom: 6 }}>
            <strong style={{ color: "var(--text)" }}>Kept indefinitely.</strong> {ENGINE_LABEL[retention.engine]} has no automatic expiry, so there is nothing
            to configure: sessions stay until they are deleted.
          </div>
          <div style={helpStyle}>
            Stored in <code style={{ fontSize: 11 }}>{retention.storagePath}</code>
          </div>
        </>
      )}
    </div>
  );
}

function ClaudeRetentionEditor({
  retention,
  onSaved,
  onSaveFailed,
}: {
  retention: ClaudeRetention;
  onSaved: (r: ClaudeRetention) => void;
  onSaveFailed: () => Promise<void>;
}) {
  // The text box holds the configured value; blank means "use the default".
  const [draft, setDraft] = useState(toDraft(retention.configuredDays));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(savedTimer.current), []);

  const locked = Boolean(retention.managedBy || retention.unreadable);
  const parsed = parseDays(draft);
  const days = parsed.valid ? parsed.days : undefined;
  // Untouched: the box still shows what the file says. That can be out of the
  // range Callboard writes (a hand-edited 99999), which is not the user's
  // mistake to be told about until they edit it.
  const pristine = draft === toDraft(retention.configuredDays);
  const showInvalid = !parsed.valid && !pristine;
  const dirty = !pristine && (!parsed.valid || days !== retention.configuredDays);
  const canSave = parsed.valid && dirty && !locked && !saving;
  const nextEffective = days === null ? retention.defaultDays : days;
  // Lowering the period is the one edit that destroys data — on Claude's next
  // start, not on Save — so it is the one that gets a warning. Two "forever"
  // values (a hand-written 99999 and the 36500 preset) are not a reduction.
  const shrinking =
    parsed.valid && dirty && nextEffective !== undefined && nextEffective < retention.effectiveDays && !(isForever(nextEffective) && isForever(retention.effectiveDays));

  const save = async () => {
    if (!canSave || !parsed.valid) return;
    setSaving(true);
    setError("");
    try {
      const next = await setClaudeRetention(parsed.days);
      onSaved(next);
      // This editor is the only writer, so the draft is re-synced here rather
      // than from an effect on the prop.
      setDraft(toDraft(next.configuredDays));
      setSaved(true);
      clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errorMessage(err, "Failed to save chat retention"));
      await onSaveFailed();
    } finally {
      setSaving(false);
    }
  };

  const summary = isForever(retention.effectiveDays) ? (
    <>
      Claude is set to <strong style={{ color: "var(--text)" }}>keep chats indefinitely</strong>
    </>
  ) : (
    <>
      Every time Claude starts, including the sessions Callboard launches, it deletes chats that haven&rsquo;t been written to in{" "}
      <strong style={{ color: "var(--text)" }}>{describeDays(retention.effectiveDays)}</strong>
    </>
  );

  return (
    <>
      <div style={subtitleStyle}>
        {summary}
        {retention.managedBy ? " (set by your organization's policy)" : retention.configuredDays === null ? " (Claude's default)" : ""}. This applies to every
        Claude chat, bookmarked or not.
      </div>

      {retention.managedBy && (
        <div style={{ ...helpStyle, marginBottom: 10 }}>
          Locked: this is set by <code style={{ fontSize: 11 }}>{retention.managedBy}</code>, which overrides your own settings.
        </div>
      )}
      {retention.unreadable && (
        <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 10 }}>
          <code style={{ fontSize: 11 }}>{retention.settingsPath}</code> isn&rsquo;t valid JSON ({retention.unreadable}). Callboard won&rsquo;t rewrite it,
          because that would drop your other Claude settings. Fix the file to change this here.
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <input
          type="text"
          inputMode="numeric"
          aria-label="Days to keep Claude chats"
          aria-invalid={showInvalid}
          placeholder={`${retention.defaultDays} (default)`}
          value={draft}
          disabled={locked}
          // readOnly rather than disabled while saving, so Enter-to-save keeps focus here.
          readOnly={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          style={{ ...inputStyle, width: 140, borderColor: showInvalid ? "var(--danger)" : "var(--border)" }}
        />
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>days</span>
        {PRESETS.map(({ label, days: presetDays }) => {
          const active = parsed.valid && parsed.days === presetDays;
          return (
            <button
              key={label}
              type="button"
              disabled={locked || saving}
              onClick={() => setDraft(presetDays === null ? "" : String(presetDays))}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                fontSize: 12,
                border: "1px solid var(--border)",
                background: active ? "var(--accent)" : "var(--surface)",
                color: active ? "var(--text-on-accent)" : "var(--text)",
                cursor: locked || saving ? "not-allowed" : "pointer",
              }}
            >
              {label}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => void save()}
          disabled={!canSave}
          style={{
            marginLeft: "auto",
            padding: "6px 14px",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            border: "none",
            background: canSave || saving ? "var(--accent)" : "var(--surface)",
            color: canSave || saving ? "var(--text-on-accent)" : "var(--text-muted)",
            cursor: canSave ? "pointer" : "not-allowed",
          }}
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save"}
        </button>
      </div>

      {showInvalid && (
        <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>
          Enter a whole number of days from 1 to {FOREVER_DAYS}, or leave it blank for the default.
        </div>
      )}
      {shrinking && (
        <div style={{ color: "var(--warning)", fontSize: 12, marginTop: 6 }}>
          Shorter than now: the next time Claude starts, it will delete any Claude chat not written to in the last {describeDays(nextEffective)}.
        </div>
      )}
      {error && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>{error}</div>}

      <div style={{ ...helpStyle, marginTop: 8 }}>
        Saved as <code style={{ fontSize: 11 }}>cleanupPeriodDays</code> in <code style={{ fontSize: 11 }}>{retention.settingsPath}</code>, so it also applies
        to Claude outside Callboard. Leave it blank to use the default. A repository&rsquo;s own <code style={{ fontSize: 11 }}>.claude/settings.json</code> can
        set a different value for Claude sessions started there. Shortening it is only allowed from a browser on the local network.
      </div>
    </>
  );
}
