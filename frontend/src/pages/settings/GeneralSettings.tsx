import { useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { getMaxTurns, saveMaxTurns, getThemeMode, saveThemeMode } from "../../utils/localStorage";
import type { ThemeMode } from "../../utils/localStorage";

export default function GeneralSettings() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getThemeMode());
  const [maxTurns, setMaxTurns] = useState(() => getMaxTurns());
  const [saved, setSaved] = useState(false);

  const handleThemeChange = (mode: ThemeMode) => {
    setThemeMode(mode);
    saveThemeMode(mode);
    window.dispatchEvent(new Event("theme-change"));
  };

  const handleSave = () => {
    const clamped = Math.max(1, Math.min(10000, maxTurns || 200));
    saveMaxTurns(clamped);
    setMaxTurns(clamped);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      {/* Appearance Section */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          background: "var(--bg)",
          marginBottom: 16,
        }}
      >
        <div style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 8 }}>
          {themeMode === "light" ? <Sun size={16} style={{ color: "var(--accent)" }} /> : <Moon size={16} style={{ color: "var(--accent)" }} />}
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Appearance</span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 12,
          }}
        >
          Choose your preferred color theme.
        </div>
        <div
          style={{
            display: "flex",
            borderRadius: 8,
            border: "1px solid var(--border)",
            overflow: "hidden",
          }}
        >
          {[
            { mode: "light" as ThemeMode, label: "Light", icon: <Sun size={14} /> },
            { mode: "dark" as ThemeMode, label: "Dark", icon: <Moon size={14} /> },
            { mode: "system" as ThemeMode, label: "System", icon: <Monitor size={14} /> },
          ].map(({ mode, label, icon }, idx) => (
            <button
              key={mode}
              onClick={() => handleThemeChange(mode)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                padding: "10px 12px",
                fontSize: 13,
                fontWeight: 500,
                cursor: "pointer",
                border: "none",
                borderRight: idx < 2 ? "1px solid var(--border)" : "none",
                background: themeMode === mode ? "var(--accent)" : "var(--surface)",
                color: themeMode === mode ? "#fff" : "var(--text)",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Max Iterations Section */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          background: "var(--bg)",
          marginBottom: 16,
        }}
      >
        <div style={{ marginBottom: 6 }}>
          <label
            htmlFor="maxTurns"
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text)",
            }}
          >
            Max Iterations
          </label>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 10,
          }}
        >
          Maximum number of agent turns per message. The agent will stop after this many iterations. Default is 200.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            id="maxTurns"
            type="number"
            min={1}
            max={10000}
            value={maxTurns}
            onChange={(e) => setMaxTurns(parseInt(e.target.value, 10) || 0)}
            style={{
              flex: 1,
              maxWidth: 200,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 14,
              boxSizing: "border-box",
            }}
          />
          <button
            onClick={handleSave}
            style={{
              background: "var(--accent)",
              color: "#fff",
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {saved ? "Saved!" : "Save"}
          </button>
        </div>
      </div>
    </>
  );
}
