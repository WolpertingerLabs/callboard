/**
 * `${vault:…}` placeholders in a caller's secure_request.
 *
 * Grammar: `${vault:<name>}`, `${vault:<name>.<field>}`, and the same with an
 * `<owner>/` prefix. Names, owners, and fields can't contain `/`, `.`, `:`,
 * or `}`, so a token parses one way only. The default field is `value`.
 *
 * Used only by executeProxyRequest, only for caller-authored requests, and
 * only in the URL path and query, request headers, and (on a
 * `resolveSecretsInBody` route) the body. Every token is resolved and
 * authorized before anything is sent: an unusable one is a hard error, never
 * sent literally. Each substituted value comes back as a scrub entry named
 * `vault:<owner>/<name>.<field>`, so an echo of it scrubs to that
 * placeholder.
 *
 * Messages name the token (once it has parsed) and the reason, never a value.
 */
import { resolvePlaceholders } from '../../shared/config.js';
import { isReservedKey } from '../../shared/safe-keys.js';
import { CALLER_ALIAS_REGEX } from '../caller-bootstrap.js';
import { appendVaultEvent } from './audit.js';
import { FIELD_REGEX, NAME_REGEX, sharedItem } from './service.js';
import { readVault, type VaultItem } from './store.js';

/** What starts a vault token. Its presence anywhere in a URL's origin is refused. */
export const VAULT_TOKEN_START = '${vault:';

/** Every vault token, including empty and malformed ones (`${vault:}`, `${vault:a.b.c}`). */
const VAULT_TOKEN = /\$\{vault:([^}]*)\}/g;

/** A vault token or a `${VAR}`: one pass over the caller's original string. */
const ANY_PLACEHOLDER = /\$\{(vault:[^}]*|\w+)\}/g;

const MAX_OWNER_CHARS = 128;

export interface VaultRef {
  /** Absent: the caller's own item. */
  owner?: string;
  name: string;
  field: string;
  /** Whether the token named the field, rather than defaulting to `value`. */
  explicitField: boolean;
}

/** Parse the part of a token after `vault:`. Undefined when it's malformed. */
export function parseVaultSpec(spec: string): VaultRef | undefined {
  const m = /^(?:([^/.:}]+)\/)?([^/.:}]+)(?:\.([^/.:}]+))?$/.exec(spec);
  if (!m) return undefined;
  // Optional groups that didn't take part are undefined at runtime.
  const [owner, name, field] = [m[1], m[2], m[3]] as [
    string | undefined,
    string,
    string | undefined,
  ];
  if (
    owner !== undefined &&
    (owner.length > MAX_OWNER_CHARS || !CALLER_ALIAS_REGEX.test(owner) || isReservedKey(owner))
  ) {
    return undefined;
  }
  if (!NAME_REGEX.test(name) || isReservedKey(name)) return undefined;
  if (field !== undefined && (!FIELD_REGEX.test(field) || isReservedKey(field))) return undefined;
  return {
    ...(owner !== undefined && { owner }),
    name,
    field: field ?? 'value',
    explicitField: field !== undefined,
  };
}

/** Whether `text` holds a vault token (well-formed or not). */
export function hasVaultToken(text: string): boolean {
  return /\$\{vault:[^}]*\}/.test(text);
}

/** The specs of every vault token in `text`, in order. */
export function vaultSpecs(text: string): string[] {
  return [...text.matchAll(VAULT_TOKEN)].map((m) => m[1]);
}

/**
 * Refuse a URL whose scheme, userinfo, host, or port holds anything that
 * looks like a vault token: a vault value must never choose where a request
 * goes. "Origin" here is everything up to the first `/`, `\`, `?`, or `#`
 * after the scheme's slashes, the way the WHATWG parser reads a special
 * scheme (it accepts `https:host` and `https:\\host` too). A relative URL
 * with a token is refused as well; it can't be sent anyway.
 */
export function assertVaultNotInOrigin(url: string): void {
  if (!url.includes(VAULT_TOKEN_START)) return;
  const origin = /^[^:]*:[/\\]*[^/\\?#]*/.exec(url)?.[0] ?? url;
  if (origin.includes(VAULT_TOKEN_START)) {
    throw new Error(
      "The request URL has a ${vault:…} placeholder before its path: a vault placeholder can't " +
        'choose the host. Use one only in the path, the query, a header, or (where the connection ' +
        'allows) the body.',
    );
  }
}

/** Where a string came from, for error messages: "The request URL", `Header "X"`. */
export interface VaultSource {
  where: string;
  text: string;
  /** The text is the request URL: a value may not hold a URL delimiter there. */
  url?: boolean;
}

/**
 * `#`, `?` and `&` in a URL cut a value (fragment) or split it across URL
 * components and parameters. The upstream would get part of it, and an echo
 * of one part can't be scrubbed (only whole values are), so a vault value
 * holding one is refused in the URL, like CR/LF and `..`.
 */
const URL_DELIMITER = /[#?&]/;

/** One use of another caller's item through a grant, for its `vault.inject` event. */
export interface CrossCallerUse {
  owner: string;
  item: string;
  itemId: string;
  grantId: string;
  /** Field names used, sorted. */
  fields: string[];
}

export interface VaultResolution {
  /** spec (the text after `vault:`) → value. */
  values: Map<string, string>;
  /** `vault:<owner>/<name>.<field>` → value, for every substituted value. */
  scrub: Record<string, string>;
  /** Another caller's items used through a grant, one entry per grant. */
  crossCaller: CrossCallerUse[];
}

export function emptyVaultResolution(): VaultResolution {
  return {
    values: new Map(),
    scrub: Object.create(null) as Record<string, string>,
    crossCaller: [],
  };
}

/**
 * Resolve and authorize every vault token in `sources` for `caller` on the
 * matched connection. Throws on the first token that can't be used. Reads the
 * vault only when there is a token, so a request without one never touches
 * the vault file or its key.
 */
export function resolveVaultTokens(opts: {
  caller: string | undefined;
  connection: string | undefined;
  sources: VaultSource[];
}): VaultResolution {
  const resolution = emptyVaultResolution();
  const found = opts.sources.flatMap(({ where, text, url }) =>
    vaultSpecs(text).map((spec) => ({ where, spec, url: url === true })),
  );
  if (found.length === 0) return resolution;

  const refuse: (where: string, spec: string, reason: string) => never = (where, spec, reason) => {
    throw new Error(`${where} references \${vault:${spec}}, which can't be used: ${reason}.`);
  };
  // Parse everything first, so a malformed token is reported without echoing it.
  const refs = found.map(({ where, spec, url }) => {
    const ref = parseVaultSpec(spec);
    if (!ref) {
      throw new Error(
        `${where} contains a malformed \${vault:…} placeholder. The forms are \${vault:<name>} ` +
          'and ${vault:<name>.<field>}, where names are 1-64 letters, digits, "_" or "-" and ' +
          'fields 1-64 letters, digits or "_".',
      );
    }
    return { where, spec, ref, url };
  });
  /** Per occurrence: the same token may be fine in a header and not in the URL. */
  const checkPosition = (where: string, spec: string, url: boolean, value: string): void => {
    if (url && URL_DELIMITER.test(value)) {
      refuse(where, spec, 'it contains a URL delimiter (#, ? or &); send it in a header instead');
    }
  };
  const { caller } = opts;
  if (caller === undefined) {
    throw new Error(
      "A ${vault:…} placeholder needs the caller's identity; this request path did not supply one.",
    );
  }

  const doc = readVault();
  const own = Object.hasOwn(doc.callers, caller) ? doc.callers[caller].items : undefined;
  const uses = new Map<string, CrossCallerUse>();
  for (const { where, spec, ref, url } of refs) {
    const known = resolution.values.get(spec);
    if (known !== undefined) {
      checkPosition(where, spec, url, known);
      continue;
    }
    const owner: string = ref.owner ?? caller;
    const label = owner === caller ? ref.name : `${owner}/${ref.name}`;
    let item: VaultItem | undefined;
    if (owner === caller) {
      item = own && Object.hasOwn(own, ref.name) ? own[ref.name] : undefined;
      if (!item) refuse(where, spec, `no such item "${ref.name}" in your vault`);
    } else {
      // One answer for "no such item" and "not shared with you": no oracle
      // for which items other callers have.
      const shared = sharedItem(doc, caller, owner, ref.name);
      if (!shared) {
        refuse(
          where,
          spec,
          `no such item "${ref.name}" shared with you by "${owner}" (using another ` +
            "caller's item needs a grant from the operator; ask with vault_request_access)",
        );
      }
      item = shared.item;
      const use: CrossCallerUse = uses.get(shared.grant.id) ?? {
        owner,
        item: item.name,
        itemId: item.id,
        grantId: shared.grant.id,
        fields: [],
      };
      if (!use.fields.includes(ref.field)) use.fields = [...use.fields, ref.field].sort();
      uses.set(shared.grant.id, use);
    }
    const bound = item.connections;
    if (
      bound !== undefined &&
      (opts.connection === undefined || !bound.includes(opts.connection))
    ) {
      refuse(
        where,
        spec,
        `item "${label}" is not allowed on connection "${opts.connection ?? '(unnamed)'}" ` +
          `(it is bound to ${bound.map((c) => `"${c}"`).join(', ') || 'no connection'})`,
      );
    }
    if (!Object.hasOwn(item.values, ref.field)) {
      refuse(
        where,
        spec,
        ref.explicitField
          ? `item "${label}" has no field "${ref.field}"`
          : `item "${label}" has no "value" field; name one, as \${vault:${label}.<field>}`,
      );
    }
    const value = item.values[ref.field];
    checkPosition(where, spec, url, value);
    resolution.values.set(spec, value);
    resolution.scrub[`vault:${owner}/${ref.name}.${ref.field}`] = value;
  }
  resolution.crossCaller = [...uses.values()];
  return resolution;
}

/**
 * Substitute `${VAR}` and `${vault:…}` placeholders in one pass over `text`,
 * so neither kind of value is scanned for the other. A string without a vault
 * token goes through resolvePlaceholders() unchanged, and each `${VAR}` in one
 * with tokens resolves exactly as resolvePlaceholders() would resolve it (an
 * unknown one stays literal, with the same warning). Every vault token must be
 * in `vault` already (resolveVaultTokens() ran on this text).
 *
 * `jsonEscape` escapes vault values for the inside of a JSON string, for a
 * body drawlatch serialized from an object.
 */
export function substitutePlaceholders(
  text: string,
  secrets: Record<string, string>,
  vault: ReadonlyMap<string, string>,
  opts: { jsonEscape?: boolean } = {},
): string {
  if (!hasVaultToken(text)) return resolvePlaceholders(text, secrets);
  return text.replace(ANY_PLACEHOLDER, (match, inner: string) => {
    if (!inner.startsWith('vault:')) return resolvePlaceholders(match, secrets);
    const value = vault.get(inner.slice('vault:'.length));
    // resolveVaultTokens() refuses every token it can't resolve, so this is a
    // bug in the caller; fail closed rather than send the token.
    if (value === undefined) throw new Error('internal error: unresolved ${vault:…} placeholder');
    return opts.jsonEscape ? JSON.stringify(value).slice(1, -1) : value;
  });
}

/**
 * Append `vault.inject` to each owner's audit log for every cross-caller use
 * in `resolution`, before the request is sent. Fail-closed: if a line can't
 * be written, the request is refused and nothing is sent.
 */
export async function recordCrossCallerUse(
  resolution: VaultResolution,
  caller: string,
  connection: string | undefined,
): Promise<void> {
  for (const use of resolution.crossCaller) {
    try {
      await appendVaultEvent(use.owner, 'vault.inject', {
        item: use.item,
        item_id: use.itemId,
        actor: caller,
        via: 'mcp',
        grantee: caller,
        grant_id: use.grantId,
        connection: connection ?? '(unnamed)',
        fields: use.fields,
      });
    } catch (err) {
      throw new Error(
        `secure_request refused: the vault.inject audit line for \${vault:${use.owner}/${use.item}} ` +
          `could not be written (${(err as Error).message}); nothing was sent.`,
      );
    }
  }
}

/**
 * Resolve the same sources again, synchronously, right before sending, and
 * refuse unless every token still resolves to the same value through the same
 * grants. Between the first resolution and the send there are awaits (the
 * audit append, signing, token minting): a revoke, delete, rename, rebind or
 * rotation that lands in one of them is honoured rather than sent past.
 */
export function assertVaultUnchanged(
  before: VaultResolution,
  opts: Parameters<typeof resolveVaultTokens>[0],
): void {
  if (before.values.size === 0) return;
  const now = resolveVaultTokens(opts);
  const same =
    now.values.size === before.values.size &&
    [...before.values].every(([spec, value]) => now.values.get(spec) === value) &&
    now.crossCaller.map((u) => u.grantId).join() ===
      before.crossCaller.map((u) => u.grantId).join();
  if (!same) {
    throw new Error(
      'A vault item or grant this request uses changed while it was being prepared; ' +
        'nothing was sent. Try again.',
    );
  }
}
