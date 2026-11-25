import { useEffect, useRef, useState } from "react";
import { login, type AuthError } from "../auth";

interface Props {
  onLogin: () => void;
  serverError?: string;
}

export default function Login({ onLogin, serverError }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const disabled = !!serverError;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (loading || disabled) return;
    setError("");
    setLoading(true);
    try {
      await login(password);
      // Don't keep the password in component state any longer than needed.
      setPassword("");
      onLogin();
    } catch (err) {
      const authErr = err as AuthError;
      setError(authErr.message || "Login failed");
      setPassword("");
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="auth-screen">
      <form onSubmit={handleSubmit} className="auth-card" noValidate>
        <div className="auth-brand">
          <span className="sidebar-brand-mark" aria-hidden="true" />
          <span>drawlatch</span>
        </div>
        <h1 className="auth-title">Sign in</h1>

        {serverError && (
          <div className="auth-banner auth-banner-error" role="alert">
            {serverError}
          </div>
        )}

        <label className="auth-label" htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          ref={inputRef}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={disabled || loading}
          className="auth-input"
        />

        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="auth-submit"
          disabled={disabled || loading || !password}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
