/** Colouring for an outlined destructive button: danger text on a faint danger border. */
export const dangerOutlineStyle: React.CSSProperties = {
  background: "transparent",
  color: "var(--danger)",
  border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
  cursor: "pointer",
};

/** The trash-can Delete button on a cron job or trigger card. */
export const deleteButtonStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "6px 10px",
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 500,
  ...dangerOutlineStyle,
};
