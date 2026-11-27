/**
 * Renders a `test_connection` / `test_ingestor` result. The HTTP call to the
 * admin API succeeding says nothing about the test: the verdict is the
 * result's own `success`. A connection with several tests (`google`) reports
 * `services`, rendered one line per service.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, X } from "lucide-react";
import { shortScope } from "./AuthSummary";
import { copyText } from "../utils/clipboard";

export interface TestOutcome {
  ok: boolean;
  label: string;
  detail?: string;
  services?: ServiceOutcome[];
  hint?: string;
  consentScopes?: string;
}

export interface ServiceOutcome {
  name: string;
  level?: string;
  ok: boolean;
  status?: number;
  notConsented?: boolean;
  skipped?: string;
  error?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function extractDetail(data: Record<string, unknown>): string | undefined {
  for (const key of ["error", "message", "description", "status"]) {
    const v = data[key];
    if (typeof v === "string" && v) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** Turn an admin API result into what the card shows. `what` names the test
 *  ("Test", "Listener test"). */
export function toOutcome(
  what: string,
  res: { ok: true; data: Record<string, unknown> } | { ok: false; error: string },
): TestOutcome {
  if (!res.ok) return { ok: false, label: `${what} failed`, detail: res.error };
  const data = res.data;
  const ok = data.success === true;
  const out: TestOutcome = {
    ok,
    label: `${what} ${ok ? "passed" : "failed"}`,
    detail: extractDetail(data),
  };
  const services = data.services;
  if (typeof services === "object" && services !== null) {
    out.services = Object.entries(services as Record<string, unknown>).map(
      ([name, raw]) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        return {
          name,
          ok: r.success === true,
          ...(str(r.level) !== undefined && { level: str(r.level) }),
          ...(typeof r.status === "number" && { status: r.status }),
          ...(r.notConsented === true && { notConsented: true }),
          ...(str(r.skipped) !== undefined && { skipped: str(r.skipped) }),
          ...(str(r.error) !== undefined && { error: str(r.error) }),
        };
      },
    );
    // Per-service lines carry the details; keep the top line to the mint error.
    out.detail = str(data.error);
  }
  if (str(data.hint)) out.hint = str(data.hint);
  if (str(data.consentScopes)) out.consentScopes = str(data.consentScopes);
  return out;
}

export function TestResultView({
  result,
  onDismiss,
}: {
  result: TestOutcome;
  onDismiss?: () => void;
}) {
  return (
    <div
      className={`dl-conn-result ${result.ok ? "dl-conn-result-ok" : "dl-conn-result-err"}`}
      role="status"
    >
      {result.ok ? (
        <Check size={14} className="dl-conn-result-icon" />
      ) : (
        <AlertTriangle size={14} className="dl-conn-result-icon" />
      )}
      <div className="dl-conn-result-text">
        <div className="dl-conn-result-label">{result.label}</div>
        {result.detail && (
          <div className="dl-conn-result-detail">{result.detail}</div>
        )}
        {result.services && result.services.length > 0 && (
          <ul className="dl-test-services" aria-label="Per-service results">
            {result.services.map((s) => (
              <li
                key={s.name}
                className={s.ok ? "dl-test-svc-ok" : "dl-test-svc-err"}
              >
                <span className="dl-test-svc-mark" aria-hidden="true">
                  {s.ok ? "✓" : "✗"}
                </span>
                <span className="sr-only">{s.ok ? "Passed:" : "Failed:"}</span>
                <span className="mono dl-test-svc-name">
                  {s.name}
                  {s.level && <> · {s.level}</>}
                </span>
                {s.status !== undefined && (
                  <span className="mono dl-test-svc-status">{s.status}</span>
                )}
                {s.notConsented && (
                  <span className="dl-test-svc-tag">not consented</span>
                )}
                {s.skipped && (
                  <span className="dl-test-svc-tag">skipped: {s.skipped}</span>
                )}
                {!s.ok && s.error && (
                  <span className="dl-test-svc-error">{s.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {result.hint && <div className="dl-conn-result-detail">{result.hint}</div>}
        {result.consentScopes && (
          <div className="dl-conn-result-detail">
            Consent scopes:{" "}
            <span className="mono">
              {result.consentScopes.split(" ").map(shortScope).join(" ")}
            </span>{" "}
            <CopyScopesButton text={result.consentScopes} />
          </div>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          className="dl-conn-result-close"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss result"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function CopyScopesButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  async function copy(): Promise<void> {
    const ok = await copyText(text);
    setState(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  }

  return (
    <button
      type="button"
      className={`dl-test-copy dl-tap-compact${state === "failed" ? " is-failed" : ""}`}
      title="Copy the full scope URLs, space-separated"
      onClick={() => void copy()}
    >
      {state === "copied" ? <Check size={10} aria-hidden="true" /> : <Copy size={10} aria-hidden="true" />}
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </span>
    </button>
  );
}
