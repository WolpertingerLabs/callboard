/**
 * Shared popup-menu row. Used by the composer hamburger menu (PromptInput)
 * and the chat-sidebar kebab menu (ChatListItem).
 */
export interface MenuItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Accent styling — e.g. a pending model/effort change awaiting the next message. */
  active?: boolean;
  title?: string;
  /** Danger styling — destructive actions (e.g. delete). */
  danger?: boolean;
}

export default function MenuRow({ icon, label, onClick, disabled, active, title, danger }: Omit<MenuItem, "key">) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        minHeight: 44,
        padding: "10px 12px",
        borderRadius: 8,
        border: "none",
        background: active ? "var(--accent)" : "transparent",
        color: disabled ? "var(--text-muted)" : active ? "var(--text-on-accent)" : danger ? "var(--chatlist-icon-delete)" : "var(--text)",
        fontSize: 14,
        textAlign: "left",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        transition: "background 0.15s ease",
      }}
      onMouseEnter={(e) => {
        if (!disabled && !active) {
          e.currentTarget.style.background = "var(--bg-secondary)";
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = "transparent";
        }
      }}
    >
      {icon}
      {label}
    </button>
  );
}
