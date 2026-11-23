export * from "./contracts.js";
export { ComputerUseService, createComputerUseService } from "./service.js";
export { createBrowserDriver, type BrowserDriverOptions } from "./drivers/browser.js";
export { createNativeDesktopDriver, type NativeDesktopDriverOptions } from "./drivers/native.js";
export { createMcpServer, getToolDefinitions, type ToolDefinition } from "./mcp.js";
/**
 * The action grammar the service enforces, exported so a host can ask the same
 * question the service will — before it acts on the answer.
 *
 * Callboard needs it because it describes an action for its audit log *before*
 * running it (a process that dies mid-action must still leave a trace), and
 * that description is written from the action's own fields. Without the schema
 * it would be describing an unvalidated shape: the service's rejection comes
 * later, by which time the line is on disk. Answering "would this be accepted?"
 * is the only way to be sure the two agree.
 */
export { actionSchema } from "./validation.js";
export { createDriverHost, readTokenFile, type DriverHost, type DriverHostOptions } from "./remote/host.js";
export { createRemoteDriver, type RemoteDriver, type RemoteDriverOptions, type RemoteDriverSession } from "./remote/client.js";
export { PROTOCOL, HOST_CAPABILITIES, type HostIdentity, type HostCapability, type OutboxEntry, type OutboxFile } from "./remote/protocol.js";
export {
  ensureSandboxNetwork,
  sandboxNetworkCreateArgs,
  sandboxRunArgs,
  SANDBOX_IMAGE_LABELS,
  SANDBOX_NETWORK,
  SANDBOX_NETWORK_LABEL,
  SANDBOX_PROTOCOL_LABEL_VALUE,
  SANDBOX_CONTAINER_PORT,
  SANDBOX_DEFAULT_IMAGE,
  SANDBOX_DEFAULT_LIMITS,
  SANDBOX_TOKEN_PATH,
  type SandboxLimits,
  type SandboxRunOptions,
} from "./remote/sandbox.js";
