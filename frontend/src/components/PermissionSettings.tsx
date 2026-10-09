import { normalizePermissions } from "shared/types/permissions.js";
import type { PermissionReviewSettings } from "shared/types/permissions.js";
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
  /**
   * The "When a tool asks" toggles — who besides the human may answer an ask.
   * Omitted where they do not apply (e.g. agent chats).
   */
  review?: {
    value: PermissionReviewSettings;
    onChange: (next: PermissionReviewSettings) => void;
    /**
     * Render "Parent can answer". `available: false` greys it with a hint
     * (an existing chat with no parent). Omit entirely where no chat can have
     * a parent — a new chat from the New Chat panel never does.
     */
    parent?: { available: boolean };
  };
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "8px 0",
        borderBottom: "1px solid var(--border-light)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ margin: "3px 0 0" }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{description}</div>
        {hint && <div style={{ fontSize: 11, color: "var(--text-muted)", fontStyle: "italic", marginTop: 2 }}>{hint}</div>}
      </div>
    </label>
  );
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

export default function PermissionSettings({ permissions, onChange, title, provider, review }: PermissionSettingsProps) {
  permissions = normalizePermissions(permissions);
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

      <PermissionRow
        label="Browser & Computer Control"
        description="Control a managed browser or desktop on the service host"
        category="computerControl"
        permissions={permissions}
        onUpdate={updatePermission}
      />

      {review && (
        <div data-testid="permission-review-settings" style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", marginBottom: 2 }}>When a tool asks</div>
          <ToggleRow
            label="Model safety review"
            description="A reviewer model checks each ask for safety and correctness first: it can allow, deny with a reason, or pass it on with notes. Suspected prompt injection or self-destructive actions become a hard stop for you."
            checked={review.value.modelReview}
            onChange={(modelReview) => review.onChange({ ...review.value, modelReview })}
            hint={provider === "codex" ? "Not used by Codex — it has no per-call permission hook." : undefined}
          />
          {review.parent && (
            <ToggleRow
              label="Parent can answer"
              description="The chat that started this one may also answer its prompts, but only allow what it is itself allowed. You can still answer; first answer wins."
              checked={review.value.parentAnswers}
              disabled={!review.parent.available}
              hint={!review.parent.available ? "This chat has no parent chat." : provider === "codex" ? "Not used by Codex." : undefined}
              onChange={(parentAnswers) => review.onChange({ ...review.value, parentAnswers })}
            />
          )}
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
