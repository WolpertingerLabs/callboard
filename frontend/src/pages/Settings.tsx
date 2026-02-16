import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronLeft, LogOut } from "lucide-react";
import { useIsMobile } from "../hooks/useIsMobile";
import ConfirmModal from "../components/ConfirmModal";
import { getMaxTurns, saveMaxTurns } from "../utils/localStorage";

interface SettingsProps {
  onLogout: () => void;
}

export default function Settings({ onLogout }: SettingsProps) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [maxTurns, setMaxTurns] = useState(() => getMaxTurns());
  const [saved, setSaved] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  const handleSave = () => {
    const clamped = Math.max(1, Math.min(10000, maxTurns || 200));
    saveMaxTurns(clamped);
    setMaxTurns(clamped);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        {isMobile && (
          <button
            onClick={() => navigate("/")}
            style={{
              background: "none",
              padding: "4px 8px",
              display: "flex",
              alignItems: "center",
              color: "var(--text)",
            }}
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <div style={{ fontSize: 18, fontWeight: 600 }}>Settings</div>
      </header>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
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

        {/* Account / Logout Section */}
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 20,
            background: "var(--bg)",
            marginTop: 32,
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text)",
              marginBottom: 6,
            }}
          >
            Account
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--text-muted)",
              marginBottom: 12,
            }}
          >
            Log out of your current session.
          </div>
          <button
            onClick={() => setLogoutConfirmOpen(true)}
            style={{
              background: "var(--danger, #dc3545)",
              color: "#fff",
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              fontSize: 14,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <LogOut size={16} />
            Logout
          </button>
        </div>
      </div>

      {/* Logout Confirm Modal */}
      <ConfirmModal
        isOpen={logoutConfirmOpen}
        onClose={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          onLogout();
        }}
        title="Logout"
        message="Are you sure you want to log out?"
        confirmText="Logout"
        confirmStyle="danger"
      />
    </div>
  );
}
