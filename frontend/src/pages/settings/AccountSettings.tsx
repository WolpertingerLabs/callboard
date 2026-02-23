import { useState } from "react";
import { LogOut } from "lucide-react";
import ConfirmModal from "../../components/ConfirmModal";

interface AccountSettingsProps {
  onLogout: () => void;
}

export default function AccountSettings({ onLogout }: AccountSettingsProps) {
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  return (
    <>
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
