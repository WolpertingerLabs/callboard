/**
 * Console coverage for the errors an error boundary structurally cannot see.
 *
 * `ErrorBoundary` catches throws from render and from lifecycle methods. It does
 * not catch — and no React boundary does — errors from event handlers, from
 * `setTimeout`/`requestAnimationFrame`, from a rejected promise nobody caught,
 * or from anything outside the React tree entirely. Those are exactly the paths
 * this app spends most of its time in: click handlers, `fetch` chains, SSE
 * message handlers.
 *
 * This is deliberately the *cheap* half of that problem. It renders nothing and
 * recovers nothing — there is no component to replace, and a global "something
 * async failed" banner is a design question, not a one-liner. What it buys:
 *
 * - Both channels are logged through `console.error` with the same `[callboard]`
 *   prefix the boundary uses, so "search the console for callboard" is one
 *   instruction that covers render crashes and async ones alike.
 * - A rejection whose reason is an `Error` is logged as the object, so the
 *   console keeps the stack. Browsers already surface unhandled rejections, but
 *   the shape varies by engine and by whether devtools was open at the time.
 *
 * One quirk worth knowing before you read a console: React's **development**
 * build re-throws a boundary-caught render error at the window so devtools can
 * still break on it, so in dev a single crash prints twice — once here, once
 * from `ErrorBoundary`. Production builds use a plain try/catch and print only
 * the boundary's line. Hence the neutral wording: this handler cannot tell
 * whether something downstream caught the error, so it does not claim to.
 *
 * Idempotent: installing twice attaches one set of listeners, so a hot reload or
 * a second `main.tsx` evaluation in tests does not double every message.
 */

let installed = false;

export function installGlobalErrorLogging(target: Window = window): () => void {
  if (installed) return () => {};
  installed = true;

  const onRejection = (event: PromiseRejectionEvent) => {
    // eslint-disable-next-line no-console
    console.error("[callboard] Unhandled promise rejection — no error boundary can catch this:", event.reason);
  };

  const onError = (event: ErrorEvent) => {
    // eslint-disable-next-line no-console
    console.error("[callboard] Uncaught error reached the window:", event.error ?? event.message);
  };

  target.addEventListener("unhandledrejection", onRejection);
  target.addEventListener("error", onError);

  return () => {
    target.removeEventListener("unhandledrejection", onRejection);
    target.removeEventListener("error", onError);
    installed = false;
  };
}
