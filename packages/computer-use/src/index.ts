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
export { createDriverHost, type DriverHost, type DriverHostOptions } from "./remote/host.js";
export { createRemoteDriver, type RemoteDriver, type RemoteDriverOptions } from "./remote/client.js";
export type { HostIdentity, OutboxEntry, OutboxFile } from "./remote/protocol.js";
