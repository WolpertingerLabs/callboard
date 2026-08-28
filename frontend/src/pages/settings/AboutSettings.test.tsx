// @vitest-environment jsdom
/**
 * Settings → About — which version it names, and when it decides there is
 * nothing to say.
 *
 * Small, and about one thing: this page owns the *gate*. `<UpdateBanner>` is
 * rendered behind a condition computed here, so whatever the banner can do is
 * irrelevant in every state this file decides not to render it in — and the
 * condition used to go false at the worst possible moment.
 *
 * `npm install -g` replaces Callboard's package tree in place. The daemon
 * reported the on-disk version as `version`, so the instant npm exited,
 * `isNewerVersion(version, latestVersion)` became false and this page unmounted
 * the banner — taking the verdict, the retry button and the whole reattach path
 * with it, in exactly the window they exist for. The daemon still had the old
 * code running.
 *
 * The banner itself is stubbed. What is under test is which props it is handed
 * and whether it is there at all; `UpdateBanner.test.tsx` covers what it renders
 * from them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { SystemInfo } from "../../api";

const mocks = vi.hoisted(() => ({ getSystemInfo: vi.fn(), getAgentSettings: vi.fn(), bannerProps: [] as Record<string, unknown>[] }));

vi.mock("../../api", () => ({ getSystemInfo: mocks.getSystemInfo, getAgentSettings: mocks.getAgentSettings }));

vi.mock("./UpdateBanner", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.bannerProps.push(props);
    return <div data-testid="update-banner" />;
  },
}));

const { default: AboutSettings } = await import("./AboutSettings");

const systemInfo = (extra: Partial<SystemInfo> = {}): SystemInfo =>
  ({
    version: "1.0.0",
    nodeVersion: "v22.0.0",
    platform: "linux (x64)",
    sdkVersion: "0.1.0",
    claudeCliVersion: "not installed",
    environment: "production",
    ...extra,
  }) as SystemInfo;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.bannerProps.length = 0;
  mocks.getAgentSettings.mockResolvedValue({ proxyMode: "local" });
});

afterEach(cleanup);

async function show(info: SystemInfo) {
  mocks.getSystemInfo.mockResolvedValue(info);
  render(<AboutSettings />);
  await waitFor(() => expect(screen.getByText("Application")).toBeTruthy());
}

describe("the update gate", () => {
  it("shows the banner when a newer release exists", async () => {
    await show(systemInfo({ latestVersion: "1.1.0" }));
    expect(screen.getByTestId("update-banner")).toBeTruthy();
  });

  it("shows nothing when the daemon is on the latest release", async () => {
    await show(systemInfo({ latestVersion: "1.0.0" }));
    expect(screen.queryByTestId("update-banner")).toBeNull();
  });

  it("keeps the banner while an install is on disk and the daemon has not restarted", async () => {
    // The middle of a deferred restart: `version` is what is running, so the
    // banner survives — which it did not when `version` was a fresh read of a
    // manifest npm had already replaced.
    await show(systemInfo({ latestVersion: "1.1.0", installedVersion: "1.1.0", restartPending: true }));
    expect(screen.getByTestId("update-banner")).toBeTruthy();
    expect(mocks.bannerProps[0]).toMatchObject({ currentVersion: "1.0.0", installedVersion: "1.1.0", restartPending: true });
  });

  it("shows the banner for a restart pending with no newer release to point at", async () => {
    // A *second* daemon sharing one global install. Its sibling upgraded to
    // npm's `latest`, so `hasUpdate` is false and this is the only condition
    // that can put the banner — and therefore any route to a restart — on
    // screen at all.
    await show(systemInfo({ latestVersion: "1.1.0", installedVersion: "1.1.0", restartPending: true, version: "1.0.0" }));
    expect(screen.getByTestId("update-banner")).toBeTruthy();

    cleanup();
    mocks.bannerProps.length = 0;
    await show(systemInfo({ version: "1.0.0", latestVersion: "1.0.0", installedVersion: "1.0.0", restartPending: true }));
    expect(screen.getByTestId("update-banner")).toBeTruthy();
  });
});

describe("the Application rows", () => {
  it("names the version the daemon is running", async () => {
    await show(systemInfo({ latestVersion: "1.1.0" }));
    expect(screen.getByText("Version")).toBeTruthy();
    expect(screen.getByText("1.0.0")).toBeTruthy();
  });

  it("names what is on disk separately, rather than passing it off as what is running", async () => {
    await show(systemInfo({ latestVersion: "1.1.0", installedVersion: "1.1.0", restartPending: true }));
    expect(screen.getByText("1.0.0")).toBeTruthy();
    expect(screen.getByText("Installed (pending restart)")).toBeTruthy();
    // Twice: the installed row and the "Latest Version" row, which happen to
    // agree here — the daemon has npm's latest on disk and is not running it.
    expect(screen.getAllByText("v1.1.0")).toHaveLength(2);
  });

  it("says nothing about a pending restart when there is not one", async () => {
    await show(systemInfo({ latestVersion: "1.1.0", installedVersion: "1.0.0" }));
    expect(screen.queryByText("Installed (pending restart)")).toBeNull();
  });
});
