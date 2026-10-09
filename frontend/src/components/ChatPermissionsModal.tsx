import { normalizePermissions } from "shared/types/permissions.js";
import { useState, useEffect } from "react";
import { Shield, X } from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import PermissionSettings from "./PermissionSettings";
import type { DefaultPermissions } from "../api";
import type { PermissionReviewSettings } from "shared/types/permissions.js";
import { updateChatPermissions } from "../api";
import { errorMessage } from "../utils/errorMessage";

interface ChatPermissionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  chatId: string | undefined;
  permissions: DefaultPermissions;
  onPermissionsChange: (permissions: DefaultPermissions) => void;
  /** The chat's harness, so an axis it does not use can say so. */
  provider?: string;
  /** The chat's stored review-chain settings; the toggles render only for an existing chat. */
  review?: PermissionReviewSettings;
  /** Whether the chat has a parent — "Parent can answer" is greyed without one. */
  hasParent?: boolean;
  onReviewChange?: (review: PermissionReviewSettings) => void;
}

const REVIEW_OFF: PermissionReviewSettings = { modelReview: false, parentAnswers: false };

export default function ChatPermissionsModal({
  isOpen,
  onClose,
  chatId,
  permissions,
  onPermissionsChange,
  provider,
  review = REVIEW_OFF,
  hasParent = false,
  onReviewChange,
}: ChatPermissionsModalProps) {
  const [localPermissions, setLocalPermissions] = useState<DefaultPermissions>(() => normalizePermissions(permissions));
  const [localReview, setLocalReview] = useState<PermissionReviewSettings>(review);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset local state when modal opens with new permissions
  useEffect(() => {
    if (isOpen) {
      setLocalPermissions(normalizePermissions(permissions));
      setLocalReview(review);
      setError(null);
    }
    // `review` is compared by value: a fresh object with the same flags must not reset edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, permissions, review.modelReview, review.parentAnswers]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setError(null);

    if (chatId) {
      // Existing chat: persist to backend
      setSaving(true);
      try {
        // Only flags the user changed from what the modal was given (the
        // effect above re-seeds both whenever `review` changes): another tab
        // (remote access makes two tabs the normal case) may have changed the
        // other one since, and re-sending this tab's copy would flip it back.
        const reviewDelta: Partial<PermissionReviewSettings> = {
          ...(localReview.modelReview !== review.modelReview && { modelReview: localReview.modelReview }),
          ...(localReview.parentAnswers !== review.parentAnswers && { parentAnswers: localReview.parentAnswers }),
        };
        await updateChatPermissions(chatId, localPermissions, reviewDelta);
        onPermissionsChange(localPermissions);
        onReviewChange?.(localReview);
        onClose();
      } catch (err: unknown) {
        setError(errorMessage(err, "Failed to save permissions"));
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
    localPermissions.webAccess !== permissions.webAccess ||
    localPermissions.computerControl !== normalizePermissions(permissions).computerControl ||
    localReview.modelReview !== review.modelReview ||
    localReview.parentAnswers !== review.parentAnswers;

  return (
    <ModalOverlay onClose={onClose}>
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
          provider={provider}
          {...(chatId && { review: { value: localReview, onChange: setLocalReview, parent: { available: hasParent || localReview.parentAnswers } } })}
        />

        {/* Info text */}
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, marginBottom: 16 }}>
          {chatId ? "Changes apply immediately to future tool uses in this conversation." : "These permissions will be used when the chat starts."}
        </div>

        {/* Error */}
        {error && <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12 }}>{error}</div>}

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
              color: hasChanges ? "var(--text-on-accent)" : "var(--text-muted)",
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
