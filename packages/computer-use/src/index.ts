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
export { PROTOCOL, HOST_CAPABILITIES, OUTBOX_NAME, type HostIdentity, type HostCapability, type OutboxEntry, type OutboxFile } from "./remote/protocol.js";
export {
  ensureSandboxNetwork,
  sandboxContentDigest,
  sandboxImageBuildArgs,
  sandboxPackageVersion,
  sandboxNetworkCreateArgs,
  sandboxRunArgs,
  SANDBOX_SECURITY_FLOOR,
  SANDBOX_IMAGE_LABELS,
  SANDBOX_NETWORK,
  SANDBOX_INTERNAL_NETWORK,
  SANDBOX_NETWORK_LABEL,
  SANDBOX_PROTOCOL_LABEL_VALUE,
  SANDBOX_CONTAINER_PORT,
  SANDBOX_DEFAULT_IMAGE,
  SANDBOX_DEFAULT_LIMITS,
  SANDBOX_TOKEN_PATH,
  type SandboxLimits,
  type SandboxRunOptions,
} from "./remote/sandbox.js";
export {
  PROFILE_ARCHITECTURES,
  PROFILE_COMPILER_VERSION,
  PROFILE_DOCKERFILE,
  PROFILE_EPILOGUE_MARKER,
  PROFILE_IMAGE_REPOSITORY,
  PROFILE_LABELS,
  PROFILE_LIMIT_BOUNDS,
  PROFILE_PACKAGES_DOCKERFILE,
  PROFILE_RECIPE_LIMITS,
  PROFILE_RECIPE_SCHEMA,
  PROFILE_SECURITY_FLOOR,
  PROFILE_SOFTWARE_GL_PACKAGES,
  ProfileRecipeError,
  SANDBOX_BUILDER_IMAGE,
  canonicalProfileRecipe,
  isProfileScopeKey,
  profileCompilerDigest,
  profileDownloadUrlProblem,
  profileEntryId,
  profileHomeHeadroomMb,
  profileMaxHomeMb,
  profileSupportsArchitecture,
  clampProfileLimits,
  compileProfile,
  isProfileName,
  parseProfileRecipe,
  profileImageBuildArgs,
  profileImageTag,
  profilePackagesBuildArgs,
  profilePackagesTag,
  profileRecipeDigest,
  validateProfileRecipe,
  type ClampedProfileLimits,
  type CompiledProfile,
  type ProfileArchitecture,
  type ProfileDownload,
  type ProfileScopeKey,
  type ProfileGl,
  type ProfileLimits,
  type ProfileRecipe,
  type ProfileUnpack,
} from "./remote/profile.js";
