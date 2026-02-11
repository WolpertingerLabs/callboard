import { useState } from "react";

interface Props {
  onLogin: () => void;
  serverError?: string;
}

export default function Login({ onLogin, serverError }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const disabled = !!serverError;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Login failed");
        setLoading(false);
        return;
      }
      onLogin();
    } catch {
      setError("Network error");
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 320 }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 24, textAlign: "center" }}>Claude Code</h1>
        {serverError && (
          <div
            style={{
              background: "color-mix(in srgb, var(--danger) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
              borderRadius: 10,
              padding: "12px 14px",
              fontSize: 13,
              color: "var(--danger)",
              marginBottom: 12,
              lineHeight: 1.5,
            }}
          >
            {serverError}
          </div>
        )}
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          disabled={disabled}
          style={{
            width: "100%",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            padding: "12px 14px",
            fontSize: 16,
            marginBottom: 12,
            opacity: disabled ? 0.5 : 1,
          }}
        />
        {error && <div style={{ color: "var(--danger)", fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <button
          type="submit"
          disabled={disabled || loading || !password}
          style={{
            width: "100%",
            background: disabled || loading || !password ? "var(--border)" : "var(--accent)",
            color: "#fff",
            padding: "12px",
            borderRadius: 10,
            fontSize: 15,
            fontWeight: 500,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {loading ? "Logging in..." : "Log in"}
        </button>
      </form>
    </div>
  );
}
