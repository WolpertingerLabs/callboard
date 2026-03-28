import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import SplitLayout from "./components/SplitLayout";
import Login from "./pages/Login";
import CodeLoginModal from "./components/CodeLoginModal";
import { SessionProvider } from "./contexts/SessionContext";
import { checkClaudeStatus, type ClaudeAuthStatus } from "./api";
import { getThemeMode, getCustomThemeName } from "./utils/localStorage";
import { getTheme } from "./api";
import type { ThemeMode } from "./utils/localStorage";
import type { CustomTheme } from "./api";

let cachedCustomTheme: CustomTheme | null = null;

function applyTheme(mode: ThemeMode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = mode === "system" ? (prefersDark ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;

  const root = document.documentElement;
  const customName = getCustomThemeName();

  if (!customName) {
    // Clear any custom properties that were previously set
    if (cachedCustomTheme) {
      const vars = { ...cachedCustomTheme.dark, ...cachedCustomTheme.light };
      for (const key of Object.keys(vars)) {
        root.style.removeProperty(`--${key}`);
      }
      cachedCustomTheme = null;
    }
    return;
  }

  if (cachedCustomTheme && cachedCustomTheme.name === customName) {
    applyCustomThemeVars(cachedCustomTheme, resolved);
    return;
  }

  getTheme(customName)
    .then((theme) => {
      cachedCustomTheme = theme;
      applyCustomThemeVars(theme, resolved);
    })
    .catch(() => {
      cachedCustomTheme = null;
    });
}

function applyCustomThemeVars(theme: CustomTheme, resolvedMode: string) {
  const root = document.documentElement;
  const vars = resolvedMode === "light" ? theme.light : theme.dark;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(`--${key}`, value);
  }
}

/** Force-reload the custom theme from server (after create/edit/delete). */
export function reloadCustomTheme() {
  // Clean up old theme vars before clearing cache
  // (applyTheme's cleanup relies on cachedCustomTheme, so do it here first)
  if (cachedCustomTheme) {
    const root = document.documentElement;
    const vars = { ...cachedCustomTheme.dark, ...cachedCustomTheme.light };
    for (const key of Object.keys(vars)) {
      root.style.removeProperty(`--${key}`);
    }
  }
  cachedCustomTheme = null;
  applyTheme(getThemeMode());
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [serverError, setServerError] = useState("");

  // Claude Code login state (default true to prevent flash)
  const [claudeLoggedIn, setClaudeLoggedIn] = useState(true);
  const [showClaudeModal, setShowClaudeModal] = useState(false);

  // Theme management
  useEffect(() => {
    applyTheme(getThemeMode());

    const onThemeChange = () => applyTheme(getThemeMode());
    window.addEventListener("theme-change", onThemeChange);

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemChange = () => {
      if (getThemeMode() === "system") applyTheme("system");
    };
    mediaQuery.addEventListener("change", onSystemChange);

    return () => {
      window.removeEventListener("theme-change", onThemeChange);
      mediaQuery.removeEventListener("change", onSystemChange);
    };
  }, []);

  useEffect(() => {
    fetch("/api/auth/check", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        setAuthed(d.authenticated);
        if (d.error) setServerError(d.error);
      })
      .catch(() => setAuthed(false));
  }, []);

  // Check Claude Code auth status after Callboard login
  useEffect(() => {
    if (!authed) return;

    checkClaudeStatus()
      .then((status) => {
        setClaudeLoggedIn(status.loggedIn);
        if (!status.loggedIn) {
          // Show modal unless dismissed this session
          try {
            if (!sessionStorage.getItem("claude-login-dismissed")) {
              setShowClaudeModal(true);
            }
          } catch {
            setShowClaudeModal(true);
          }
        }
      })
      .catch(() => {
        // If check fails, don't block the user — just skip the modal
      });
  }, [authed]);

  const handleClaudeStatusChange = useCallback((status: ClaudeAuthStatus) => {
    setClaudeLoggedIn(status.loggedIn);
  }, []);

  const handleShowClaudeModal = useCallback(() => {
    setShowClaudeModal(true);
  }, []);

  const handleCloseClaudeModal = useCallback(() => {
    setShowClaudeModal(false);
  }, []);

  if (authed === null) return null; // loading

  if (!authed) return <Login onLogin={() => setAuthed(true)} serverError={serverError} />;

  const handleLogout = () => {
    fetch("/api/auth/logout", { method: "POST", credentials: "include" })
      .then(() => setAuthed(false))
      .catch(() => setAuthed(false));
  };

  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          {/* Existing chat routes */}
          <Route path="/" element={<SplitLayout onLogout={handleLogout} claudeLoggedIn={claudeLoggedIn} onShowClaudeModal={handleShowClaudeModal} />} />
          <Route path="/chat/new" element={<SplitLayout onLogout={handleLogout} claudeLoggedIn={claudeLoggedIn} onShowClaudeModal={handleShowClaudeModal} />} />
          <Route path="/chat/:id" element={<SplitLayout onLogout={handleLogout} claudeLoggedIn={claudeLoggedIn} onShowClaudeModal={handleShowClaudeModal} />} />
          <Route path="/settings" element={<SplitLayout onLogout={handleLogout} claudeLoggedIn={claudeLoggedIn} onShowClaudeModal={handleShowClaudeModal} />} />

          {/* Agent routes - rendered inside SplitLayout */}
          <Route path="/agents" element={<SplitLayout onLogout={handleLogout} claudeLoggedIn={claudeLoggedIn} onShowClaudeModal={handleShowClaudeModal} />} />
          <Route
            path="/agents/new"
            element={<SplitLayout onLogout={handleLogout} claudeLoggedIn={claudeLoggedIn} onShowClaudeModal={handleShowClaudeModal} />}
          />
          <Route
            path="/agents/:alias/*"
            element={<SplitLayout onLogout={handleLogout} claudeLoggedIn={claudeLoggedIn} onShowClaudeModal={handleShowClaudeModal} />}
          />
        </Routes>
      </BrowserRouter>
      <CodeLoginModal isOpen={showClaudeModal} onClose={handleCloseClaudeModal} onStatusChange={handleClaudeStatusChange} />
    </SessionProvider>
  );
}
