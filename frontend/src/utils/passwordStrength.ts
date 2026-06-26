/**
 * Advisory password strength scoring for the Change Password UI.
 *
 * This is purely informational — the only ENFORCED rule (here and on the server)
 * is the 8-character minimum (`MIN_PASSWORD_LENGTH`). The user is liable for
 * choosing a strong password; the meter just nudges. No external dependency
 * (zxcvbn etc.) — a light length + character-class heuristic is enough.
 */

export const MIN_PASSWORD_LENGTH = 8;

export type StrengthLabel = "Too short" | "Weak" | "Fair" | "Good" | "Strong";

export interface PasswordStrength {
  /** 0 = too short (below the minimum); 1–4 = Weak→Strong. */
  score: 0 | 1 | 2 | 3 | 4;
  label: StrengthLabel;
}

/** Number of distinct character classes present (lower, upper, digit, symbol). */
function charClasses(pw: string): number {
  return [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
}

export function scorePassword(pw: string): PasswordStrength {
  if (!pw || pw.length < MIN_PASSWORD_LENGTH) {
    return { score: 0, label: "Too short" };
  }

  const classes = charClasses(pw);
  let points = 0;
  if (pw.length >= 12) points += 1;
  if (pw.length >= 16) points += 1;
  if (classes >= 3) points += 1;
  if (classes >= 4) points += 1;

  const score = Math.min(4, points + 1) as 1 | 2 | 3 | 4;
  const label = (["Weak", "Fair", "Good", "Strong"] as const)[score - 1];
  return { score, label };
}
