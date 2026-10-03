import { Moon } from "lucide-react";
import type { QuietHours } from "../../../api";

const timeLabelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 500, color: "var(--text-muted)", marginBottom: 4, display: "block" };

/** The "Quiet hours" checkbox and, while it is ticked, its start/end time inputs. Shared by the cron job and trigger editors. */
export function QuietHoursFields({
  enabled,
  start,
  end,
  onEnabledChange,
  onStartChange,
  onEndChange,
  inputStyle,
  style,
}: {
  enabled: boolean;
  start: string;
  end: string;
  onEnabledChange: (enabled: boolean) => void;
  onStartChange: (start: string) => void;
  onEndChange: (end: string) => void;
  /** The host form's text-input style, applied to the two time inputs. */
  inputStyle: React.CSSProperties;
  /** Style for the wrapping block. */
  style?: React.CSSProperties;
}) {
  return (
    <div style={style}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onEnabledChange(e.target.checked)} style={{ width: 16, height: 16 }} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>Quiet hours</span>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>— suppress during a time window</span>
      </label>
      {enabled && (
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={timeLabelStyle}>Start</label>
            <input type="time" value={start} onChange={(e) => onStartChange(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={timeLabelStyle}>End</label>
            <input type="time" value={end} onChange={(e) => onEndChange(e.target.value)} style={inputStyle} />
          </div>
        </div>
      )}
    </div>
  );
}

/** "Quiet 22:00 – 07:00" on a cron job or trigger card; renders nothing unless quiet hours are on. */
export function QuietHoursBadge({ quietHours }: { quietHours: QuietHours | undefined }) {
  if (!quietHours?.enabled) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        fontSize: 12,
        color: "var(--text-muted)",
        marginBottom: 6,
      }}
    >
      <Moon size={12} />
      <span>
        Quiet {quietHours.start} – {quietHours.end}
      </span>
    </div>
  );
}
