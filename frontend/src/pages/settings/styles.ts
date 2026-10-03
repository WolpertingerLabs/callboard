/**
 * Style tokens shared verbatim by the settings pages. Only byte-identical
 * copies live here; a page whose variant differs keeps its own local constant.
 */

/** The bordered card each settings section sits in. */
export const sectionStyle: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 20,
  background: "var(--bg)",
  marginBottom: 16,
};

/** Icon + title row at the top of a section. */
export const headerStyle: React.CSSProperties = {
  marginBottom: 6,
  display: "flex",
  alignItems: "center",
  gap: 8,
};

/** One-line explanation under a section header. */
export const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginBottom: 12,
};

/** Field label above an input in the list-and-editor pages. */
export const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 6,
  color: "var(--text)",
};

/** Text input in the list-and-editor pages. */
export const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 13,
  boxSizing: "border-box",
};

/** Muted hint under a field. */
export const helpStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginTop: 4,
};
