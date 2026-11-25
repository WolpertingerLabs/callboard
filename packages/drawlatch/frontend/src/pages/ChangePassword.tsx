import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { changePassword, type AuthError } from "../auth";

const MIN_LENGTH = 8;

export default function ChangePassword() {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  function clientValidate(): string | null {
    if (!currentPassword) return "Enter your current password.";
    if (newPassword.length < MIN_LENGTH) {
      return `New password must be at least ${MIN_LENGTH} characters.`;
    }
    if (newPassword !== confirmPassword) {
      return "New password and confirmation do not match.";
    }
    if (newPassword === currentPassword) {
      return "New password must differ from the current password.";
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (loading) return;
    setError("");
    setSuccess(false);

    const validationError = clientValidate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
      setLoading(false);
      // Per spec: do not force re-login; existing cookie remains valid.
      // Bounce back to Overview after a brief moment so the success
      // confirmation is visible.
      setTimeout(() => {
        navigate("/");
      }, 1500);
    } catch (err) {
      const authErr = err as AuthError;
      setError(authErr.message || "Could not change password");
      setLoading(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Change password</h1>
      </header>
      <div className="subtitle-meta auth-page-subtitle">
        Update the password for this drawlatch daemon. Other browsers will be
        signed out.
      </div>

      <form onSubmit={handleSubmit} className="auth-form-card" noValidate>
        <label className="auth-label" htmlFor="current-password">
          Current password
        </label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={loading}
          className="auth-input"
        />

        <label className="auth-label" htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={loading}
          minLength={MIN_LENGTH}
          className="auth-input"
        />
        <div className="auth-hint">
          Minimum {MIN_LENGTH} characters.
        </div>

        <label className="auth-label" htmlFor="confirm-password">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={loading}
          className="auth-input"
        />

        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        {success && (
          <div className="auth-success" role="status">
            Password updated.
          </div>
        )}

        <div className="auth-actions">
          <button
            type="submit"
            className="auth-submit"
            disabled={
              loading ||
              !currentPassword ||
              !newPassword ||
              !confirmPassword
            }
          >
            {loading ? "Updating…" : "Update password"}
          </button>
        </div>
      </form>
    </>
  );
}
