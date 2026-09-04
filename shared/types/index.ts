export type { PermissionLevel, DefaultPermissions } from "./permissions.js";

export type { PluginCommand, PluginManifest, Plugin } from "./plugins.js";

export type {
  AppPlugin,
  McpServerConfig,
  PluginScanRoot,
  AppPluginsData,
  ScanResult,
  PluginHookEntry,
  PluginHookMatcher,
  PluginHooksConfig,
} from "./appPlugins.js";

export type { Chat, ChatListResponse, FolderSummary, FolderListResponse, ChatTreeAncestor, ChatTreeNode, ChatTreeResponse } from "./chat.js";

export type {
  Card,
  CardPatch,
  CardLifecycle,
  CardRollupState,
  CardPendingKind,
  CardMemberChat,
  CardChatActivity,
  CardMemberRun,
  CardSummary,
  CardListResponse,
  CardResponse,
} from "./card.js";
export { CARD_CATEGORY_MAX } from "./card.js";

export type { ActivityKind, ActivityCondition, ChatActivity, ConditionWatch, ChatActivityResponse } from "./activity.js";
export { WORKSPACE_NAME_MAX } from "./workspace.js";

export type {
  Workspace,
  WorkspacePayload,
  WorkspaceIsolation,
  WorkspaceWorktree,
  WorktreeMode,
  WorkspaceRemovalBlocker,
  WorkspaceRemovalReason,
  WorkspaceRemovability,
  WorkspaceIgnoredPreview,
  WorkspaceDirectoryState,
  WorkspaceDirectory,
  WorkspaceEntry,
  WorkspaceWithRemovability,
  WorkspaceRemovabilityResponse,
  WorktreeDisposition,
  WorktreeInspection,
  ArchiveWorkspaceResult,
  WorkspaceCleanliness,
  WorktreeNamingConvention,
  WorktreeNamingGuess,
  WorktreeDiskUsage,
  WorkspaceAdoptionRefusal,
  WorkspaceRefusalReason,
  UnmanagedWorktree,
  UnmanagedWorktreeListing,
  WorkspaceAdoptionOutcome,
  AdoptWorktreesResult,
  FolderWorkspaceRecord,
  WorkspaceListResponse,
  WorkspaceVerdictListResponse,
  WorkspaceCreationRefusal,
  CreateWorkspaceResult,
  TrashEntryView,
  TrashListing,
  TrashRestoreFailure,
  TrashRestoreBranchOutcome,
  TrashRestoreResult,
} from "./workspace.js";

export type { ParsedMessage } from "./message.js";

export type { TaskListItem } from "./taskList.js";
export { TASK_LIST_TOOLS, parseTaskList, isTaskListTool } from "./taskList.js";

export type { StoredImage, ImageUploadResult } from "./image.js";

export type { QueueItem } from "./queue.js";

export type { FolderItem, BrowseResult, ValidateResult, FolderSuggestion } from "./folders.js";

export type { StreamEvent } from "./stream.js";

export type { ClientCapability, ServerInfoEvent } from "./protocol.js";
export {
  PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_HEADER,
  CAPS_HEADER,
  CLIENT_CAPS,
  CLIENT_CAP_VALUES,
  SERVER_FEATURES,
  handshakeHeaders,
} from "./protocol.js";

export type { SlashCommand } from "./slashCommand.js";

export type { BranchConfig, DiffFileType, DiffFileEntry, GitDiffResponse } from "./git.js";
export { worktreeDirName } from "./git.js";

export type { SessionStatus } from "./session.js";

export type { BuildIdFile } from "./build.js";
export { DEV_BUILD_ID, UNKNOWN_BUILD_ID, BUILD_ID_FILENAME } from "./build.js";

export type { AgentConfig, SystemPromptSection, SystemMessagePreview } from "./agent.js";

export type {
  CronAction,
  CronJob,
  EventSubscription,
  ActivityEntry,
  Trigger,
  TriggerDebounce,
  TriggerFilter,
  FilterCondition,
  QuietHours,
} from "./agentFeatures.js";

export type { AgentSettings, KeyAliasInfo, EnrolledCaller, EnrolledCallerAgent } from "./agentSettings.js";

export type { CallerInfo, ConnectionStatus } from "./connections.js";

export type { CustomTheme, ThemeVariables, ThemeListItem, ThemeContrastReport, ThemeContrastFailure } from "./theme.js";

export type { CustomSkill, CustomSkillListItem } from "./customSkill.js";

export type { Keyword, KeywordsFile, KeywordCreateInput, KeywordUpdateInput } from "./keyword.js";

export type { McpToolParameter, McpToolDefinition, McpToolServerInfo, McpToolsResponse } from "./mcpTool.js";

export type { OpenRouterModelInfo, OpenRouterModelAliasInfo } from "./openrouter.js";

export type { CodexModelInfo } from "./codex.js";

export type { UiAgentProviderKind, EffortLevel, ProviderRunConfig } from "./providers.js";

export type {
  EngineRuntime,
  EngineOverrideState,
  EngineBinaryOverride,
  EngineVersionDrift,
  EngineBinaryCheckResponse,
  EngineCredentials,
  EngineCredentialState,
  EngineInstallMethod,
  EngineInstallRecipe,
  EngineInstallGuidance,
  EngineOneClickOffer,
  EngineInstallCapability,
  EngineInstallRefusalCode,
  EngineInstallStartResponse,
  EngineInstallRefusalResponse,
  EngineInstallStartedEvent,
  EngineInstallOutputEvent,
  EngineInstallExitEvent,
  EngineInstallVerifiedEvent,
  EngineInstallEvent,
  EngineStatus,
  EngineStatusResponse,
  EngineRefreshResponse,
} from "./engines.js";

export type { HarnessProvider, ModelAlias, ModelAliasInfo } from "./modelAlias.js";
export { HARNESS_PROVIDERS, validateModelAliases } from "./modelAlias.js";

export type {
  ContactChannel,
  UserContactInfo,
  NotifiableChannel,
  ContactChannelAvailability,
  UserContactAvailability,
} from "./userContact.js";
export { CONTACT_CHANNEL_CONNECTIONS } from "./userContact.js";

export type {
  JobStepType,
  JobInputDef,
  AgentJobStep,
  ApprovalJobStep,
  PollJobStep,
  WaitEventJobStep,
  JobGateOp,
  JobGateCondition,
  GateJobStep,
  NotifyJobStep,
  ParallelAgentBranch,
  ParallelJobStep,
  SubJobStep,
  JobStep,
  JobDefinition,
  JobDefinitionPayload,
  JobExportEnvelope,
  JobRunStatus,
  JobStepResult,
  JobRunHistoryEntry,
  JobRunActiveBranch,
  JobRunActiveStep,
  JobRun,
  JobRunListItem,
} from "./jobs.js";
