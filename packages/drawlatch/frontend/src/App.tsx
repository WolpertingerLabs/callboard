import { useCallback, useEffect, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import DashboardLayout from "./components/DashboardLayout";
import { DaemonProvider } from "./contexts/DaemonContext";
import Overview from "./pages/Overview";
import ConnectionsPage from "./pages/ConnectionsPage";
import ConnectionDetail from "./pages/ConnectionDetail";
import EventsView from "./pages/EventsView";
import CallerList from "./pages/CallerList";
import CallerDetail from "./pages/CallerDetail";
import IngestorTable from "./pages/IngestorTable";
import SessionTable from "./pages/SessionTable";
import SecretMatrix from "./pages/SecretMatrix";
import VaultPage from "./pages/VaultPage";
import ChangePassword from "./pages/ChangePassword";
import ComingSoon from "./pages/ComingSoon";
import Login from "./pages/Login";
import { checkAuth, onAuthRequired } from "./auth";

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [serverError, setServerError] = useState<string>("");
  const navigate = useNavigate();

  const runCheck = useCallback(() => {
    checkAuth().then((result) => {
      setAuthed(result.authenticated);
      setServerError(result.error ?? "");
    });
  }, []);

  useEffect(() => {
    runCheck();
  }, [runCheck]);

  // Mid-session 401 from any admin call -> boot back to Login.
  useEffect(() => {
    return onAuthRequired(() => {
      setAuthed(false);
      navigate("/", { replace: true });
    });
  }, [navigate]);

  if (authed === null) {
    return <div className="auth-splash">Loading…</div>;
  }

  if (!authed) {
    return <Login onLogin={runCheck} serverError={serverError || undefined} />;
  }

  return (
    <DaemonProvider>
      <Routes>
        <Route element={<DashboardLayout onLogout={() => setAuthed(false)} />}>
          <Route index element={<Overview />} />
          <Route path="connections" element={<ConnectionsPage />} />
          <Route path="connections/:alias" element={<ConnectionDetail />} />
          <Route path="callers" element={<CallerList />} />
          <Route path="callers/:alias" element={<CallerDetail />} />
          <Route path="ingestors" element={<IngestorTable />} />
          <Route path="sessions" element={<SessionTable />} />
          <Route path="secrets" element={<SecretMatrix />} />
          <Route path="vault" element={<VaultPage />} />
          <Route path="logs" element={<EventsView />} />
          <Route path="settings/password" element={<ChangePassword />} />
          <Route path="*" element={<ComingSoon title="Not found" />} />
        </Route>
      </Routes>
    </DaemonProvider>
  );
}
