import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { Sun, Moon, Monitor, RefreshCw, Trash2, Sparkles, Palette, FolderX, Plus, RotateCcw, Contact, PhoneOutgoing } from "lucide-react";
import { getMaxTurns, saveMaxTurns, getThemeMode, saveThemeMode, getCustomThemeName, saveCustomThemeName } from "../../utils/localStorage";
import type { ThemeMode } from "../../utils/localStorage";
import {
  fetchInstanceName,
  updateInstanceName,
  randomizeInstanceName,
  listThemes,
  generateTheme,
  deleteTheme,
  fetchIgnoredProjectDirs,
  updateIgnoredProjectDirs,
  fetchUserContact,
  updateUserContact,
  fetchUserContactAvailability,
  getDaemonStatus,
  getAgentSettings,
  updateAgentSettings,
} from "../../api";

const DEFAULT_MAX_CALLBACK_CHAIN_DEPTH = 10;
const DEFAULT_MAX_PENDING_CALLBACKS = 25;
import { reloadCustomTheme } from "../../App";
import type { ThemeListItem, UserContactInfo, UserContactAvailability } from "../../api";
import ThemeAuditPanel from "./ThemeAuditPanel";
import { CONTACT_FIELDS, contactFieldState, emptyContact } from "./contactFields";
import type { ContactKey } from "./contactFields";

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

  // Ignored project folders state
  const [ignoredPrefixes, setIgnoredPrefixes] = useState<string[]>([]);
  const [ignoredDefaults, setIgnoredDefaults] = useState<string[]>([]);
  const [newIgnoredPrefix, setNewIgnoredPrefix] = useState("");
  const [ignoredLoading, setIgnoredLoading] = useState(true);
  const [ignoredSaving, setIgnoredSaving] = useState(false);
  const [ignoredError, setIgnoredError] = useState<string | null>(null);
  const [ignoredSaved, setIgnoredSaved] = useState(false);

  // Contact info state
  const [contact, setContact] = useState<UserContactInfo>(emptyContact);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactSaved, setContactSaved] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);
  // null ⇒ not answered (yet, or at all) — every field stays editable.
  const [contactAvailability, setContactAvailability] = useState<UserContactAvailability | null>(null);
  const [availabilityRefreshing, setAvailabilityRefreshing] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);
  const [drawlatchDashboardUrl, setDrawlatchDashboardUrl] = useState<string | null>(null);

  // Session completion callback ("phone home") loop-safety state
  const [maxChainDepth, setMaxChainDepth] = useState<number>(DEFAULT_MAX_CALLBACK_CHAIN_DEPTH);
  const [maxPending, setMaxPending] = useState<number>(DEFAULT_MAX_PENDING_CALLBACKS);
  const [callbackSaving, setCallbackSaving] = useState(false);
  const [callbackSaved, setCallbackSaved] = useState(false);
  const [callbackError, setCallbackError] = useState<string | null>(null);

  useEffect(() => {
    fetchInstanceName()
      .then(setInstanceName)
      .catch(() => {});
    listThemes()
      .then(setCustomThemes)
      .catch(() => {});
    fetchIgnoredProjectDirs()
      .then((data) => {
        setIgnoredPrefixes(data.prefixes);
        setIgnoredDefaults(data.defaults);
      })
      .catch((err) => setIgnoredError(err.message || "Failed to load ignored folders"))
      .finally(() => setIgnoredLoading(false));
    fetchUserContact()
      .then(setContact)
      .catch(() => {});
    fetchUserContactAvailability()
      .then(setContactAvailability)
      // A failed check leaves every field usable, which is the right default —
      // but it must not be silent, or the page looks like it verified the
      // channels and found them fine.
      .catch((err) => setAvailabilityError(err.message || "Couldn't check which connections your credentials have"));
    // Connections themselves are managed in drawlatch's own dashboard, so the
    // only actionable pointer this page can give is a link to it.
    getDaemonStatus()
      .then((s) => setDrawlatchDashboardUrl(s.dashboardUrl))
      .catch(() => setDrawlatchDashboardUrl(null));
    getAgentSettings()
      .then((s) => {
        setMaxChainDepth(s.maxCallbackChainDepth ?? DEFAULT_MAX_CALLBACK_CHAIN_DEPTH);
        setMaxPending(s.maxPendingCallbacks ?? DEFAULT_MAX_PENDING_CALLBACKS);
      })
      .catch(() => {});
  }, []);

  const handleCallbackSave = async () => {
    setCallbackSaving(true);
    setCallbackError(null);
    try {
      const depth = Math.max(0, Math.floor(maxChainDepth || 0));
      const pending = Math.max(0, Math.floor(maxPending || 0));
      const updated = await updateAgentSettings({ maxCallbackChainDepth: depth, maxPendingCallbacks: pending });
      setMaxChainDepth(updated.maxCallbackChainDepth ?? DEFAULT_MAX_CALLBACK_CHAIN_DEPTH);
      setMaxPending(updated.maxPendingCallbacks ?? DEFAULT_MAX_PENDING_CALLBACKS);
      setCallbackSaved(true);
      setTimeout(() => setCallbackSaved(false), 2000);
    } catch (err: any) {
      setCallbackError(err.message || "Failed to save callback limits");
    } finally {
      setCallbackSaving(false);
    }
  };

  // Re-asks the daemon rather than reading its five-minute route cache, so a
  // connection just added in drawlatch unlocks its field without a wait.
  const handleAvailabilityRefresh = async () => {
    if (availabilityRefreshing) return;
    setAvailabilityRefreshing(true);
    setAvailabilityError(null);
    try {
      setContactAvailability(await fetchUserContactAvailability({ refresh: true }));
    } catch (err: any) {
      // Keep the answer we already had. Clearing it would silently convert a
      // known "nothing is connected" into "everything's fine" — the failure
      // this whole section is built to avoid — so report and hold instead.
      setAvailabilityError(err.message || "Couldn't re-check your connections");
    } finally {
      setAvailabilityRefreshing(false);
    }
  };

  const handleContactValueChange = (key: ContactKey, value: string) => {
    setContact((prev) => ({ ...prev, [key]: { ...prev[key], value } }));
  };

  const handleContactToggle = (key: ContactKey) => {
    setContact((prev) => ({ ...prev, [key]: { ...prev[key], enabled: !prev[key].enabled } }));
  };

  const handleContactSave = async () => {
    setContactSaving(true);
    setContactError(null);
    try {
      const saved = await updateUserContact(contact);
      setContact(saved);
      setContactSaved(true);
      setTimeout(() => setContactSaved(false), 2000);
    } catch (err: any) {
      setContactError(err.message || "Failed to save contact info");
    } finally {
      setContactSaving(false);
    }
  };

  const persistIgnoredPrefixes = async (next: string[]) => {
    setIgnoredSaving(true);
    setIgnoredError(null);
    try {
      const data = await updateIgnoredProjectDirs(next);
      setIgnoredPrefixes(data.prefixes);
      setIgnoredSaved(true);
      setTimeout(() => setIgnoredSaved(false), 1500);
    } catch (err: any) {
      setIgnoredError(err.message || "Failed to save");
    } finally {
      setIgnoredSaving(false);
    }
  };

  const handleAddIgnoredPrefix = () => {
    const trimmed = newIgnoredPrefix.trim();
    if (!trimmed) return;
    if (ignoredPrefixes.includes(trimmed)) {
      setNewIgnoredPrefix("");
      return;
    }
    const next = [...ignoredPrefixes, trimmed];
    setNewIgnoredPrefix("");
    persistIgnoredPrefixes(next);
  };

  const handleRemoveIgnoredPrefix = (prefix: string) => {
    persistIgnoredPrefixes(ignoredPrefixes.filter((p) => p !== prefix));
  };

  const handleResetIgnoredDefaults = () => {
    persistIgnoredPrefixes(ignoredDefaults);
  };

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
      // Refetch rather than splice: the contrast report is measured server-side
      // from the stored file, and a row built from the POST response would have
      // none — reading as "no problems" rather than "not looked at yet".
      setCustomThemes(await listThemes());
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
      await generateTheme(name, desc);
      setCustomThemes(await listThemes());
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

      {/* Contact Info Section */}
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
          <Contact size={16} style={{ color: "var(--accent-text)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Contact Info</span>
          <button
            onClick={handleAvailabilityRefresh}
            // aria-disabled, not disabled: a disabled button drops keyboard
            // focus to <body> mid-request, losing the user's place on the page.
            // handleAvailabilityRefresh no-ops while a refresh is in flight.
            aria-disabled={availabilityRefreshing}
            title="Re-check which connections your drawlatch credentials have"
            aria-label="Refresh connection availability"
            style={{
              marginLeft: "auto",
              background: "var(--surface)",
              color: "var(--text-muted)",
              padding: 6,
              borderRadius: 8,
              border: "1px solid var(--border)",
              cursor: availabilityRefreshing ? "wait" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <RefreshCw size={14} style={availabilityRefreshing ? { animation: "spin 1s linear infinite" } : undefined} />
          </button>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
          Provide ways for agents to reach you when you&apos;re away. When you enable a channel, the{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>notify_user</code> tool will tell the agent how to message you
          there through your connections.
        </div>

        {contactAvailability?.channelsKnown && !contactAvailability.configured && (
          <div
            style={{
              fontSize: 12,
              color: "var(--warning)",
              background: "var(--warning-bg)",
              border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
              borderRadius: 8,
              padding: "10px 12px",
              marginBottom: 14,
              lineHeight: 1.5,
            }}
          >
            No drawlatch credential is available, so no contact channel can be delivered. Mark one as the default under{" "}
            <Link to="/settings/proxy" style={{ color: "var(--warning)", fontWeight: 600, textDecoration: "underline" }}>
              Settings → Proxy
            </Link>{" "}
            (Enrolled callers → Set default), or bind one to an agent under{" "}
            <Link to="/agents" style={{ color: "var(--warning)", fontWeight: 600, textDecoration: "underline" }}>
              Agents
            </Link>{" "}
            → your agent → Overview.
          </div>
        )}

        {/* Connections live in drawlatch's dashboard — callboard can only link
            there — so a missing one is only actionable with this pointer. */}
        {(availabilityError || contactAvailability?.error || contactAvailability?.stale) && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
            {availabilityError
              ? contactAvailability
                ? `${availabilityError} — showing the last answer.`
                : `${availabilityError} — channels aren't being verified right now.`
              : contactAvailability?.error && !contactAvailability.channelsKnown
                ? `Couldn't check your connections (${contactAvailability.error}) — channels aren't being verified right now.`
                : // Partial failure outranks staleness: "we couldn't ask one of
                  // your credentials" is the fact that makes this list wrong,
                  // and it was being swallowed whenever both were set.
                  contactAvailability?.error
                  ? `A credential couldn't be checked (${contactAvailability.error}), so this list may be incomplete.`
                  : "Showing a cached connection listing — the last live check didn't get through."}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {CONTACT_FIELDS.map((field) => {
            const { key, label, placeholder } = field;
            const channel = contact[key];
            const { editable, canEnable, note, warn, missingConnection } = contactFieldState(field, contactAvailability);
            // A handle saved while the connection existed stays saved, and
            // notify_user will still dispatch on it — so switching OFF stays
            // available even when switching on doesn't.
            const enabledButUndeliverable = !canEnable && !field.comingSoon && channel.enabled;
            // Never gate switching OFF — including the coming-soon row, which
            // can hold an enabled value from an older build or a hand-edited
            // user-contact.json.
            const toggleLocked = (field.comingSoon || !canEnable) && !channel.enabled;
            return (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {/* No opacity fade anywhere in this row. A blanket fade drags
                    every layer under it below AA (the label and the user's own
                    stored handle measured 3.51:1 and 3.42:1 in light mode), and
                    it greys out the one toggle an undeliverable-but-enabled
                    channel needs the user to click. Unavailability is carried
                    by the recessed input, the cursor, and the note instead. */}
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <label htmlFor={`contact-${key}`} style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", width: 130, flexShrink: 0 }}>
                    {label}
                    {field.comingSoon && <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: 11 }}> (soon)</span>}
                  </label>
                  <input
                    id={`contact-${key}`}
                    type="text"
                    value={channel.value}
                    placeholder={placeholder}
                    disabled={!editable}
                    aria-describedby={`contact-${key}-note`}
                    onChange={(e) => handleContactValueChange(key, e.target.value)}
                    style={{
                      flex: 1,
                      padding: "9px 12px",
                      borderRadius: 8,
                      border: "1px solid var(--border)",
                      // Recessed rather than faded: --text-muted on --bg clears
                      // AA in both themes, where --text at 0.55 does not.
                      background: editable ? "var(--surface)" : "var(--bg)",
                      color: editable ? "var(--text)" : "var(--text-muted)",
                      fontSize: 14,
                      boxSizing: "border-box",
                      cursor: editable ? "text" : "not-allowed",
                    }}
                  />
                  <button
                    type="button"
                    role="switch"
                    aria-checked={channel.enabled}
                    aria-label={`Toggle ${label}`}
                    aria-describedby={`contact-${key}-note`}
                    disabled={toggleLocked}
                    onClick={() => handleContactToggle(key)}
                    style={{
                      flexShrink: 0,
                      width: 40,
                      height: 22,
                      borderRadius: 11,
                      border: "none",
                      padding: 2,
                      background: channel.enabled ? "var(--accent)" : "var(--border)",
                      cursor: toggleLocked ? "not-allowed" : "pointer",
                      display: "flex",
                      justifyContent: channel.enabled ? "flex-end" : "flex-start",
                      alignItems: "center",
                      transition: "background 0.15s",
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: "var(--text-on-accent)",
                        display: "block",
                      }}
                    />
                  </button>
                </div>
                <div id={`contact-${key}-note`} style={{ fontSize: 11, color: warn ? "var(--warning)" : "var(--text-muted)", paddingLeft: 140 }}>
                  {enabledButUndeliverable ? `Enabled, but not deliverable right now — ${note.charAt(0).toLowerCase()}${note.slice(1)}` : note}
                  {/* Connections are added in drawlatch's own dashboard, never
                      here — so the note is only actionable with a pointer to
                      it. When the daemon URL is unknown, Settings → Proxy is
                      the destination that always exists and links onward. */}
                  {missingConnection &&
                    (drawlatchDashboardUrl ? (
                      <>
                        {" "}
                        <a href={drawlatchDashboardUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--warning)", fontWeight: 600, textDecoration: "underline" }}>
                          Add it in the drawlatch dashboard
                        </a>
                        .
                      </>
                    ) : (
                      <>
                        {" "}
                        Add it in the drawlatch dashboard, which you can open from{" "}
                        <Link to="/settings/proxy" style={{ color: "var(--warning)", fontWeight: 600, textDecoration: "underline" }}>
                          Settings → Proxy
                        </Link>
                        .
                      </>
                    ))}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
          <button
            onClick={handleContactSave}
            disabled={contactSaving}
            style={{
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              fontSize: 14,
              cursor: contactSaving ? "not-allowed" : "pointer",
            }}
          >
            {contactSaved ? "Saved!" : contactSaving ? "Saving…" : "Save"}
          </button>
          {contactError && <span style={{ fontSize: 12, color: "var(--error)" }}>{contactError}</span>}
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
          {themeMode === "light" ? <Sun size={16} style={{ color: "var(--accent-text)" }} /> : <Moon size={16} style={{ color: "var(--accent-text)" }} />}
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
          <Palette size={16} style={{ color: "var(--accent-text)" }} />
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
            {selectedTheme === null && <span style={{ fontSize: 11, color: "var(--accent-text)", fontWeight: 500 }}>Active</span>}
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
                  {selectedTheme === theme.name && <span style={{ fontSize: 11, color: "var(--accent-text)", fontWeight: 500 }}>Active</span>}
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
              {/*
                Reported, never repaired. A stored theme is the user's file; the
                panel says what is wrong — failing pairings, and the variables
                the theme never defines — and leaves the choice to them.
              */}
              {theme.contrast && <ThemeAuditPanel report={theme.contrast} />}
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
            <Sparkles size={14} style={{ color: "var(--accent-text)" }} />
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

      {/* Session Completion Callbacks Section */}
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
          <PhoneOutgoing size={16} style={{ color: "var(--accent-text)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Session Completion Callbacks</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
          When a session spawns another with <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>start_chat_session</code> — or
          messages one with <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>continue_chat</code> — using{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>onComplete</code>, the calling chat is automatically re-invoked
          when that session finishes — no polling. These limits guard against runaway loops. Set either to{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>0</code> to disable new callbacks entirely.
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="maxChainDepth" style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                Max callback chain depth
              </label>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                How deep a parent→child→parent re-invocation chain may go. Default {DEFAULT_MAX_CALLBACK_CHAIN_DEPTH}.
              </div>
            </div>
            <input
              id="maxChainDepth"
              type="number"
              min={0}
              max={1000}
              value={maxChainDepth}
              onChange={(e) => setMaxChainDepth(parseInt(e.target.value, 10) || 0)}
              style={{
                width: 110,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: 14,
                boxSizing: "border-box",
              }}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="maxPending" style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
                Max concurrent pending callbacks
              </label>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                Most undelivered callbacks allowed across the instance at once. Default {DEFAULT_MAX_PENDING_CALLBACKS}.
              </div>
            </div>
            <input
              id="maxPending"
              type="number"
              min={0}
              max={10000}
              value={maxPending}
              onChange={(e) => setMaxPending(parseInt(e.target.value, 10) || 0)}
              style={{
                width: 110,
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: 14,
                boxSizing: "border-box",
              }}
            />
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 16 }}>
          <button
            onClick={handleCallbackSave}
            disabled={callbackSaving}
            style={{
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              fontSize: 14,
              cursor: callbackSaving ? "not-allowed" : "pointer",
            }}
          >
            {callbackSaved ? "Saved!" : callbackSaving ? "Saving…" : "Save"}
          </button>
          {callbackError && <span style={{ fontSize: 12, color: "var(--error)" }}>{callbackError}</span>}
        </div>
      </div>

      {/* Ignored Project Folders Section */}
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
          <FolderX size={16} style={{ color: "var(--accent-text)" }} />
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>Ignored Project Folders</span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 14,
            lineHeight: 1.5,
          }}
        >
          Sessions in one of these folders, or anywhere beneath it, are hidden from the chat list and excluded from chat search. Project folders under{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>~/.claude/projects/</code> are slugified absolute paths — each{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>/</code> becomes{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>-</code>. So{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>-tmp</code> hides{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>/tmp</code> and everything under it, and{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>-private-</code> hides{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>/private/...</code>.
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 14,
            lineHeight: 1.5,
          }}
        >
          A match has to end at a folder boundary, so <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>-tmp</code> does not
          hide a separate folder named <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>/tmpish</code> — add that as its own
          entry. An entry already ending in <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>-</code> covers everything below
          that folder but not the folder itself, which is why the built-in{" "}
          <code style={{ background: "var(--surface)", padding: "1px 4px", borderRadius: 4 }}>-private-</code> is written that way. For your own entries, prefer
          the plain form.
        </div>

        {/* Current list */}
        {ignoredLoading ? (
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Loading…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            {ignoredPrefixes.length === 0 && (
              <div style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>No prefixes configured — every project folder is shown.</div>
            )}
            {ignoredPrefixes.map((prefix) => {
              const isDefault = ignoredDefaults.includes(prefix);
              return (
                <div
                  key={prefix}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "8px 12px",
                    borderRadius: 8,
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                  }}
                >
                  <code style={{ flex: 1, fontSize: 13, color: "var(--text)" }}>{prefix}</code>
                  {isDefault && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        background: "var(--bg)",
                        padding: "2px 6px",
                        borderRadius: 4,
                        border: "1px solid var(--border)",
                      }}
                    >
                      default
                    </span>
                  )}
                  <button
                    onClick={() => handleRemoveIgnoredPrefix(prefix)}
                    title={`Remove "${prefix}"`}
                    disabled={ignoredSaving}
                    style={{
                      background: "transparent",
                      color: "var(--text-muted)",
                      padding: 6,
                      borderRadius: 6,
                      border: "1px solid var(--border)",
                      cursor: ignoredSaving ? "not-allowed" : "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add new */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
          <input
            type="text"
            value={newIgnoredPrefix}
            onChange={(e) => setNewIgnoredPrefix(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleAddIgnoredPrefix();
              }
            }}
            placeholder="e.g. -private- or -tmp"
            disabled={ignoredSaving || ignoredLoading}
            style={{
              flex: 1,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 14,
              boxSizing: "border-box",
              fontFamily: "monospace",
            }}
          />
          <button
            onClick={handleAddIgnoredPrefix}
            disabled={ignoredSaving || ignoredLoading || !newIgnoredPrefix.trim()}
            style={{
              background: !newIgnoredPrefix.trim() ? "var(--surface)" : "var(--accent)",
              color: !newIgnoredPrefix.trim() ? "var(--text-muted)" : "var(--text-on-accent)",
              padding: "10px 16px",
              borderRadius: 8,
              border: !newIgnoredPrefix.trim() ? "1px solid var(--border)" : "none",
              fontSize: 14,
              cursor: !newIgnoredPrefix.trim() || ignoredSaving ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Plus size={14} />
            Add
          </button>
        </div>

        {/* Footer actions */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between" }}>
          <button
            onClick={handleResetIgnoredDefaults}
            disabled={ignoredSaving || ignoredLoading}
            style={{
              background: "transparent",
              color: "var(--text-muted)",
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              fontSize: 12,
              cursor: ignoredSaving ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <RotateCcw size={12} />
            Reset to defaults
          </button>
          <div style={{ fontSize: 12, color: ignoredSaved ? "var(--accent)" : "var(--text-muted)" }}>
            {ignoredSaving ? "Saving…" : ignoredSaved ? "Saved" : ""}
          </div>
        </div>

        {ignoredError && <div style={{ marginTop: 12, fontSize: 12, color: "var(--error)" }}>{ignoredError}</div>}
      </div>
    </>
  );
}
