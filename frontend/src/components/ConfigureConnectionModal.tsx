import { useState } from "react";
import { X, ExternalLink, Eye, EyeOff, Check, Loader2, Radio, ChevronDown, ChevronRight } from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import { setConnectionSecrets } from "../api";
import type { ConnectionStatus } from "../api";

interface ConfigureConnectionModalProps {
  connection: ConnectionStatus;
  /** Caller alias to save secrets for (defaults to "default") */
  caller?: string;
  onClose: () => void;
  onSecretsUpdated: (alias: string, secretsSet: Record<string, boolean>) => void;
}

export default function ConfigureConnectionModal({ connection, caller, onClose, onSecretsUpdated }: ConfigureConnectionModalProps) {
  // Track user changes (only modified fields are sent)
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [clearing, setClearing] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOptional, setShowOptional] = useState(false);

  const allSecretsSet = {
    ...connection.requiredSecretsSet,
    ...connection.optionalSecretsSet,
  };

  const handleChange = (name: string, value: string) => {
    setChanges((prev) => ({ ...prev, [name]: value }));
    // If user types into a field, un-clear it
    setClearing((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };

  const handleClear = (name: string) => {
    setClearing((prev) => new Set(prev).add(name));
    setChanges((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const handleUnclear = (name: string) => {
    setClearing((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  };

  const hasChanges = Object.keys(changes).some((k) => changes[k] !== "") || clearing.size > 0;

  const handleSave = async () => {
    if (!hasChanges) {
      onClose();
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // Build payload: typed values + cleared values (empty string = delete)
      const secrets: Record<string, string> = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value !== "") secrets[key] = value;
      }
      for (const name of clearing) {
        secrets[name] = "";
      }

      const result = await setConnectionSecrets(connection.alias, secrets, caller);
      onSecretsUpdated(connection.alias, result.secretsSet);
      setSaved(true);
      setTimeout(() => {
        onClose();
      }, 800);
    } catch (err: any) {
      setError(err.message || "Failed to save secrets");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalOverlay>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 0,
          maxWidth: 520,
          width: "calc(100% - 40px)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>{connection.name}</h2>
            {connection.description && (
              <p
                style={{
                  fontSize: 13,
                  color: "var(--text-muted)",
                  lineHeight: 1.5,
                }}
              >
                {connection.description}
              </p>
            )}
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: 8,
                flexWrap: "wrap",
              }}
            >
              {connection.docsUrl && (
                <a
                  href={connection.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 12,
                    color: "var(--accent)",
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <ExternalLink size={12} />
                  API Docs
                </a>
              )}
              {connection.hasIngestor && connection.ingestorType && (
                <span
                  style={{
                    fontSize: 11,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: "color-mix(in srgb, var(--accent) 10%, transparent)",
                    color: "var(--accent)",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 3,
                  }}
                >
                  <Radio size={10} />
                  {connection.ingestorType} ingestor
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              padding: 4,
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
              marginLeft: 12,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div
          style={{
            flex: 1,
            overflow: "auto",
            padding: "20px 24px",
          }}
        >
          {/* Required secrets */}
          {connection.requiredSecrets.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <h3
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: 12,
                }}
              >
                Required Secrets
              </h3>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                }}
              >
                {connection.requiredSecrets.map((name) => (
                  <SecretField
                    key={name}
                    name={name}
                    isCurrentlySet={allSecretsSet[name] ?? false}
                    isClearing={clearing.has(name)}
                    value={changes[name] ?? ""}
                    onChange={(v) => handleChange(name, v)}
                    onClear={() => handleClear(name)}
                    onUnclear={() => handleUnclear(name)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Optional secrets */}
          {connection.optionalSecrets.length > 0 && (
            <div>
              <button
                onClick={() => setShowOptional(!showOptional)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: 13,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginBottom: showOptional ? 12 : 0,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {showOptional ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Optional Secrets ({connection.optionalSecrets.length})
              </button>
              {showOptional && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 12,
                  }}
                >
                  {connection.optionalSecrets.map((name) => (
                    <SecretField
                      key={name}
                      name={name}
                      isCurrentlySet={allSecretsSet[name] ?? false}
                      isClearing={clearing.has(name)}
                      value={changes[name] ?? ""}
                      onChange={(v) => handleChange(name, v)}
                      onClear={() => handleClear(name)}
                      onUnclear={() => handleUnclear(name)}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* No secrets */}
          {connection.requiredSecrets.length === 0 && connection.optionalSecrets.length === 0 && (
            <div
              style={{
                textAlign: "center",
                padding: "24px 0",
                color: "var(--text-muted)",
                fontSize: 14,
              }}
            >
              This connection has no configurable secrets.
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {error && <span style={{ color: "var(--error)" }}>{error}</span>}
            {saved && !error && (
              <span
                style={{
                  color: "var(--success)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <Check size={14} />
                Saved
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={onClose}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
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
              disabled={saving || saved}
              style={{
                padding: "8px 20px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 500,
                background: saved ? "var(--success)" : "var(--accent)",
                color: "#fff",
                cursor: saving || saved ? "not-allowed" : "pointer",
                opacity: saving ? 0.7 : 1,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {saving && <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />}
              {saved ? "Saved" : saving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}

// ── Secret field component ──

function SecretField({
  name,
  isCurrentlySet,
  isClearing,
  value,
  onChange,
  onClear,
  onUnclear,
}: {
  name: string;
  isCurrentlySet: boolean;
  isClearing: boolean;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  onUnclear: () => void;
}) {
  const [showValue, setShowValue] = useState(false);

  const effectivelySet = isCurrentlySet && !isClearing;

  return (
    <div>
      {/* Label row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <label
          style={{
            fontSize: 13,
            fontFamily: "monospace",
            fontWeight: 500,
            color: "var(--text)",
          }}
        >
          {name}
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {effectivelySet && value === "" && (
            <>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--success)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                <Check size={10} />
                Set
              </span>
              <button
                onClick={onClear}
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  background: "transparent",
                  padding: "2px 6px",
                  borderRadius: 4,
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                }}
                title="Remove this secret"
              >
                Clear
              </button>
            </>
          )}
          {isClearing && (
            <button
              onClick={onUnclear}
              style={{
                fontSize: 11,
                color: "var(--warning)",
                background: "transparent",
                padding: "2px 6px",
                borderRadius: 4,
                cursor: "pointer",
                border: "1px solid color-mix(in srgb, var(--warning) 30%, var(--border))",
              }}
            >
              Will be cleared - Undo
            </button>
          )}
        </div>
      </div>

      {/* Input row */}
      <div style={{ position: "relative" }}>
        <input
          type={showValue ? "text" : "password"}
          value={isClearing ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            isClearing
              ? "(will be removed on save)"
              : effectivelySet
                ? "\u2022\u2022\u2022\u2022\u2022 (configured - enter new value to replace)"
                : "Enter value..."
          }
          disabled={isClearing}
          style={{
            width: "100%",
            padding: "9px 36px 9px 12px",
            borderRadius: 8,
            border: `1px solid ${isClearing ? "color-mix(in srgb, var(--warning) 30%, var(--border))" : "var(--border)"}`,
            background: isClearing ? "var(--bg-secondary)" : "var(--bg)",
            color: "var(--text)",
            fontSize: 13,
            fontFamily: "monospace",
            outline: "none",
            boxSizing: "border-box",
            opacity: isClearing ? 0.5 : 1,
          }}
        />
        {!isClearing && (
          <button
            onClick={() => setShowValue(!showValue)}
            style={{
              position: "absolute",
              right: 8,
              top: "50%",
              transform: "translateY(-50%)",
              background: "transparent",
              padding: 4,
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
            title={showValue ? "Hide value" : "Show value"}
          >
            {showValue ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
    </div>
  );
}
