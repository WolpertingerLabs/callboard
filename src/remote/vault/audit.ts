/**
 * Vault audit events: a thin wrapper over audit-log.ts's appendDaemonEvent().
 *
 * Events always go to the **owner's** audit log and name the actor. Field
 * names are prefixed `vault.`. Callers pass names, ids, kinds and field
 * names only: never a value, a ciphertext, or key material. Vault code never
 * builds a path into the audit directory; audit-log.ts owns that.
 */
import { appendDaemonEvent } from '../audit-log.js';

export type VaultEventName =
  | 'vault.item.created'
  | 'vault.item.updated'
  | 'vault.item.deleted'
  | 'vault.reveal';

/** Fields every vault event may carry, unprefixed. */
export interface VaultEventFields {
  item: string;
  item_id: string;
  actor: string;
  via: string;
  kind?: string;
  exposure?: string;
  fields?: string[];
  changed?: string[];
  renamed_from?: string;
  grant_id?: string;
}

/** Render the line fields for `event` (exported for the canary test). */
export function vaultEventFields(
  owner: string,
  event: VaultEventName,
  fields: VaultEventFields,
): { 'drawlatch.event': string } & Record<string, unknown> {
  const line: { 'drawlatch.event': string } & Record<string, unknown> = {
    'drawlatch.event': event,
    'vault.owner': owner,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) line[`vault.${k}`] = v;
  }
  return line;
}

/** Append `event` to `owner`'s audit log. Rejects if the line isn't durably written. */
export async function appendVaultEvent(
  owner: string,
  event: VaultEventName,
  fields: VaultEventFields,
): Promise<void> {
  await appendDaemonEvent(owner, vaultEventFields(owner, event, fields));
}
