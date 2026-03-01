import { useState, useEffect, useCallback } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import SplitLayout from "./components/SplitLayout";
import Login from "./pages/Login";
import CodeLoginModal from "./components/CodeLoginModal";
import { SessionProvider } from "./contexts/SessionContext";
import { checkClaudeStatus, type ClaudeAuthStatus } from "./api";
import { getThemeMode } from "./utils/localStorage";
import type { ThemeMode } from "./utils/localStorage";

function applyTheme(mode: ThemeMode) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = mode === "system" ? (prefersDark ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
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
          <Route path="/queue" element={<SplitLayout onLogout={handleLogout} claudeLoggedIn={claudeLoggedIn} onShowClaudeModal={handleShowClaudeModal} />} />
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
