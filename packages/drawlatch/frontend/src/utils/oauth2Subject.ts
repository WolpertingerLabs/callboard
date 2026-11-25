/**
 * The daemon's subject rule, mirrored for the Google editor's inline check:
 * `isValidOAuth2Subject` in src/shared/connections.ts (an email address, at
 * most 320 characters, no whitespace or control characters). Not stricter:
 * the daemon decides, and src/shared/oauth2-subject-mirror.test.ts keeps the
 * two equal.
 */
export function isValidOAuth2Subject(subject: unknown): subject is string {
  return (
    typeof subject === "string" &&
    subject.length <= 320 &&
    // eslint-disable-next-line no-control-regex -- refusing control characters is the point
    /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+$/.test(subject)
  );
}
