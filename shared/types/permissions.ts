export type PermissionLevel = "allow" | "ask" | "deny";

export interface DefaultPermissions {
  fileRead: PermissionLevel;
  fileWrite: PermissionLevel;
  codeExecution: PermissionLevel;
  webAccess: PermissionLevel;
}
