/**
 * Every hostile key / item name the storage traversal tests throw — at the
 * service directly and over a real HTTP socket. None may validate.
 */
export const TRAVERSAL_MATRIX: readonly string[] = [
  "..",
  ".",
  "%2e%2e",
  "%2E%2E",
  "..%2f..%2fsecret",
  "a/b",
  "../secret",
  "a\\b",
  "..\\secret",
  "a\0b",
  "secret\0.png",
  ".hidden",
  ".env",
  "",
  " ",
  "x".repeat(200),
  // Unicode lookalikes: fullwidth full stops, one-dot leaders, fullwidth
  // solidus, division slash, Cyrillic 'а', and a trailing newline.
  "．．",
  "․․",
  "a／b",
  "a∕b",
  "аbc",
  "abc\n",
];
