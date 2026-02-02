import { DefaultPermissions, PermissionLevel } from '../api';

interface PermissionSettingsProps {
  permissions: DefaultPermissions;
  onChange: (permissions: DefaultPermissions) => void;
}

export default function PermissionSettings({ permissions, onChange }: PermissionSettingsProps) {
  const updatePermission = (category: keyof DefaultPermissions, level: PermissionLevel) => {
    onChange({
      ...permissions,
      [category]: level,
    });
  };

  const PermissionRow = ({
    label,
    description,
    category
  }: {
    label: string;
    description: string;
    category: keyof DefaultPermissions;
  }) => (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '8px 0',
      borderBottom: '1px solid var(--border-light)',
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 500, fontSize: 14 }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{description}</div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['allow', 'ask', 'deny'] as PermissionLevel[]).map(level => (
          <label key={level} style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
            cursor: 'pointer',
          }}>
            <input
              type="radio"
              name={category}
              value={level}
              checked={permissions[category] === level}
              onChange={() => updatePermission(category, level)}
              style={{ margin: 0 }}
            />
            <span style={{
              color: level === 'allow' ? 'var(--success)' :
                    level === 'deny' ? 'var(--error)' : 'var(--text-muted)'
            }}>
              {level.charAt(0).toUpperCase() + level.slice(1)}
            </span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: 12,
      marginBottom: 12,
    }}>
      <div style={{
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--text-muted)',
        marginBottom: 8
      }}>
        Default Permissions for New Chat
      </div>

      <PermissionRow
        label="File Operations"
        description="Read, write, edit files and search code"
        category="fileOperations"
      />

      <PermissionRow
        label="Code Execution"
        description="Run bash commands, scripts, and build tools"
        category="codeExecution"
      />

      <PermissionRow
        label="Web Access"
        description="Fetch content from websites and search the web"
        category="webAccess"
      />

      <div style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        marginTop: 8,
        fontStyle: 'italic'
      }}>
        These settings can be changed for individual requests during the conversation.
      </div>
    </div>
  );
}