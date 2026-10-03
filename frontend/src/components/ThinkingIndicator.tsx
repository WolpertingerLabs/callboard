import type { ReactNode } from "react";

/**
 * The "agent is working" row under a transcript: three bouncing dots
 * (`thinking-bounce` in index.css) followed by whatever status text the caller
 * passes.
 */
export default function ThinkingIndicator({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "12px 0",
        color: "var(--text-muted)",
        fontSize: 13,
      }}
    >
      <span style={{ display: "inline-flex", gap: 3 }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: "var(--accent)",
              display: "inline-block",
              animation: `thinking-bounce 1.4s ease-in-out ${i * 0.16}s infinite`,
            }}
          />
        ))}
      </span>
      {children}
    </div>
  );
}
