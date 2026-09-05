import { DefaultPermissions, PermissionLevel } from "../api";

interface PermissionSettingsProps {
  permissions: DefaultPermissions;
  onChange: (permissions: DefaultPermissions) => void;
  title?: string;
  /**
   * Which harness these permissions will govern, when that is known.
   *
   * Only used to say when an axis governs *nothing* on the chosen harness. An
   * axis that silently does nothing is the decorative-gate failure
   * `adapters/acp/vendors.ts` names as disqualifying — it just wears a different
   * costume when the control is real and the tool behind it is absent.
   */
  provider?: string;
}

function PermissionRow({
  label,
  description,
  category,
  permissions,
  onUpdate,
}: {
  label: string;
  description: string;
  category: keyof DefaultPermissions;
  permissions: DefaultPermissions;
  onUpdate: (category: keyof DefaultPermissions, level: PermissionLevel) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "8px 0",
        borderBottom: "1px solid var(--border-light)",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{description}</div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {(["allow", "ask", "deny"] as PermissionLevel[]).map((level) => (
          <label
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            <input
              type="radio"
              name={category}
              value={level}
              checked={permissions[category] === level}
              onChange={() => onUpdate(category, level)}
              style={{ margin: 0 }}
            />
            <span
              style={{
                color: level === "allow" ? "var(--success)" : level === "deny" ? "var(--error)" : "var(--text-muted)",
              }}
            >
              {level.charAt(0).toUpperCase() + level.slice(1)}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

export default function PermissionSettings({ permissions, onChange, title, provider }: PermissionSettingsProps) {
  const updatePermission = (category: keyof DefaultPermissions, level: PermissionLevel) => {
    onChange({
      ...permissions,
      [category]: level,
    });
  };

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text-muted)",
          marginBottom: 8,
        }}
      >
        {title ?? "Default Permissions for New Chat"}
      </div>

      <PermissionRow
        label="File Read"
        description="Read files, search code, and list directories"
        category="fileRead"
        permissions={permissions}
        onUpdate={updatePermission}
      />

      <PermissionRow
        label="File Write"
        description="Create, edit, and modify files"
        category="fileWrite"
        permissions={permissions}
        onUpdate={updatePermission}
      />

      <PermissionRow
        label="Code Execution"
        description="Run bash commands, scripts, and build tools"
        category="codeExecution"
        permissions={permissions}
        onUpdate={updatePermission}
      />

      <PermissionRow
        label="Web Access"
        description="Fetch content from websites and search the web"
        category="webAccess"
        permissions={permissions}
        onUpdate={updatePermission}
      />

      {/* pi ships eight built-in tools — read, bash, powershell (Windows only),
          edit, write, grep, find, ls — and none of them reaches the network.
          Leaving the control looking functional would be a gate that governs
          nothing. */}
      {provider === "pi" && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "6px 0 2px", lineHeight: 1.5 }}>
          <strong style={{ color: "var(--warning)" }}>Not used by pi.</strong> pi has no built-in web tool, so this axis governs nothing on a pi chat. It still
          applies to any Callboard tool categorised as web access.
        </div>
      )}

      <div
        style={{
          fontSize: 11,
          color: "var(--text-muted)",
          marginTop: 8,
          fontStyle: "italic",
        }}
      >
        These settings can be changed for individual requests during the conversation.
      </div>
    </div>
  );
}
