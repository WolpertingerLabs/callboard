import { useEffect, useState } from "react";
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

export function describeDays(days: number): string {
  if (days >= FOREVER_DAYS) return "forever";
  return days === 1 ? "1 day" : `${days} days`;
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
  const [retention, setRetention] = useState<EngineRetention | null>(null);
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

  return (
    <div style={sectionStyle}>
      <div style={headerStyle}>
        <History size={16} style={{ color: "var(--accent-text)" }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Chat retention</span>
      </div>
      {loadError ? (
        <div style={{ color: "var(--danger)", fontSize: 13 }}>{loadError}</div>
      ) : !retention ? (
        <div style={subtitleStyle}>Checking…</div>
      ) : retention.engine === "claude-code" ? (
        <ClaudeRetentionEditor retention={retention} onSaved={setRetention} />
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

function ClaudeRetentionEditor({ retention, onSaved }: { retention: ClaudeRetention; onSaved: (r: ClaudeRetention) => void }) {
  // The text box holds the configured value; blank means "use the default".
  const [draft, setDraft] = useState(retention.configuredDays === null ? "" : String(retention.configuredDays));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const locked = Boolean(retention.managedBy || retention.unreadable);
  const trimmed = draft.trim();
  const parsed = trimmed === "" ? null : Number(trimmed);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 1 && parsed <= FOREVER_DAYS);
  const dirty = parsed !== retention.configuredDays;
  const nextEffective = parsed ?? retention.defaultDays;
  // Lowering the period is the one edit that destroys data — on Claude's next
  // start, not on Save — so it is the one that gets a warning.
  const shrinking = valid && dirty && nextEffective < retention.effectiveDays;

  const save = async () => {
    if (!valid || !dirty || locked) return;
    setSaving(true);
    setError("");
    try {
      const next = await setClaudeRetention(parsed);
      onSaved(next);
      // This editor is the only writer, so the draft is re-synced here rather
      // than from an effect on the prop.
      setDraft(next.configuredDays === null ? "" : String(next.configuredDays));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(errorMessage(err, "Failed to save chat retention"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div style={subtitleStyle}>
        Every time Claude starts, including the sessions Callboard launches, it deletes chats that haven&rsquo;t been written to in{" "}
        <strong style={{ color: "var(--text)" }}>{describeDays(retention.effectiveDays)}</strong>
        {retention.managedBy ? " (set by your organization's policy)" : retention.configuredDays === null ? " (Claude's default)" : ""}. This applies to every
        Claude chat, bookmarked or not.
      </div>

      {retention.managedBy && (
        <div style={{ ...helpStyle, marginBottom: 10 }}>
          Locked: managed policy in <code style={{ fontSize: 11 }}>{retention.managedBy}</code> sets this, and it overrides your own settings.
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
          type="number"
          min={1}
          max={FOREVER_DAYS}
          step={1}
          inputMode="numeric"
          aria-label="Days to keep Claude chats"
          placeholder={`${retention.defaultDays} (default)`}
          value={draft}
          disabled={locked || saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          style={{ ...inputStyle, width: 140, borderColor: valid ? "var(--border)" : "var(--danger)" }}
        />
        <span style={{ fontSize: 13, color: "var(--text-muted)" }}>days</span>
        {PRESETS.map(({ label, days }) => {
          const active = parsed === days;
          return (
            <button
              key={label}
              type="button"
              disabled={locked || saving}
              onClick={() => setDraft(days === null ? "" : String(days))}
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
          disabled={locked || saving || !dirty || !valid}
          style={{
            marginLeft: "auto",
            padding: "6px 14px",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 500,
            border: "none",
            background: locked || !dirty || !valid ? "var(--surface)" : "var(--accent)",
            color: locked || !dirty || !valid ? "var(--text-muted)" : "var(--text-on-accent)",
            cursor: locked || saving || !dirty || !valid ? "not-allowed" : "pointer",
          }}
        >
          {saving ? "Saving..." : saved ? "Saved!" : "Save"}
        </button>
      </div>

      {!valid && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>Enter a whole number from 1 to {FOREVER_DAYS}, or leave it blank for the default.</div>}
      {shrinking && (
        <div style={{ color: "var(--warning)", fontSize: 12, marginTop: 6 }}>
          Shorter than now: the next time Claude starts, it will delete any Claude chat not written to in the last {describeDays(nextEffective)}.
        </div>
      )}
      {error && <div style={{ color: "var(--danger)", fontSize: 12, marginTop: 6 }}>{error}</div>}

      <div style={{ ...helpStyle, marginTop: 8 }}>
        Saved as <code style={{ fontSize: 11 }}>cleanupPeriodDays</code> in <code style={{ fontSize: 11 }}>{retention.settingsPath}</code>, so it also applies
        to Claude outside Callboard. Leave it blank to remove the key and use the default. A repository&rsquo;s{" "}
        <code style={{ fontSize: 11 }}>.claude/settings.json</code> can also set this key.
      </div>
    </>
  );
}
