import { useState } from "react";
import { LogOut, Lock, Eye, EyeOff } from "lucide-react";
import ConfirmModal from "../../components/ConfirmModal";
import { changePassword } from "../../api";

interface AccountSettingsProps {
  onLogout: () => void;
}

export default function AccountSettings({ onLogout }: AccountSettingsProps) {
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  // Password change form state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);

  const canSubmit = currentPassword && newPassword && confirmPassword && !saving;

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");

    if (newPassword !== confirmPassword) {
      setError("New passwords do not match.");
      return;
    }

    if (!newPassword) {
      setError("New password cannot be empty.");
      return;
    }

    setSaving(true);
    try {
      await changePassword(currentPassword, newPassword);
      setSuccess("Password changed successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to change password.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    flex: 1,
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontSize: 14,
    boxSizing: "border-box",
  };

  const eyeButtonStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    padding: 4,
    cursor: "pointer",
    color: "var(--text-muted)",
    display: "flex",
    alignItems: "center",
  };

  return (
    <>
      {/* Change Password Section */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          background: "var(--bg)",
          marginBottom: 16,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Lock size={16} style={{ color: "var(--accent)" }} />
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text)",
            }}
          >
            Change Password
          </span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            marginBottom: 12,
          }}
        >
          Update your server password. All other sessions will be logged out.
        </div>

        <form onSubmit={handleChangePassword}>
          {/* Current Password */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>Current Password</label>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type={showCurrent ? "text" : "password"} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} style={inputStyle} />
              <button type="button" onClick={() => setShowCurrent(!showCurrent)} style={eyeButtonStyle}>
                {showCurrent ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* New Password */}
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>New Password</label>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type={showNew ? "text" : "password"} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={inputStyle} />
              <button type="button" onClick={() => setShowNew(!showNew)} style={eyeButtonStyle}>
                {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {/* Confirm New Password */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4, display: "block" }}>Confirm New Password</label>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type={showConfirm ? "text" : "password"} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} style={inputStyle} />
              <button type="button" onClick={() => setShowConfirm(!showConfirm)} style={eyeButtonStyle}>
                {showConfirm ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          {error && <div style={{ color: "var(--danger, #dc3545)", fontSize: 13, marginBottom: 10 }}>{error}</div>}
          {success && <div style={{ color: "var(--success, #28a745)", fontSize: 13, marginBottom: 10 }}>{success}</div>}

          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              background: canSubmit ? "var(--accent)" : "var(--border)",
              color: "#fff",
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              fontSize: 14,
              cursor: canSubmit ? "pointer" : "default",
            }}
          >
            {saving ? "Saving..." : "Change Password"}
          </button>
        </form>
      </div>

      {/* Account / Logout Section */}
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 20,
          background: "var(--bg)",
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
    </>
  );
}
