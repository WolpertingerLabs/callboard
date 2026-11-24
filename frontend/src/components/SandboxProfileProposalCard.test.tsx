/**
 * The Sandbox desktop profile proposal card: what a human reads before
 * approving a build an agent proposed. The risky parts come first, the
 * agent's note is boxed as its own words, nothing it wrote is rendered as
 * markup, and a malformed card can only be refused.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SANDBOX_PROFILE_PROPOSE_TOOL_NAME } from "shared/types/index.js";
import FeedbackPanel from "./FeedbackPanel";

afterEach(cleanup);

const recipe = (setup: string, cpus: number) =>
  JSON.stringify({ schema: 1, name: "eyes", description: "xeyes", packages: ["x11-apps"], setup, limits: { cpus } }, null, 2);
const limits = { cpus: 1, memoryMb: 1024, homeMb: 512, sessionMinutes: 15 };
const input = {
  name: "eyes",
  version: 2,
  digest: "ab".repeat(32),
  scope: { kind: "folder", key: "w0123456789ab", label: "the folder /work/a" },
  recipe: recipe("echo two\n", 2),
  previous: { version: 1, digest: "cd".repeat(32), state: "approved", recipe: recipe("echo one\n", 2) },
  note: "<img src=x onerror=alert(1)> please approve",
  review: {
    description: "xeyes",
    setup: "echo two\n",
    setupLines: 1,
    downloads: [{ host: "example.com", url: "https://example.com/a.tgz", sha256: "e".repeat(64), dest: "a", unpack: "tar.gz" }],
    hosts: ["example.com"],
    packages: ["x11-apps"],
    gl: "software",
    architectures: ["amd64"],
    requested: { cpus: 64 },
    limits: { ...limits, cpus: 4 },
    clamped: ["cpus"],
    caps: { cpus: 4, memoryMb: 8192, homeMb: 4096, sessionMinutes: 120 },
    path: [],
    env: {},
  },
};
const action = (over: Record<string, unknown> = {}) => ({
  type: "permission_request" as const,
  toolName: SANDBOX_PROFILE_PROPOSE_TOOL_NAME,
  humanOnly: true,
  controlRequest: true,
  requestId: "prompt-1",
  nonBlocking: true,
  input,
  ...over,
});

it("shows the setup script, download hosts, packages, limits vs caps, architectures and scope", () => {
  render(<FeedbackPanel action={action()} onRespond={() => {}} />);
  expect(screen.getByTestId("profile-proposal-card")).toBeTruthy();
  expect(screen.getByTestId("proposal-setup").textContent).toContain("runs at build time as the desktop user, with no network");
  expect(screen.getByTestId("proposal-setup").textContent).toContain("echo two");
  expect(screen.getByTestId("proposal-downloads").textContent).toContain("from example.com");
  expect(screen.getByTestId("proposal-packages").textContent).toContain("Debian packages: 1");
  const limitsText = screen.getByTestId("proposal-limits").textContent!;
  expect(limitsText).toContain("capped at 4");
  expect(limitsText).toContain("count toward the memory limit");
  expect(screen.getByText(/Architectures:/).parentElement!.textContent).toContain("amd64");
  expect(screen.getByTestId("proposal-scope").textContent).toContain("the folder /work/a");
  expect(screen.getByText("agent-built")).toBeTruthy();
});

it("diffs against the previous version", () => {
  render(<FeedbackPanel action={action()} onRespond={() => {}} />);
  // The setup script is diffed on its own, line by line, not as one escaped JSON string.
  const setup = screen.getByTestId("proposal-diff-setup");
  expect([...setup.querySelectorAll("[data-op='remove']")].map((row) => row.textContent)).toEqual(["- echo one"]);
  expect([...setup.querySelectorAll("[data-op='add']")].map((row) => row.textContent)).toEqual(["+ echo two"]);
  expect(screen.getByText("No other field changed.")).toBeTruthy();
  expect(screen.queryByTestId("proposal-diff-fields")).toBeNull();
  expect(screen.getByText(/Changes since version 1/)).toBeTruthy();
});

it("says 'New profile' when there is no earlier version", () => {
  const { previous: _previous, ...fresh } = input;
  render(<FeedbackPanel action={action({ input: fresh })} onRespond={() => {}} />);
  expect(screen.getByText("New profile")).toBeTruthy();
  expect(screen.queryByTestId("proposal-diff")).toBeNull();
});

it("marks the agent's note as its own untrusted words, as plain text", () => {
  const { container } = render(<FeedbackPanel action={action()} onRespond={() => {}} />);
  const note = screen.getByTestId("proposal-note");
  expect(note.textContent).toContain("its own words, not checked by Callboard");
  expect(note.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(container.querySelector("img")).toBeNull();
});

it("answers with Approve & build or Refuse", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={action()} onRespond={onRespond} />);
  fireEvent.click(screen.getByText("Approve & build"));
  fireEvent.click(screen.getByText("Refuse"));
  expect(onRespond.mock.calls).toEqual([[true], [false]]);
});

it("disables Approve while a just-replaced card is locked", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={action()} onRespond={onRespond} approveLocked />);
  fireEvent.click(screen.getByText("Approve & build"));
  expect(onRespond).not.toHaveBeenCalled();
});

it("a malformed card can only be refused, never shown as a generic Allow prompt", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={action({ input: { name: "eyes" } })} onRespond={onRespond} />);
  expect(screen.queryByText("Allow")).toBeNull();
  expect(screen.queryByText("Approve & build")).toBeNull();
  fireEvent.click(screen.getByText("Refuse"));
  expect(onRespond).toHaveBeenCalledWith(false);
});

it("is the proposal card only when the host raised it (human-only, control request)", () => {
  render(<FeedbackPanel action={action({ humanOnly: undefined, controlRequest: undefined })} onRespond={() => {}} />);
  expect(screen.queryByTestId("profile-proposal-card")).toBeNull();
});

it("shows a one-line change in a long script as that line, with the unchanged runs folded", () => {
  const script = (changed: string) => Array.from({ length: 40 }, (_, i) => (i === 20 ? changed : `echo line ${i}`)).join("\n") + "\n";
  const long = { ...input, recipe: recipe(script("echo NEW"), 2), previous: { ...input.previous, recipe: recipe(script("echo old"), 2) } };
  render(<FeedbackPanel action={action({ input: long })} onRespond={() => {}} />);
  const setup = screen.getByTestId("proposal-diff-setup");
  expect([...setup.querySelectorAll("[data-op='remove']")].map((row) => row.textContent)).toEqual(["- echo old"]);
  expect([...setup.querySelectorAll("[data-op='add']")].map((row) => row.textContent)).toEqual(["+ echo NEW"]);
  expect([...setup.querySelectorAll("[data-op='fold']")].map((row) => row.textContent!.trim())).toEqual(["… 17 unchanged lines", "… 16 unchanged lines"]);
});

it("puts the agent's note after the risky parts and the diff, just above the buttons", () => {
  render(<FeedbackPanel action={action()} onRespond={() => {}} />);
  const order = (a: Element, b: Element) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
  const note = screen.getByTestId("proposal-note");
  for (const id of ["proposal-setup", "proposal-downloads", "proposal-packages", "proposal-limits", "proposal-diff"])
    expect(order(screen.getByTestId(id), note)).toBeTruthy();
  expect(order(note, screen.getByText("Approve & build"))).toBeTruthy();
});
