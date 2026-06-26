import { scorePassword, MIN_PASSWORD_LENGTH } from "../utils/passwordStrength";

interface PasswordStrengthMeterProps {
  password: string;
}

const SEGMENTS = 4;

/** Theme color var for a given score. Empty segments use --border. */
function colorForScore(score: number): string {
  switch (score) {
    case 4:
      return "var(--success)";
    case 3:
      return "var(--accent)";
    case 2:
      return "var(--warning)";
    default:
      return "var(--danger)"; // 0 (too short) and 1 (weak)
  }
}

/**
 * Advisory password strength indicator: a 4-segment bar + label. Renders nothing
 * for an empty field. When the password is non-empty but under the 8-char
 * minimum, it shows a "too short" hint (the submit button is gated separately).
 * Colors come exclusively from theme CSS variables (per project theming rules).
 */
export default function PasswordStrengthMeter({ password }: PasswordStrengthMeterProps) {
  if (!password) return null;

  const { score, label } = scorePassword(password);
  const tooShort = password.length < MIN_PASSWORD_LENGTH;
  const color = colorForScore(score);
  const filled = tooShort ? 0 : score;

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 4 }} aria-hidden>
        {Array.from({ length: SEGMENTS }).map((_, i) => (
          <span
            key={i}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background: i < filled ? color : "var(--border)",
              transition: "background 0.15s",
            }}
          />
        ))}
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color, display: "flex", justifyContent: "space-between" }}>
        <span>{tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters` : `Strength: ${label}`}</span>
      </div>
    </div>
  );
}
