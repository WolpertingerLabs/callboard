import { useState, useEffect } from "react";
import { Shield, X } from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import PermissionSettings from "./PermissionSettings";
import type { DefaultPermissions } from "../api";
import { updateChatPermissions } from "../api";

interface ChatPermissionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  chatId: string | undefined;
  permissions: DefaultPermissions;
  onPermissionsChange: (permissions: DefaultPermissions) => void;
}

export default function ChatPermissionsModal({ isOpen, onClose, chatId, permissions, onPermissionsChange }: ChatPermissionsModalProps) {
  const [localPermissions, setLocalPermissions] = useState<DefaultPermissions>(permissions);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset local state when modal opens with new permissions
  useEffect(() => {
    if (isOpen) {
      setLocalPermissions(permissions);
      setError(null);
    }
  }, [isOpen, permissions]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setError(null);

    if (chatId) {
      // Existing chat: persist to backend
      setSaving(true);
      try {
        await updateChatPermissions(chatId, localPermissions);
        onPermissionsChange(localPermissions);
        onClose();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to save permissions");
      } finally {
        setSaving(false);
      }
    } else {
      // New chat (no id yet): update local state only
      onPermissionsChange(localPermissions);
      onClose();
    }
  };

  const hasChanges =
    localPermissions.fileRead !== permissions.fileRead ||
    localPermissions.fileWrite !== permissions.fileWrite ||
    localPermissions.codeExecution !== permissions.codeExecution ||
    localPermissions.webAccess !== permissions.webAccess;

  return (
    <ModalOverlay>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          padding: 24,
          width: "90%",
          maxWidth: 480,
          border: "1px solid var(--border)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Shield size={20} color="var(--accent)" />
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{chatId ? "Chat Permissions" : "Permissions for New Chat"}</h2>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 4,
              borderRadius: 4,
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <X size={20} />
          </button>
        </div>

        {/* Permission controls */}
        <PermissionSettings
          permissions={localPermissions}
          onChange={setLocalPermissions}
          title={chatId ? "Permissions for This Chat" : "Default Permissions for New Chat"}
        />

        {/* Info text */}
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, marginBottom: 16 }}>
          {chatId ? "Changes apply immediately to future tool uses in this conversation." : "These permissions will be used when the chat starts."}
        </div>

        {/* Error */}
        {error && (
          <div style={{ color: "var(--danger, #dc3545)", fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!hasChanges || saving}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: hasChanges ? "var(--accent)" : "var(--border)",
              color: hasChanges ? "#fff" : "var(--text-muted)",
              border: "none",
              cursor: hasChanges && !saving ? "pointer" : "default",
              opacity: hasChanges && !saving ? 1 : 0.6,
            }}
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
