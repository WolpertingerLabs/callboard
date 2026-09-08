import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { BrowserContext, Page } from "playwright";
import { ComputerUseError, type Driver, type DriverSession, type Action } from "../contracts.js";
import { actionSchema } from "../validation.js";

export interface BrowserDriverOptions {
  headless?: boolean;
  /** Operator-selected executable only; not accepted from tool arguments. Never downloaded. */
  executablePath?: string;
  viewport?: { width: number; height: number };
  /** Default offline. Unrestricted requires operator consent; browser routing is NOT an OS firewall. */
  network?: "offline" | "unrestricted" | "externally-confined";
  /** Optional additional request filter, not a DNS/egress security boundary. Errors deny. */
  allowRequest?: (url: string) => boolean | Promise<boolean>;
}
export function createBrowserDriver(options: BrowserDriverOptions = {}): Driver {
  const config = { ...options, viewport: { ...(options.viewport ?? { width: 1280, height: 800 }) } };
  if (
    !Number.isInteger(config.viewport.width) ||
    !Number.isInteger(config.viewport.height) ||
    config.viewport.width < 1 ||
    config.viewport.height < 1 ||
    config.viewport.width > 4096 ||
    config.viewport.height > 4096
  )
    throw new ComputerUseError("invalid_request");
  const network = config.network ?? "offline";
  if (!["offline", "unrestricted", "externally-confined"].includes(network)) throw new ComputerUseError("invalid_request");
  const probe: Driver["probe"] = async () => {
    if (!["linux", "darwin", "win32"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) {
      return {
        available: false,
        kind: "browser",
        capabilities: [],
        reason: `Unsupported Chromium platform ${process.platform}/${process.arch}; configure a qualified external driver`,
      };
    }
    try {
      const { chromium } = await import("playwright");
      await access(config.executablePath ?? chromium.executablePath());
      return {
        available: true,
        kind: "browser",
        capabilities: ["screenshot", "pointer", "keyboard", "navigation", "persistent-session"],
        reason: "Executable found; sandbox support and launch/runtime qualification occur on open",
      };
    } catch {
      return {
        available: false,
        kind: "browser",
        capabilities: [],
        reason: "Install optional playwright and provision its Chromium executable (no automatic downloads)",
      };
    }
  };
  return {
    kind: "browser",
    probe,
    async open({ signal, onTargetChanged }) {
      signal.throwIfAborted();
      const { chromium } = await import("playwright");
      const profile = await mkdtemp(join(tmpdir(), "computer-use-browser-"));
      let context: BrowserContext | undefined;
      let closed = false;
      let active: Page;
      const buttons = new Set<"left" | "middle" | "right">();
      const keys = new Set<string>();
      const close = async () => {
        if (closed) return;
        closed = true;
        try {
          await context?.close();
        } finally {
          await rm(profile, { recursive: true, force: true });
        }
      };
      const abortOpen = () => {
        void close().catch(() => {});
      };
      signal.addEventListener("abort", abortOpen, { once: true });
      try {
        context = await chromium
          .launchPersistentContext(profile, {
            // Playwright otherwise defaults to --no-sandbox. Never weaken this on failure.
            chromiumSandbox: true,
            headless: config.headless ?? true,
            executablePath: config.executablePath,
            viewport: config.viewport,
            deviceScaleFactor: 1,
            acceptDownloads: false,
            serviceWorkers: "block",
            permissions: [],
            timeout: 25000,
            args: ["--disable-background-networking", "--disable-component-update", "--disable-extensions"],
          })
          .catch(() => {
            if (signal.aborted) throw new ComputerUseError("cancelled");
            // Do not expose raw browser diagnostics (paths, environment, or page data).
            throw new ComputerUseError(
              "unsupported",
              "Sandboxed Chromium launch failed. Provision a supported browser and its OS libraries; on Linux use a non-root user and permit Chromium's sandbox (user namespaces/seccomp or a supported sandbox helper). No unsandboxed fallback is permitted.",
            );
          });
        // Abort while launching may precede context creation; always close the late context.
        if (signal.aborted || closed) {
          await context.close();
          await rm(profile, { recursive: true, force: true });
          throw new ComputerUseError("cancelled");
        }
        context.setDefaultTimeout(10000);
        context.setDefaultNavigationTimeout(20000);
        await context.setOffline(network === "offline");
        await context.route("**/*", async (route) => {
          let permitted = false;
          try {
            const url = new URL(route.request().url());
            permitted =
              !closed && network !== "offline" && ["http:", "https:"].includes(url.protocol) && (!config.allowRequest || (await config.allowRequest(url.href)));
          } catch {
            /* Deny unknown protocols and failed policy. */
          }
          try {
            if (permitted && !closed) await route.continue();
            else await route.abort();
          } catch {
            /* Context may be closing. */
          }
        });
        await context.routeWebSocket("**/*", (ws) => ws.close());
        active = context.pages()[0] ?? (await context.newPage());
        const configure = (page: Page) => {
          // Playwright fires this for every iframe too; only a top-level
          // navigation moves the pixels an observed frame was captured from.
          // Invalidating on ad/embed iframes made observe → act permanently stale.
          page.on("framenavigated", (frame) => {
            if (frame === page.mainFrame()) onTargetChanged?.();
          });
          page.on("close", () => onTargetChanged?.());
          page.on("dialog", (dialog) => {
            void dialog.dismiss().catch(() => {});
          });
          page.on("download", (download) => {
            void download.cancel().catch(() => {});
          });
        };
        configure(active);
        context.on("page", (page) => {
          onTargetChanged?.();
          configure(page);
          active = page;
        });
        const page = () => {
          if (closed) throw new ComputerUseError("stopped");
          if (active.isClosed()) {
            const next = context!.pages().find((p) => !p.isClosed());
            if (!next) throw new ComputerUseError("stopped");
            active = next;
          }
          return active;
        };
        const releaseInput = async () => {
          if (!context || closed) return;
          // Release on every page: a popup can change active while a drag is in progress.
          for (const p of context.pages()) {
            for (const b of buttons) await p.mouse.up({ button: b }).catch(() => {});
            for (const k of keys) await p.keyboard.up(k).catch(() => {});
          }
          buttons.clear();
          keys.clear();
        };
        const run = async <T>(sig: AbortSignal, fn: () => Promise<T>): Promise<T> => {
          sig.throwIfAborted();
          const abort = () => {
            void releaseInput().catch(() => {});
          };
          sig.addEventListener("abort", abort, { once: true });
          try {
            const result = await fn();
            sig.throwIfAborted();
            return result;
          } finally {
            sig.removeEventListener("abort", abort);
            await releaseInput();
          }
        };
        const session: DriverSession = {
          releaseInput,
          close,
          observe: (sig) =>
            run(sig, async () => {
              const p = page();
              const png = await p.screenshot({ type: "png", timeout: 10000 });
              return {
                data: png.toString("base64"),
                mimeType: "image/png",
                width: config.viewport.width,
                height: config.viewport.height,
                capturedAt: Date.now(),
                url: p.url(),
              };
            }),
          act: (raw: Action, sig) =>
            run(sig, async () => {
              const action = actionSchema.parse(raw),
                p = page();
              switch (action.type) {
                case "click":
                  await p.mouse.move(action.x, action.y);
                  sig.throwIfAborted();
                  buttons.add(action.button ?? "left");
                  await p.mouse.down({ button: action.button ?? "left" });
                  sig.throwIfAborted();
                  await p.mouse.up({ button: action.button ?? "left" });
                  break;
                case "move":
                  await p.mouse.move(action.x, action.y);
                  break;
                case "drag":
                  await p.mouse.move(action.x, action.y);
                  sig.throwIfAborted();
                  buttons.add("left");
                  await p.mouse.down();
                  for (let i = 1; i <= 10; i++) {
                    sig.throwIfAborted();
                    await p.mouse.move(action.x + ((action.toX - action.x) * i) / 10, action.y + ((action.toY - action.y) * i) / 10);
                    await delay((action.durationMs ?? 200) / 10, undefined, { signal: sig });
                  }
                  await p.mouse.up();
                  break;
                case "scroll":
                  await p.mouse.wheel(action.deltaX, action.deltaY);
                  break;
                case "type":
                  await p.keyboard.insertText(action.text);
                  break;
                case "key":
                  for (const key of action.key.split("+")) {
                    sig.throwIfAborted();
                    keys.add(key);
                    await p.keyboard.down(key);
                  }
                  for (const key of [...keys].reverse()) await p.keyboard.up(key);
                  break;
                case "navigate":
                  if (network === "offline") throw new ComputerUseError("denied");
                  await p.goto(action.url, { waitUntil: "domcontentloaded" });
                  break;
                case "wait":
                  await delay(action.durationMs, undefined, { signal: sig });
                  break;
              }
            }),
        };
        return session;
      } catch (error) {
        await close();
        throw error;
      } finally {
        signal.removeEventListener("abort", abortOpen);
      }
    },
  };
}
