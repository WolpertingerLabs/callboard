import { useState, useEffect } from "react";
import { Sun, Moon, Monitor, RefreshCw, Trash2, Sparkles, Palette } from "lucide-react";
import { getMaxTurns, saveMaxTurns, getThemeMode, saveThemeMode, getCustomThemeName, saveCustomThemeName } from "../../utils/localStorage";
import type { ThemeMode } from "../../utils/localStorage";
import { fetchInstanceName, updateInstanceName, randomizeInstanceName, listThemes, generateTheme, deleteTheme } from "../../api";
import { reloadCustomTheme } from "../../App";
import type { ThemeListItem } from "../../api";

export default function GeneralSettings() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getThemeMode());
  const [maxTurns, setMaxTurns] = useState(() => getMaxTurns());
  const [saved, setSaved] = useState(false);
  const [instanceName, setInstanceName] = useState("");
  const [nameSaved, setNameSaved] = useState(false);

  // Theme selector state
  const [customThemes, setCustomThemes] = useState<ThemeListItem[]>([]);
  const [selectedTheme, setSelectedTheme] = useState<string | null>(() => getCustomThemeName());
  const [newThemeName, setNewThemeName] = useState("");
  const [newThemeDesc, setNewThemeDesc] = useState("");
  const [generating, setGenerating] = useState(false);
  const [themeError, setThemeError] = useState("");
  const [regeneratingTheme, setRegeneratingTheme] = useState<string | null>(null);
  const [regenerateDesc, setRegenerateDesc] = useState("");

  useEffect(() => {
    fetchInstanceName()
      .then(setInstanceName)
      .catch(() => {});
    listThemes()
      .then(setCustomThemes)
      .catch(() => {});
  }, []);

  const handleThemeChange = (mode: ThemeMode) => {
    setThemeMode(mode);
    saveThemeMode(mode);
    window.dispatchEvent(new Event("theme-change"));
  };

  const handleSelectTheme = (name: string | null) => {
    setSelectedTheme(name);
    saveCustomThemeName(name);
    reloadCustomTheme();
  };

  const handleGenerateTheme = async () => {
    const name = newThemeName.trim();
    const desc = newThemeDesc.trim();
    if (!name || !desc) {
      setThemeError("Both name and description are required.");
      return;
    }
    setGenerating(true);
    setThemeError("");
    try {
      const theme = await generateTheme(name, desc);
      setCustomThemes((prev) => [...prev, { name: theme.name, createdAt: theme.createdAt, updatedAt: theme.updatedAt }]);
      setNewThemeName("");
      setNewThemeDesc("");
      // Auto-select the new theme
      handleSelectTheme(theme.name);
    } catch (err: any) {
      setThemeError(err.message || "Failed to generate theme");
    } finally {
      setGenerating(false);
    }
  };

  const handleRegenerateTheme = async (name: string) => {
    const desc = regenerateDesc.trim();
    if (!desc) {
      setThemeError("A description is required to regenerate a theme.");
      return;
    }
    setGenerating(true);
    setThemeError("");
    try {
      // Delete the old theme, generate a new one with the same name
      await deleteTheme(name);
      const theme = await generateTheme(name, desc);
      setCustomThemes((prev) => prev.map((t) => (t.name === name ? { name: theme.name, createdAt: theme.createdAt, updatedAt: theme.updatedAt } : t)));
      setRegeneratingTheme(null);
      setRegenerateDesc("");
      if (selectedTheme === name) {
        reloadCustomTheme();
      }
    } catch (err: any) {
      setThemeError(err.message || "Failed to regenerate theme");
    } finally {
      setGenerating(false);
    }
  };

  const handleDeleteTheme = async (name: string) => {
    try {
      await deleteTheme(name);
      setCustomThemes((prev) => prev.filter((t) => t.name !== name));
      if (selectedTheme === name) {
        handleSelectTheme(null);
      }
    } catch {
      /* ignore */
    }
  };

  const handleSave = () => {
    const clamped = Math.max(1, Math.min(10000, maxTurns || 200));
    saveMaxTurns(clamped);
    setMaxTurns(clamped);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleNameSave = async () => {
    const trimmed = instanceName.trim();
    if (!trimmed) return;
    try {
      const saved = await updateInstanceName(trimmed);
      setInstanceName(saved);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const handleRandomizeName = async () => {
    try {
      const name = await randomizeInstanceName();
      setInstanceName(name);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      {/* Instance Name Section */}
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
            htmlFor="instanceName"
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text)",
            }}
          >
            Instance Name
          </label>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 10,
          }}
        >
          A friendly name for this Callboard instance, displayed in the sidebar header.
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            id="instanceName"
            type="text"
            value={instanceName}
            onChange={(e) => setInstanceName(e.target.value)}
            style={{
              flex: 1,
              maxWidth: 300,
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
            onClick={handleRandomizeName}
            title="Generate random name"
            style={{
              background: "var(--surface)",
              color: "var(--text-muted)",
              padding: "10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={handleNameSave}
            style={{
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            {nameSaved ? "Saved!" : "Save"}
          </button>
        </div>
      </div>

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
                color: themeMode === mode ? "var(--text-on-accent)" : "var(--text)",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Theme Selector Section */}
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
          <Palette size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Theme</span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 12,
          }}
        >
          Select a color theme or generate a new one with AI.
        </div>

        {/* Theme list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          {/* Classic Callboard (default) */}
          <button
            onClick={() => handleSelectTheme(null)}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              borderRadius: 8,
              border: selectedTheme === null ? "2px solid var(--accent)" : "1px solid var(--border)",
              background: selectedTheme === null ? "var(--accent-bg)" : "var(--surface)",
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: selectedTheme === null ? 600 : 400,
              textAlign: "left",
            }}
          >
            <span>Classic Callboard</span>
            {selectedTheme === null && <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 500 }}>Active</span>}
          </button>

          {/* Custom themes */}
          {customThemes.map((theme) => (
            <div key={theme.name} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <button
                  onClick={() => handleSelectTheme(theme.name)}
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    borderRadius: 8,
                    border: selectedTheme === theme.name ? "2px solid var(--accent)" : "1px solid var(--border)",
                    background: selectedTheme === theme.name ? "var(--accent-bg)" : "var(--surface)",
                    color: "var(--text)",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: selectedTheme === theme.name ? 600 : 400,
                    textAlign: "left",
                  }}
                >
                  <span>{theme.name}</span>
                  {selectedTheme === theme.name && <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 500 }}>Active</span>}
                </button>
                <button
                  onClick={() => {
                    if (regeneratingTheme === theme.name) {
                      setRegeneratingTheme(null);
                      setRegenerateDesc("");
                    } else {
                      setRegeneratingTheme(theme.name);
                      setRegenerateDesc("");
                      setThemeError("");
                    }
                  }}
                  title={`Regenerate "${theme.name}"`}
                  style={{
                    background: "var(--surface)",
                    color: "var(--text-muted)",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <RefreshCw size={14} />
                </button>
                <button
                  onClick={() => handleDeleteTheme(theme.name)}
                  title={`Delete "${theme.name}"`}
                  style={{
                    background: "var(--surface)",
                    color: "var(--text-muted)",
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
              {regeneratingTheme === theme.name && (
                <div style={{ display: "flex", gap: 6, paddingLeft: 4 }}>
                  <input
                    type="text"
                    placeholder="Describe the new look..."
                    value={regenerateDesc}
                    onChange={(e) => setRegenerateDesc(e.target.value)}
                    disabled={generating}
                    style={{
                      flex: 1,
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      color: "var(--text)",
                      fontSize: 12,
                      boxSizing: "border-box",
                    }}
                  />
                  <button
                    onClick={() => handleRegenerateTheme(theme.name)}
                    disabled={generating}
                    style={{
                      background: generating ? "var(--surface)" : "var(--accent)",
                      color: generating ? "var(--text-muted)" : "var(--text-on-accent)",
                      padding: "8px 14px",
                      borderRadius: 8,
                      border: generating ? "1px solid var(--border)" : "none",
                      fontSize: 12,
                      cursor: generating ? "not-allowed" : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {generating ? "Regenerating..." : "Regenerate"}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Generate new theme */}
        <div
          style={{
            borderTop: "1px solid var(--border)",
            paddingTop: 14,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
            <Sparkles size={14} style={{ color: "var(--accent)" }} />
            Generate New Theme
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="text"
              placeholder="Theme name"
              value={newThemeName}
              onChange={(e) => setNewThemeName(e.target.value)}
              disabled={generating}
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: 13,
                boxSizing: "border-box",
              }}
            />
            <textarea
              placeholder='Describe the theme (e.g., "warm sunset colors with orange and purple accents")'
              value={newThemeDesc}
              onChange={(e) => setNewThemeDesc(e.target.value)}
              disabled={generating}
              rows={2}
              style={{
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: 13,
                resize: "vertical",
                fontFamily: "inherit",
                boxSizing: "border-box",
              }}
            />
            {themeError && <div style={{ fontSize: 12, color: "var(--error)" }}>{themeError}</div>}
            <button
              onClick={handleGenerateTheme}
              disabled={generating}
              style={{
                background: generating ? "var(--surface)" : "var(--accent)",
                color: generating ? "var(--text-muted)" : "var(--text-on-accent)",
                padding: "10px 20px",
                borderRadius: 8,
                border: generating ? "1px solid var(--border)" : "none",
                fontSize: 13,
                fontWeight: 500,
                cursor: generating ? "not-allowed" : "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Sparkles size={14} />
              {generating ? "Generating..." : "Generate Theme"}
            </button>
          </div>
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
              color: "var(--text-on-accent)",
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
