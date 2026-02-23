import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import SplitLayout from "./components/SplitLayout";
import Login from "./pages/Login";
import AgentList from "./pages/agents/AgentList";
import ConnectionsManager from "./pages/agents/ConnectionsManager";
import CreateAgent from "./pages/agents/CreateAgent";
import AgentDashboard from "./pages/agents/AgentDashboard";
import Overview from "./pages/agents/dashboard/Overview";
import AgentChat from "./pages/agents/dashboard/Chat";
import CronJobs from "./pages/agents/dashboard/CronJobs";
import Triggers from "./pages/agents/dashboard/Triggers";
import Connections from "./pages/agents/dashboard/Connections";
import Events from "./pages/agents/dashboard/Events";
import AgentActivity from "./pages/agents/dashboard/Activity";
import Memory from "./pages/agents/dashboard/Memory";
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

  if (authed === null) return null; // loading

  if (!authed) return <Login onLogin={() => setAuthed(true)} serverError={serverError} />;

  const handleLogout = () => {
    fetch("/api/auth/logout", { method: "POST", credentials: "include" })
      .then(() => setAuthed(false))
      .catch(() => setAuthed(false));
  };

  return (
    <BrowserRouter>
      <Routes>
        {/* Existing chat routes */}
        <Route path="/" element={<SplitLayout onLogout={handleLogout} />} />
        <Route path="/chat/new" element={<SplitLayout onLogout={handleLogout} />} />
        <Route path="/chat/:id" element={<SplitLayout onLogout={handleLogout} />} />
        <Route path="/queue" element={<SplitLayout onLogout={handleLogout} />} />
        <Route path="/settings" element={<SplitLayout onLogout={handleLogout} />} />

        {/* Agent/controller routes */}
        <Route path="/agents" element={<AgentList />} />
        <Route path="/agents/new" element={<CreateAgent />} />
        <Route path="/agents/connections" element={<ConnectionsManager />} />
        <Route path="/agents/:alias" element={<AgentDashboard />}>
          <Route index element={<Overview />} />
          <Route path="chat" element={<AgentChat />} />
          <Route path="cron" element={<CronJobs />} />
          <Route path="triggers" element={<Triggers />} />
          <Route path="connections" element={<Connections />} />
          <Route path="events" element={<Events />} />
          <Route path="activity" element={<AgentActivity />} />
          <Route path="memory" element={<Memory />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
