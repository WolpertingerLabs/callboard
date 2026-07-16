import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2, Copy, Check } from "lucide-react";
import ConfirmModal from "../../components/ConfirmModal";
import { listApiKeys, createApiKey, deleteApiKey } from "../../api";
import type { ApiKeyInfo } from "../../api";

function formatDate(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Create form state
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [creating, setCreating] = useState(false);

  // One-time token reveal after creation
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyInfo | null>(null);

  const refresh = async () => {
    try {
      setKeys(await listApiKeys());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load API keys.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setCreating(true);
    try {
      // Expire at end-of-day local time so a key created "until July 20" works through July 20
      const expiresAt = expiryDate ? new Date(`${expiryDate}T23:59:59`).getTime() : null;
      const { token } = await createApiKey(name.trim(), description.trim(), expiresAt);
      setNewToken(token);
      setCopied(false);
      setName("");
      setDescription("");
      setExpiryDate("");
      setFormOpen(false);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create API key.");
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setError("");
    try {
      await deleteApiKey(revokeTarget.id);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to revoke API key.");
    } finally {
      setRevokeTarget(null);
    }
  };

  const handleCopy = async () => {
    if (!newToken) return;
    await navigator.clipboard.writeText(newToken);
    setCopied(true);
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontSize: 14,
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: "var(--text-muted)",
    marginBottom: 4,
    display: "block",
  };

  const now = Date.now();

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 20,
        background: "var(--bg)",
        marginBottom: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <KeyRound size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>API Keys</span>
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>
        Bearer tokens that let external tools call the Callboard API without a browser login. Send as{" "}
        <code style={{ fontSize: 11 }}>Authorization: Bearer &lt;token&gt;</code>.
      </div>

      {/* One-time token reveal */}
      {newToken && (
        <div
          style={{
            border: "1px solid var(--accent)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
            background: "var(--surface)",
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>Copy your new API key now — it won&apos;t be shown again.</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <code
              style={{
                flex: 1,
                fontSize: 12,
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                wordBreak: "break-all",
              }}
            >
              {newToken}
            </code>
            <button
              onClick={handleCopy}
              title="Copy to clipboard"
              style={{
                background: "var(--accent)",
                color: "var(--text-on-accent)",
                border: "none",
                borderRadius: 6,
                padding: "8px 10px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <button
            onClick={() => setNewToken(null)}
            style={{
              marginTop: 8,
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 12,
              cursor: "pointer",
              padding: 0,
            }}
          >
            Done — I&apos;ve saved it
          </button>
        </div>
      )}

      {/* Key list */}
      {loading ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>Loading…</div>
      ) : keys.length === 0 ? (
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>No API keys yet.</div>
      ) : (
        <div style={{ marginBottom: 12 }}>
          {keys.map((key) => {
            const expired = key.expires_at !== null && key.expires_at < now;
            return (
              <div
                key={key.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  marginBottom: 8,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{key.name}</span>
                    <code style={{ fontSize: 11, color: "var(--text-muted)" }}>{key.tokenPreview}…</code>
                    {expired && (
                      <span
                        style={{
                          fontSize: 11,
                          color: "var(--danger, #dc3545)",
                          border: "1px solid var(--danger, #dc3545)",
                          borderRadius: 4,
                          padding: "1px 6px",
                        }}
                      >
                        Expired
                      </span>
                    )}
                  </div>
                  {key.description && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {key.description}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                    Created {formatDate(key.created_at)}
                    {" · "}
                    {key.expires_at ? `Expires ${formatDate(key.expires_at)}` : "Never expires"}
                    {" · "}
                    {key.last_used_at ? `Last used ${formatDate(key.last_used_at)}` : "Never used"}
                  </div>
                </div>
                <button
                  onClick={() => setRevokeTarget(key)}
                  title="Revoke key"
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--danger, #dc3545)",
                    cursor: "pointer",
                    padding: 6,
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error && <div style={{ color: "var(--danger, #dc3545)", fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {/* Create form */}
      {formOpen ? (
        <form onSubmit={handleCreate}>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. devboard" style={inputStyle} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={labelStyle}>Description (optional)</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What will this key be used for?"
              style={inputStyle}
            />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={labelStyle}>Expiration date (optional — leave blank for no expiry)</label>
            <input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} style={inputStyle} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="submit"
              disabled={!name.trim() || creating}
              style={{
                background: name.trim() && !creating ? "var(--accent)" : "var(--border)",
                color: "var(--text-on-accent)",
                padding: "10px 20px",
                borderRadius: 8,
                border: "none",
                fontSize: 14,
                cursor: name.trim() && !creating ? "pointer" : "default",
              }}
            >
              {creating ? "Creating…" : "Create Key"}
            </button>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              style={{
                background: "none",
                color: "var(--text-muted)",
                padding: "10px 20px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                fontSize: 14,
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          onClick={() => setFormOpen(true)}
          style={{
            background: "var(--accent)",
            color: "var(--text-on-accent)",
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
          <Plus size={16} />
          New API Key
        </button>
      )}

      <ConfirmModal
        isOpen={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title="Revoke API Key"
        message={`Revoke "${revokeTarget?.name}"? Anything using this key will immediately lose access.`}
        confirmText="Revoke"
        confirmStyle="danger"
      />
    </div>
  );
}
