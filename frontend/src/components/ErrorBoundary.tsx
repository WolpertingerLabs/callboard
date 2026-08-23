import { Component, Fragment, type CSSProperties, type ErrorInfo, type ReactNode } from "react";

/**
 * The one thing standing between a bad render and a blank page.
 *
 * Before this component the app had no error boundary at all, which in React 18
 * means any throw during render or a lifecycle method unmounts the whole root:
 * sidebar, chat list, composer and the message you were half way through typing.
 * It is not theoretical — reviewing #364 an old tab talking to a newer daemon hit
 *
 *     TypeError: Cannot destructure property 'removable' of 'e.removability'
 *     root html length: 0
 *
 * from one row of one modal. #364 shipped a shim for that one field; the next
 * response-shape change gets the same hazard with no shim to hand.
 *
 * **Granularity is the point.** A single boundary at the root still blanks the
 * app, just politely. So this takes a `variant` and is mounted at three depths:
 *
 * - `root` — `main.tsx`, wrapping `<App/>`. The backstop nothing gets past. Its
 *   only offer is a reload, because if the tree failed this high there is no
 *   remaining subtree worth re-mounting.
 * - `region` — the sidebar and the main pane in `SplitLayout`. A crash here is
 *   contained to one column; the other one keeps working, so the fallback offers
 *   "Try again" (re-mount just this subtree) before it offers a reload. This is
 *   the **only** variant that gets that button, and the reason is structural:
 *   here the boundary owns the subtree, so clearing the error re-mounts
 *   `ChatList` / `FolderList` / `Chat` and their fetches re-run. A modal's
 *   `children` are built by the parent component, which sits *outside* the
 *   boundary and does not re-render when the boundary resets — the same broken
 *   element object comes straight back, so a retry there is a control that
 *   cannot ever do anything.
 * - `modal` — `ModalOverlay`, which is the single ancestor of ~16 dialogs
 *   including the workspace manager that produced the crash above. It also
 *   offers "Dismiss", which renders nothing at all: the dialog that threw took
 *   its own Escape handler and close button down with it, so without this the
 *   fallback would be a backdrop the user cannot get out of.
 *
 * **The modal seam catches descendant components only**, which is narrower than
 * it sounds. A dialog whose rows are real sub-components is covered — and
 * `WorkspaceManagerModal` is, since the `removability` reads live in `RecordRow`
 * inside the overlay, so the #364 case genuinely lands here. But a dialog whose
 * content is inline JSX in its own body (`ConfirmModal`, `DraftModal`) has
 * *nothing* inside the boundary: every throw happens while the parent renders,
 * before `<ModalOverlay>` mounts, and falls to the enclosing region instead.
 *
 * That fall-through is survivable rather than fatal, and worth knowing when
 * reading a report: with the fault still armed, "Try again" on the region
 * restores it, because re-mounting `FolderList` resets `showManager` to `false`
 * and the broken dialog is simply never constructed again. The layering is
 * doing the work there — which is the argument for having it rather than one
 * boundary in one clever place.
 *
 * **What this does not catch**, because React boundaries cannot: errors thrown
 * from event handlers, from `setTimeout`/`Promise` callbacks, from SSE handlers,
 * during SSR, or inside the boundary's own fallback. Those still reach
 * `window.onerror` / `unhandledrejection` — see `installGlobalErrorLogging` in
 * `utils/globalErrorLogging.ts`, which logs them but cannot render a fallback,
 * since there is no component to replace.
 */

export type BoundaryVariant = "root" | "region" | "modal";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * What is inside, phrased as a subject: "The sidebar", "This dialog". Used in
   * the fallback copy and in the console line, so a bug report says which seam
   * gave way without the reporter having to know the component tree.
   */
  region: string;
  variant?: BoundaryVariant;
  /**
   * Changing this clears a caught error and re-mounts the subtree. The main pane
   * passes the route path: navigating away from the chat that threw should not
   * leave its fallback sitting there over an unrelated page.
   */
  resetKey?: string | number;
  /**
   * Modal only: how the dialog is closed in the state of whoever opened it.
   *
   * Hiding the fallback is not enough on its own. `dismissed` is sticky for this
   * boundary instance, but the parent still holds `showManager === true`, so
   * clicking "Manage" again sets the same values, React bails out of the
   * re-render, and the user gets nothing at all — no overlay, no error, no
   * feedback. Routing Dismiss through the parent's own close handler puts that
   * state back where the next open can succeed.
   */
  onDismiss?: () => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Modal only: the user chose to close the broken dialog rather than retry. */
  dismissed: boolean;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, dismissed: false };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // React does log boundary-caught errors itself, in production as well as
    // dev — but only `console.error(error)`, bare. No component stack, and no
    // way to tell which seam gave way. This line carries the error object (for
    // its stack), the component stack, and the region name, so a report pasted
    // from a production console says where it broke as well as what broke.
    // eslint-disable-next-line no-console
    console.error(`[callboard] ${this.props.region} crashed during render:`, error, "\nComponent stack:", info.componentStack);
  }

  componentDidUpdate(prev: ErrorBoundaryProps) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.reset();
  }

  reset = () => {
    this.setState({ error: null, dismissed: false });
  };

  dismiss = () => {
    this.setState({ dismissed: true });
    // Closing it in the parent's state as well is what makes the dialog
    // re-openable; `dismissed` alone is a one-way door. See the prop.
    this.props.onDismiss?.();
  };

  reload = () => {
    window.location.reload();
  };

  render() {
    const { error, dismissed } = this.state;
    const { children, region, variant = "region" } = this.props;

    if (error && dismissed) return null;

    if (error) {
      const fallback = (
        <ErrorFallback
          region={region}
          variant={variant}
          error={error}
          onRetry={variant === "region" ? this.reset : undefined}
          onDismiss={variant === "modal" ? this.dismiss : undefined}
          onReload={this.reload}
        />
      );
      return variant === "modal" ? <div style={modalBackdropStyle}>{fallback}</div> : fallback;
    }

    // Clearing `error` is enough to get a *fresh mount* of the children, which
    // is what makes a region retry re-run its loaders. React unmounted this
    // subtree the moment the fallback rendered in its place, so coming back to
    // it is always a mount, never a re-render over the state that threw.
    //
    // This carried a bumped `key` for a while to force exactly that. It was
    // inert — verified by deleting it, which changed no behaviour and failed no
    // test, including the one that watches mount/unmount directly. Left out
    // rather than left in, so the next reader is not told a `key` is doing work
    // that React's own unmount-on-error already did.
    return <Fragment>{children}</Fragment>;
  }
}

/**
 * The backdrop `ModalOverlay` would have drawn, redeclared rather than imported.
 *
 * `ModalOverlay` imports this file; importing its style constant back would make
 * the cycle real. Eight lines of duplication is the cheaper of the two problems,
 * and both sides paint `--overlay-bg`, so a theme still moves them together.
 */
const modalBackdropStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--overlay-bg)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const buttonBase: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 6,
  fontSize: 14,
  cursor: "pointer",
  border: "1px solid var(--border)",
};

interface FallbackProps {
  region: string;
  variant: BoundaryVariant;
  error: Error;
  onRetry?: () => void;
  onDismiss?: () => void;
  onReload: () => void;
}

/**
 * Exported for the tests, which render it directly to assert on copy and on the
 * actions each variant offers without having to make a component throw first.
 */
export function ErrorFallback({ region, variant, error, onRetry, onDismiss, onReload }: FallbackProps) {
  // The stale-bundle case is the one that motivated all of this, and "reload"
  // is its fix — a user who is never told that has to guess it.
  const detail =
    variant === "root"
      ? "Reloading usually fixes it, especially if this tab has been open since before the server was updated."
      : "The rest of the app is still working. Reloading usually fixes it, especially if this tab has been open since before the server was updated.";

  return (
    <div role="alert" style={wrapStyle[variant]}>
      <div style={panelStyle}>
        <h2 style={{ margin: 0, fontSize: 16, color: "var(--danger)" }}>{region} stopped working</h2>
        <p style={{ margin: 0, fontSize: 14, color: "var(--text)", lineHeight: 1.5 }}>{detail}</p>

        <pre
          data-testid="error-boundary-message"
          style={{
            margin: 0,
            padding: "8px 10px",
            borderRadius: 6,
            background: "var(--code-bg)",
            border: "1px solid var(--border)",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {error.message || String(error)}
        </pre>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {onRetry && (
            <button type="button" onClick={onRetry} style={{ ...buttonBase, background: "var(--accent)", color: "var(--text-on-accent)", border: "none" }}>
              Try again
            </button>
          )}
          <button
            type="button"
            onClick={onReload}
            style={{
              ...buttonBase,
              background: onRetry ? "var(--bg-secondary)" : "var(--accent)",
              color: onRetry ? "var(--text)" : "var(--text-on-accent)",
              border: onRetry ? "1px solid var(--border)" : "none",
            }}
          >
            Reload page
          </button>
          {onDismiss && (
            <button type="button" onClick={onDismiss} style={{ ...buttonBase, background: "transparent", color: "var(--text-muted)" }}>
              Dismiss
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  width: "100%",
  maxWidth: 460,
  padding: 20,
  borderRadius: "var(--radius)",
  background: "var(--surface)",
  border: "1px solid var(--danger-border)",
  boxShadow: "var(--shadow-md)",
};

/**
 * Fills its column, and paints nothing.
 *
 * It used to set `background: var(--bg)`, which is the *main pane's* token —
 * over the sidebar, whose column is `--bg-sidebar`, that showed up in dark mode
 * as a visibly lighter panel. There is no one right token here because one
 * wrapper serves both columns, and there does not need to be: the column behind
 * it already paints the correct one, and on mobile `body` paints `--bg`. So the
 * fallback inherits instead of guessing.
 */
const regionWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  height: "100%",
  minHeight: 0,
  overflow: "auto",
};

const rootWrapStyle: CSSProperties = {
  ...regionWrapStyle,
  position: "fixed",
  inset: 0,
  height: "100vh",
};

/**
 * Transparent and auto-height, unlike its siblings. The modal fallback is
 * already sitting on the dimmed backdrop this file draws; painting `--bg`
 * behind it — and stretching to `height: 100%` — put an opaque white column
 * down the middle of the app, which is how the browser pass caught it.
 */
const modalWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
  width: "100%",
};

const wrapStyle: Record<BoundaryVariant, CSSProperties> = {
  root: rootWrapStyle,
  region: regionWrapStyle,
  modal: modalWrapStyle,
};
