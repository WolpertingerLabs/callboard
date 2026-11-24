/**
 * Test doubles for managed Sandbox desktops: an in-memory Docker CLI (the
 * subset sandbox-containers.ts runs, answering as the real CLI does) and a
 * fake remote driver factory. Shared by the manager and host tests.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ComputerUseError, type RemoteDriver, type RemoteDriverOptions } from "@wolpertingerlabs/computer-use";
import { DockerError, type DockerRunner } from "../sandbox-image.js";

export interface FakeContainer {
  id: string;
  name: string;
  labels: Record<string, string>;
  running: boolean;
  /** `docker pause`d: frozen, still there. */
  paused?: boolean;
  network?: string;
  published: boolean;
  /** The host port Docker assigned, once asked (stable, as Docker's is). */
  port?: number;
  tokenFile?: string;
  args: string[];
}

export function fakeDocker(
  options: {
    imageLabels?: Record<string, string> | null;
    /** Ignore `--filter` on `ps`, as a buggy or hostile Docker might: the manager must still check labels itself. */
    ignoreFilters?: boolean;
  } = {},
) {
  const containers = new Map<string, FakeContainer>();
  const networks = new Map<string, { Driver: string; Internal: boolean; Options: Record<string, string>; Labels: Record<string, string> }>();
  const state = {
    containers,
    networks,
    calls: [] as string[][],
    reachable: true,
    imageLabels:
      options.imageLabels === undefined
        ? { "dev.callboard.computer-use.protocol": "2.0", "org.opencontainers.image.version": "0.1.0", "dev.callboard.computer-use.security-floor": "1" }
        : options.imageLabels,
    /** Make `docker rm` fail (the daemon refusing), e.g. to check a session directory is kept. */
    rmFailure: undefined as string | undefined,
    /** Make `docker run` fail, e.g. with a port clash. */
    runFailure: undefined as string | undefined,
    /** Containers exit straight after starting. */
    exitOnStart: false,
    /** Make `docker pause` fail. */
    pauseFailure: undefined as string | undefined,
    nextPort: 40000,
    /** Images by reference, with an ID and labels (a profile, say); anything else answers with `imageLabels`. */
    images: new Map<string, { id: string; labels: Record<string, string> }>(),
    /** The ID every other image (the base) reports. */
    baseImageId: `sha256:${"0".repeat(64)}`,
  };
  const find = (ref: string) => containers.get(ref) ?? [...containers.values()].find((c) => c.id === ref || c.id.startsWith(ref));
  const noSuch = (what: string, ref: string) => new DockerError("failed", `docker failed`, `Error response from daemon: No such ${what}: ${ref}`);
  const run: DockerRunner = async (argv) => {
    const args = [...argv];
    state.calls.push(args);
    if (!state.reachable)
      throw new DockerError("unreachable", "The Docker daemon is not reachable", "Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
    const [command, sub] = args;
    if (command === "version") return "29.1.3\n";
    if (command === "image" && sub === "inspect") {
      const ref = args.at(-1)!;
      const format = args[args.indexOf("--format") + 1] ?? "";
      const image =
        state.images.get(ref) ??
        (state.imageLabels === null || ref.includes("computer-use-profile") ? undefined : { id: state.baseImageId, labels: state.imageLabels });
      if (!image) throw noSuch("image", ref);
      if (format === "{{.Id}}") return `${image.id}\n`;
      if (format.startsWith("{{json .Config.Labels}}\t")) return `${JSON.stringify(image.labels)}\t${image.id}\t2026-11-24T00:00:00Z\t123456789\n`;
      return `${JSON.stringify(image.labels)}\n`;
    }
    if (command === "network" && sub === "inspect") {
      const network = networks.get(args[2]);
      if (!network) throw noSuch("network", args[2]);
      return JSON.stringify([network]);
    }
    if (command === "network" && sub === "create") {
      const labels: Record<string, string> = {};
      const opts: Record<string, string> = {};
      args.forEach((arg, i) => {
        if (args[i - 1] === "--label") labels[arg.split("=")[0]] = arg.split("=").slice(1).join("=");
        if (args[i - 1] === "--opt") opts[arg.split("=")[0]] = arg.split("=").slice(1).join("=");
      });
      networks.set(args.at(-1)!, { Driver: "bridge", Internal: args.includes("--internal"), Options: opts, Labels: labels });
      return `${randomBytes(32).toString("hex")}\n`;
    }
    if (command === "run") {
      if (state.runFailure) throw new DockerError("failed", `docker run failed: ${state.runFailure}`, state.runFailure);
      const name = args[args.indexOf("--name") + 1];
      const labels: Record<string, string> = {};
      args.forEach((arg, i) => {
        if (args[i - 1] === "--label") labels[arg.split("=")[0]] = arg.split("=").slice(1).join("=");
      });
      const mount = args[args.indexOf("--mount") + 1] ?? "";
      const container: FakeContainer = {
        id: randomBytes(32).toString("hex"),
        name,
        labels,
        running: !state.exitOnStart,
        network: args.find((arg) => arg.startsWith("--network="))?.slice("--network=".length),
        published: args.includes("--publish"),
        tokenFile: /source=([^,]+)/.exec(mount)?.[1],
        args,
      };
      // --rm: an exited container is gone.
      if (!state.exitOnStart) containers.set(name, container);
      return `${container.id}\n`;
    }
    if (command === "port") {
      const container = find(args[1]);
      if (!container) throw noSuch("container", args[1]);
      if (!container.published) throw new DockerError("failed", "docker port failed", `no public port '7801/tcp' published for ${args[1]}`);
      container.port ??= state.nextPort++;
      return `127.0.0.1:${container.port}\n`;
    }
    if (command === "inspect") {
      const container = find(args.at(-1)!);
      if (!container) throw noSuch("container", args.at(-1)!);
      const format = args[args.indexOf("--format") + 1];
      if (format === "{{.State.Running}}") return `${container.running}\n`;
      if (format === "{{.State.Status}}") return `${container.paused ? "paused" : container.running ? "running" : "exited"}\n`;
      if (format === "{{json .NetworkSettings.Networks}}") return `${JSON.stringify({ [container.network!]: { IPAddress: "172.30.0.5" } })}\n`;
      throw new Error(`unexpected inspect format ${format}`);
    }
    if (command === "pause" || command === "unpause") {
      const container = find(args[1]);
      if (!container) throw noSuch("container", args[1]);
      if (command === "pause" && state.pauseFailure) throw new DockerError("failed", "docker pause failed", state.pauseFailure);
      if (command === "pause" && container.paused) throw new DockerError("failed", "docker pause failed", `Container ${args[1]} is already paused`);
      if (command === "unpause" && !container.paused) throw new DockerError("failed", "docker unpause failed", `Container ${args[1]} is not paused`);
      container.paused = command === "pause";
      return `${args[1]}\n`;
    }
    if (command === "rm") {
      if (state.rmFailure) throw new DockerError("failed", `docker rm failed: ${state.rmFailure}`, state.rmFailure);
      const ref = args.at(-1)!;
      const container = find(ref);
      if (!container) throw noSuch("container", ref);
      containers.delete(container.name);
      return `${ref}\n`;
    }
    if (command === "ps") {
      const filters = args
        .map((arg, i) => (args[i - 1] === "--filter" ? arg : undefined))
        .filter((f): f is string => !!f)
        .map((f) => f.slice("label=".length).split("="));
      const rows = [...containers.values()].filter((c) => options.ignoreFilters || filters.every(([k, v]) => c.labels[k] === v));
      if (args.includes("--quiet")) return rows.map((c) => `${c.id.slice(0, 12)}\n`).join("");
      const format = args[args.indexOf("--format") + 1];
      return rows
        .map(
          (c) =>
            `${format
              .replace("{{.ID}}", c.id)
              .replace("{{.State}}", c.paused ? "paused" : c.running ? "running" : "exited")
              .replace(/\{\{\.Label "([^"]+)"\}\}/g, (_m, key: string) => c.labels[key] ?? "")}\n`,
        )
        .join("");
    }
    throw new Error(`fake docker: unexpected ${args.join(" ")}`);
  };
  /** A container somebody else started: another owner, or none of our labels. */
  const foreign = (name: string, labels: Record<string, string>) => {
    const container: FakeContainer = { id: randomBytes(32).toString("hex"), name, labels, running: true, published: true, args: [] };
    containers.set(name, container);
    return container;
  };
  return { run, state, foreign };
}

export interface FakeRemoteBehaviour {
  /** `/hello` fails this many times before answering. */
  helloFailures?: number;
  /** `/hello` never answers (until aborted). */
  neverAnswers?: boolean;
  /** The host answers the proof wrongly (a squatter on the port). */
  denies?: boolean;
  /** The session opens on another instance than the one that said hello. */
  openOn?: string;
  /** `/hello` waits for this before answering: holds a start mid-way. */
  gate?: Promise<unknown>;
}

export function fakeRemote(behaviour: FakeRemoteBehaviour = {}) {
  const created: (RemoteDriverOptions & { tokenAtCreation: string })[] = [];
  /** One host instance per URL, as one container is: a second driver on the same URL (a new daemon) meets the same instance. */
  const instances = new Map<string, string>();
  const lost = new Map<string, () => void>();
  const closed: string[] = [];
  const factory = (options: RemoteDriverOptions): RemoteDriver => {
    created.push({ ...options, tokenAtCreation: options.tokenFile ? readFileSync(options.tokenFile, "utf8") : "" });
    const instanceId = instances.get(options.url) ?? randomUUID();
    instances.set(options.url, instanceId);
    const opened = new Map<string, string>();
    let hellos = 0;
    return {
      kind: "native-desktop",
      lockDomain: `remote-desktop:${options.url}`,
      endpoint: new URL(options.url).host,
      probe: async () => ({ available: true, kind: "native-desktop", capabilities: [] }),
      identity: async (signal?: AbortSignal) => {
        hellos++;
        if (behaviour.denies) throw new ComputerUseError("denied", "Driver host failed the proof");
        if (behaviour.neverAnswers)
          await new Promise((_resolve, reject) => {
            if (signal?.aborted) reject(new ComputerUseError("cancelled"));
            signal?.addEventListener("abort", () => reject(new ComputerUseError("cancelled")), { once: true });
          });
        if (hellos <= (behaviour.helloFailures ?? 0)) throw new ComputerUseError("driver_error", "connection refused");
        if (behaviour.gate) await behaviour.gate;
        return { instanceId, protocol: { major: 2, minor: 0 }, capabilities: [], heartbeatMs: 5000, hostname: "sandbox" };
      },
      open: async (context: { sessionId: string; onLost?: () => void }) => {
        const on = behaviour.openOn ?? instanceId;
        opened.set(context.sessionId, on);
        if (context.onLost) lost.set(context.sessionId, context.onLost);
        return {
          instanceId: on,
          observe: async () => ({ data: "AA==", mimeType: "image/png" as const, width: 100, height: 100, capturedAt: Date.now() }),
          act: async () => {},
          releaseInput: async () => {},
          close: async () => {
            opened.delete(context.sessionId);
            closed.push(context.sessionId);
          },
        };
      },
      openedInstance: (sessionId: string) => opened.get(sessionId),
      listOutbox: async () => [],
      downloadOutboxFile: async () => {
        throw new ComputerUseError("not_found");
      },
    } as unknown as RemoteDriver;
  };
  return { factory, created, lost, closed, instances };
}
