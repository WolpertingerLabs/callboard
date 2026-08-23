import { useState } from "react";
import { AlertTriangle, RefreshCw, X, Terminal } from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import { checkClaudeStatus, type ClaudeAuthStatus } from "../api";

interface CodeLoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStatusChange: (status: ClaudeAuthStatus) => void;
  /** The status that opened this modal, so it can name the remedy that applies. */
  status?: ClaudeAuthStatus;
}

export default function CodeLoginModal({ isOpen, onClose, onStatusChange, status }: CodeLoginModalProps) {
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [latest, setLatest] = useState<ClaudeAuthStatus | undefined>(undefined);

  if (!isOpen) return null;

  // Whether this machine has a `claude` at all decides which of the two
  // remedies is real. Telling someone with no native CLI to run
  // `claude auth login` is the same defect as the modal appearing for an
  // API-key user in the first place: instructions for a state they are not in.
  const cliPath = (latest ?? status)?.cliPath;

  const handleCheckAgain = async () => {
    setChecking(true);
    setCheckError("");
    try {
      const next = await checkClaudeStatus();
      setLatest(next);
      onStatusChange(next);
      if (next.loggedIn) {
        onClose();
      } else {
        setCheckError(next.error || "Still no Claude credentials. Try one of the options above, then check again.");
      }
    } catch {
      setCheckError("Failed to check status. Please try again.");
    } finally {
      setChecking(false);
    }
  };

  const handleDismiss = () => {
    try {
      sessionStorage.setItem("claude-login-dismissed", "1");
    } catch {
      // sessionStorage may not be available
    }
    onClose();
  };

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 12,
          padding: 0,
          width: "90%",
          maxWidth: 480,
          border: "1px solid var(--border)",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 8,
              background: "var(--warning-bg)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <AlertTriangle size={20} style={{ color: "var(--warning)" }} />
          </div>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Claude Code Needs Credentials</h2>
          </div>
          <button
            onClick={handleDismiss}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              padding: 4,
              borderRadius: 6,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Dismiss"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "20px 24px" }}>
          <p
            style={{
              margin: "0 0 16px 0",
              fontSize: 14,
              color: "var(--text)",
              lineHeight: 1.6,
            }}
          >
            Callboard found no Claude credentials on the machine running the server — no API key or auth token in Settings, nothing in its environment
            {cliPath ? ", and no CLI login" : ""}. Chats cannot start until one of these exists.
          </p>

          {cliPath ? (
            <>
              <p style={{ margin: "0 0 8px 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
                Sign in with your subscription — open a terminal on that machine and run:
              </p>

              {/* Command block */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "12px 16px",
                  marginBottom: 16,
                }}
              >
                <Terminal size={16} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
                <code
                  style={{
                    fontFamily: '"SF Mono", Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Courier New", monospace',
                    fontSize: 14,
                    color: "var(--text)",
                    userSelect: "all",
                    flex: 1,
                  }}
                >
                  claude auth login
                </code>
              </div>
            </>
          ) : (
            <p style={{ margin: "0 0 16px 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              There is no native <code>claude</code> on that machine, so <code>claude auth login</code> is not a command it can run. Settings &rarr; API &rarr;
              Claude Code has the install command for the CLI, if you want that route.
            </p>
          )}

          <p
            style={{
              margin: "0 0 20px 0",
              fontSize: 13,
              color: "var(--text-muted)",
              lineHeight: 1.5,
            }}
          >
            Or set an API key or auth token under Settings &rarr; API &rarr; Claude Code, which authenticates chats without any CLI. Then click &ldquo;Check
            Again&rdquo;.
          </p>

          {/* Error message */}
          {checkError && (
            <div
              style={{
                color: "var(--warning)",
                fontSize: 13,
                marginBottom: 16,
                padding: "8px 12px",
                background: "var(--warning-bg)",
                borderRadius: 6,
                lineHeight: 1.4,
              }}
            >
              {checkError}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={handleDismiss}
              disabled={checking}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                fontSize: 14,
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                cursor: checking ? "default" : "pointer",
                opacity: checking ? 0.5 : 1,
              }}
            >
              Dismiss
            </button>

            <button
              type="button"
              onClick={handleCheckAgain}
              disabled={checking}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                fontSize: 14,
                background: "var(--accent)",
                color: "var(--text-on-accent)",
                border: "none",
                cursor: checking ? "default" : "pointer",
                opacity: checking ? 0.8 : 1,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <RefreshCw size={14} style={checking ? { animation: "spin 1s linear infinite" } : undefined} />
              {checking ? "Checking…" : "Check Again"}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}
