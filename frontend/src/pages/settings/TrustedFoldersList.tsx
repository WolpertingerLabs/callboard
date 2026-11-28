/**
 * The folders whose own Claude hooks, credential helpers and `.mcp.json`
 * servers may run in chats with Code execution Allow (H-02; backend
 * `services/repo-config-trust.ts`). Saved on its own, not with the Settings
 * form: removing trust takes effect at once, from each chat's next message.
 * Folders are added from a chat's notice or with `callboard trust`.
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { listTrustedFolders, untrustFolder, type TrustedFolder } from "../../api";
import { errorMessage } from "../../utils/errorMessage";

export default function TrustedFoldersList() {
  const [folders, setFolders] = useState<TrustedFolder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listTrustedFolders()
      .then((f) => live && setFolders(f))
      .catch((err) => live && setError(errorMessage(err, "Failed to list trusted folders")));
    return () => {
      live = false;
    };
  }, []);

  const remove = async (path: string) => {
    setError(null);
    try {
      await untrustFolder(path);
      setFolders((prev) => (prev ?? []).filter((f) => f.path !== path));
    } catch (err) {
      setError(errorMessage(err, "Failed to stop trusting folder"));
    }
  };

  return (
    <div data-testid="trusted-folders" style={{ marginTop: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text)", marginBottom: 4 }}>Trusted folders</div>
      {folders === null && !error && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading…</div>}
      {folders?.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          None. Trust a folder from the notice in a chat there, or with <code style={{ fontSize: 11 }}>callboard trust [dir]</code>.
        </div>
      )}
      {folders && folders.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {folders.map((f) => (
            <li
              key={f.path}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "4px 8px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                fontSize: 12,
              }}
            >
              <code style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }} title={f.path}>
                {f.path}
              </code>
              <button
                type="button"
                onClick={() => void remove(f.path)}
                aria-label={`Stop trusting ${f.path}`}
                title="Stop trusting"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, color: "var(--text-muted)", display: "flex" }}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>{error}</div>}
    </div>
  );
}
