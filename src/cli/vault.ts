/**
 * `drawlatch vault list` and `drawlatch vault git-credential`.
 *
 * Both talk to the daemon only as a caller, through the same encrypted
 * channel the local MCP server uses (`../mcp/client.ts`): the caller's own
 * keys under the config dir and `proxy.config.json`'s `remoteUrl`. They call
 * the ordinary `vault_list` and `vault_get` tools, so the CLI can print only
 * what `vault_get` already returns to that caller: its own `reveal` items, or
 * items granted to it at `reveal`. Nothing here reads the vault files, the
 * vault key, or the admin password, and nothing writes a value anywhere.
 *
 * Errors go to stderr and never include a value.
 */

import { parseArgs } from 'node:util';

import { createChannelClient, type ChannelClient } from '../mcp/client.js';

/** Caller aliases, as `CALLER_ALIAS_REGEX` in caller-bootstrap.ts. */
const ALIAS_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
/** Item names, as the vault's `NAME_REGEX`. */
const ITEM_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
/** What `vault_get` records as `vault.via` for the helper. */
export const GIT_CREDENTIAL_PURPOSE = 'git-credential';
/** git's answer when the item has no `username` and none is given. */
const DEFAULT_GIT_USERNAME = 'x-access-token';
/** git sends a few short lines; refuse anything that isn't that. */
const MAX_STDIN_BYTES = 64 * 1024;

export interface VaultCliIO {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Opens the channel as `callerAlias` (default: `MCP_KEY_ALIAS`, else "default"). */
  connect?: (callerAlias: string | undefined) => ChannelClient;
}

class CliError extends Error {}

const VAULT_HELP = `
drawlatch vault

Use your vault from a shell, as a caller (the same keys and daemon URL as the
local MCP server). Prints only what vault_get would return to that caller.

Usage:
  drawlatch vault list [--caller <alias>]
  drawlatch vault git-credential --item <name> [--owner <alias>] [--caller <alias>]
                                 [--username <u>] [--host <host>] <get|store|erase>

Subcommands:
  list             Your items (name, kind, exposure, field names) and the items
                   shared with you (owner/name, kind, mode). Never values.
  git-credential   A git credential helper that answers from one vault item.
                   Only "reveal" items work: your own, or one granted to you
                   at mode "reveal". Each use is audit-logged with
                   via "git-credential".

Options:
  --caller <alias>   Caller identity (keys/callers/<alias>/); default
                     MCP_KEY_ALIAS, else "default"
  --item <name>      git-credential: the vault item holding the token or password
  --owner <alias>    git-credential: read another caller's item shared with you
  --username <u>     git-credential: username to send when the item has no
                     "username" field (default "x-access-token")
  --host <host>      git-credential: answer only when git asks for this host
                     (exact match, port included); otherwise exit 1 without
                     contacting the daemon
  -h, --help         Show this help message

git-credential actions:
  get     Read git's request on stdin, print username= and password= lines
  store   Do nothing (the vault is managed by the agent or the dashboard)
  erase   Do nothing

Errors go to stderr, without values, and exit 1, so git falls through to its
next helper or prompt.

Example (URL-scoped, so git asks the helper only for that host):
  git config credential.https://forgejo.example.com.helper \\
    '!drawlatch vault git-credential --item forgejo-token --host forgejo.example.com'
`;

/** Run `drawlatch vault <argv…>`. Returns the exit code. */
export async function runVaultCli(argv: string[], io: VaultCliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        caller: { type: 'string' },
        item: { type: 'string' },
        owner: { type: 'string' },
        username: { type: 'string' },
        host: { type: 'string' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    return fail(io, (err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals[0] === 'help') {
    await write(io.stdout, VAULT_HELP.trimStart());
    return 0;
  }
  const [sub, ...rest] = positionals;
  if (positionals.length === 0) {
    await write(io.stderr, VAULT_HELP.trimStart());
    return 1;
  }

  try {
    const caller = optionalAlias(values.caller, '--caller');
    const connect = io.connect ?? defaultConnect;
    switch (sub) {
      case 'list':
        if (rest.length > 0) throw new CliError(`vault list takes no arguments`);
        return await list(connect(caller), io);
      case 'git-credential':
        return await gitCredential(
          {
            action: rest,
            caller,
            item: values.item,
            owner: optionalAlias(values.owner, '--owner'),
            username: values.username,
            host: values.host,
          },
          connect,
          io,
        );
      default:
        throw new CliError(`unknown vault subcommand (expected list or git-credential)`);
    }
  } catch (err) {
    return fail(io, (err as Error).message);
  }
}

function defaultConnect(callerAlias: string | undefined): ChannelClient {
  // Quiet: git shows a helper's stderr to the user, and errors say enough.
  return createChannelClient({ callerAlias, log: () => undefined });
}

// ── list ────────────────────────────────────────────────────────────────────

interface ListedItem {
  name: string;
  kind: string;
  exposure: string;
  fields: string[];
}
interface SharedItem {
  owner: string;
  name: string;
  kind: string;
  fields: string[];
  mode: string;
}

async function list(client: ChannelClient, io: VaultCliIO): Promise<number> {
  const result = (await client.send('vault_list', {})) as {
    items?: ListedItem[];
    shared?: SharedItem[];
  };
  const items = Array.isArray(result.items) ? result.items : [];
  const shared = Array.isArray(result.shared) ? result.shared : [];
  const lines: string[] = [];
  if (items.length === 0) lines.push('No items.');
  else {
    lines.push(
      ...table(
        ['NAME', 'KIND', 'EXPOSURE', 'FIELDS'],
        items.map((i) => [i.name, i.kind, i.exposure, i.fields.join(',')]),
      ),
    );
  }
  if (shared.length > 0) {
    lines.push('', 'Shared with you:');
    lines.push(
      ...table(
        ['ITEM', 'KIND', 'MODE', 'FIELDS'],
        shared.map((s) => [`${s.owner}/${s.name}`, s.kind, s.mode, s.fields.join(',')]),
      ),
    );
  }
  await write(io.stdout, lines.join('\n') + '\n');
  return 0;
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  return [header, ...rows].map((r) =>
    r
      .map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c])))
      .join('  ')
      .trimEnd(),
  );
}

// ── git-credential ──────────────────────────────────────────────────────────

interface GitCredentialOptions {
  action: string[];
  caller: string | undefined;
  item: string | undefined;
  owner: string | undefined;
  username: string | undefined;
  host: string | undefined;
}

async function gitCredential(
  opts: GitCredentialOptions,
  connect: (callerAlias: string | undefined) => ChannelClient,
  io: VaultCliIO,
): Promise<number> {
  if (opts.action.length !== 1) {
    throw new CliError('git-credential needs one action: get, store or erase');
  }
  const [action] = opts.action;
  if (action !== 'get' && action !== 'store' && action !== 'erase') {
    throw new CliError('git-credential action must be get, store or erase');
  }
  if (opts.item === undefined || !ITEM_REGEX.test(opts.item)) {
    throw new CliError('--item is required: an item name (letters, digits, "_" or "-")');
  }
  if (opts.username !== undefined && !isGitValue(opts.username)) {
    throw new CliError('--username must be non-empty, without newlines or NUL');
  }
  if (opts.host !== undefined && !isGitValue(opts.host)) {
    throw new CliError('--host must be non-empty, without newlines or NUL');
  }

  // Read git's request whatever the action, so git never sees a closed pipe.
  const request = parseGitRequest(await readStdin(io.stdin));
  if (action !== 'get') return 0; // store / erase: the vault isn't git's to change.

  if (opts.host !== undefined) {
    // Before any contact with the daemon: an unscoped helper must not answer
    // (or audit-log a reveal) for some other host.
    const asked = request.get('host');
    if (asked?.toLowerCase() !== opts.host.toLowerCase()) {
      throw new CliError(
        `git asked for ${asked === undefined ? 'no host' : `host "${asked}"`}, not --host ` +
          `"${opts.host}"; not answering`,
      );
    }
  }

  const result = (await connect(opts.caller).send('vault_get', {
    name: opts.item,
    ...(opts.owner !== undefined && { owner: opts.owner }),
    purpose: GIT_CREDENTIAL_PURPOSE,
  })) as { values?: unknown };
  const fields = result.values;
  if (fields === null || typeof fields !== 'object') {
    throw new CliError('the daemon returned no values for the item');
  }
  const password = ownString(fields, 'value');
  if (password === undefined) {
    throw new CliError(`item "${opts.item}" has no "value" field to use as the password`);
  }
  const username = ownString(fields, 'username') ?? opts.username ?? DEFAULT_GIT_USERNAME;
  if (!isGitValue(password) || !isGitValue(username)) {
    throw new CliError(
      `item "${opts.item}" has a value git can't take (empty, or with a newline or NUL)`,
    );
  }
  await write(io.stdout, `username=${username}\npassword=${password}\n`);
  return 0;
}

function ownString(o: object, key: string): string | undefined {
  if (!Object.hasOwn(o, key)) return undefined;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/** A value git's line protocol can carry. */
function isGitValue(v: string): boolean {
  return v.length > 0 && !/[\n\r\0]/.test(v);
}

/**
 * git's `key=value` lines, up to a blank line or EOF. Later keys win, and
 * array keys (`wwwauth[]`, `capability[]`) are ignored: only `host` is used.
 */
export function parseGitRequest(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (l === '') break;
    const eq = l.indexOf('=');
    if (eq <= 0) continue;
    const key = l.slice(0, eq);
    if (key.endsWith('[]')) continue;
    out.set(key, l.slice(eq + 1));
  }
  return out;
}

async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new CliError('git sent more input than expected');
    chunks.push(buf);
    // git ends its request with a blank line; don't wait for EOF after it.
    const text = Buffer.concat(chunks).toString('utf8');
    if (text.startsWith('\n') || text.includes('\n\n')) return text;
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── helpers ─────────────────────────────────────────────────────────────────

function optionalAlias(v: string | undefined, flag: string): string | undefined {
  if (v === undefined) return undefined;
  if (!ALIAS_REGEX.test(v)) {
    throw new CliError(`${flag} must be a caller alias (letters, digits, "_" or "-")`);
  }
  return v;
}

async function fail(io: VaultCliIO, message: string): Promise<number> {
  await write(io.stderr, `drawlatch vault: ${message}\n`);
  return 1;
}

function write(stream: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (err) => (err ? reject(err) : resolve()));
  });
}
