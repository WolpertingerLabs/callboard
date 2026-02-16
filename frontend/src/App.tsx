import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import SplitLayout from "./components/SplitLayout";
import Login from "./pages/Login";

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [serverError, setServerError] = useState("");

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
        <Route path="/" element={<SplitLayout onLogout={handleLogout} />} />
        <Route path="/chat/new" element={<SplitLayout onLogout={handleLogout} />} />
        <Route path="/chat/:id" element={<SplitLayout onLogout={handleLogout} />} />
        <Route path="/queue" element={<SplitLayout onLogout={handleLogout} />} />
        <Route path="/settings" element={<SplitLayout onLogout={handleLogout} />} />
      </Routes>
    </BrowserRouter>
  );
}
