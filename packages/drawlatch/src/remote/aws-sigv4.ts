/**
 * AWS Signature Version 4 request signing, for routes with `awsSigV4` set.
 *
 * Two layers:
 *   - `signSigV4()` — the algorithm itself, over a request described exactly as
 *     it goes on the wire (request-line path and query, header list, body
 *     bytes). Checked against AWS's published test suite.
 *   - `signProxyRequest()` — what executeProxyRequest calls once a request's
 *     URL, headers, and body are final. It resolves credentials and the signing
 *     scope, turns the body into the exact bytes fetch() will send, and returns
 *     the headers to send with the signature added.
 *
 * Built on node:crypto only. See
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 */

import crypto from 'node:crypto';

import {
  AWS_SIGV4_REQUIRED_SECRETS,
  AWS_SIGV4_SESSION_TOKEN_SECRET,
  type AwsSigV4Config,
} from '../shared/config.js';

const ALGORITHM = 'AWS4-HMAC-SHA256';

/**
 * Headers the signer owns on an `awsSigV4` route. A caller-supplied value would
 * either be overwritten or let the caller dictate what gets signed, so requests
 * carrying any of them are rejected before signing.
 */
export const SIGV4_RESERVED_HEADERS = new Set([
  'authorization',
  'host',
  'x-amz-date',
  'x-amz-content-sha256',
  'x-amz-security-token',
]);

/** Presigned-URL query parameters. Mixing them with header auth is ambiguous, so they're rejected. */
export const SIGV4_RESERVED_QUERY_PARAMS = new Set([
  'x-amz-algorithm',
  'x-amz-credential',
  'x-amz-date',
  'x-amz-security-token',
  'x-amz-signature',
  'x-amz-signedheaders',
]);

/**
 * Headers sent but left out of the signature: hop-by-hop headers a proxy may
 * rewrite, and ones fetch() manages itself (it computes content-length from the
 * body). Matches the AWS SDK's unsignable set, plus content-length.
 */
const UNSIGNED_HEADERS = new Set([
  'cache-control',
  'connection',
  'content-length',
  'expect',
  'from',
  'keep-alive',
  'max-forwards',
  'pragma',
  'referer',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'x-amzn-trace-id',
]);

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** A request described exactly as it will be sent. */
export interface SigV4Request {
  method: string;
  /** Path as it appears in the request line (already percent-encoded on the wire). */
  path: string;
  /** Query string as it appears in the request line, without the leading "?". */
  query: string;
  /** Headers to sign. Must include `host`. Repeated names are allowed. */
  headers: [string, string][];
  /** The exact body bytes. */
  body?: Uint8Array;
}

export interface SigV4Options {
  service: string;
  region: string;
  credentials: AwsCredentials;
  date: Date;
  /**
   * True (default) for every service except S3: the path is normalized (dot
   * segments and empty segments removed) and each segment URI-encoded as it
   * appears on the wire, which encodes an already-encoded path a second time.
   * False for S3: the path is not normalized and each segment is encoded once.
   */
  uriEscapePath?: boolean;
  /** Add and sign `x-amz-content-sha256` (S3 requires it). */
  signPayloadHeader?: boolean;
}

export interface SigV4Result {
  /** Headers the signer added: x-amz-date, x-amz-content-sha256 and
   *  x-amz-security-token when applicable, and authorization. */
  headers: Record<string, string>;
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
}

function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 encoding: everything except A-Z a-z 0-9 - _ . ~ is percent-encoded. */
export function uriEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function safeDecode(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
}

function canonicalUri(path: string, uriEscapePath: boolean): string {
  if (!path.startsWith('/')) path = `/${path}`;

  if (!uriEscapePath) {
    // S3: keep the path's shape, encode each segment exactly once.
    return path
      .split('/')
      .map((seg) => uriEncode(safeDecode(seg)))
      .join('/');
  }

  const segments: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') segments.pop();
    else segments.push(seg);
  }
  const trailing = path.endsWith('/') && segments.length > 0 ? '/' : '';
  return `/${segments.map(uriEncode).join('/')}${trailing}`;
}

function canonicalQuery(query: string): string {
  if (!query) return '';
  const pairs = query
    .split('&')
    .filter((p) => p !== '')
    .map((p) => {
      const eq = p.indexOf('=');
      const key = eq === -1 ? p : p.slice(0, eq);
      const value = eq === -1 ? '' : p.slice(eq + 1);
      return [uriEncode(safeDecode(key)), uriEncode(safeDecode(value))] as const;
    });
  // Sort by code point of the encoded key, then value.
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]|\.\d{3}/g, '');
}

/** Sign a request. Pure: the same inputs always produce the same signature. */
export function signSigV4(req: SigV4Request, opts: SigV4Options): SigV4Result {
  const { service, region, credentials, date } = opts;
  const timestamp = amzDate(date);
  const day = timestamp.slice(0, 8);
  const payloadHash = sha256Hex(req.body ?? '');

  const added: Record<string, string> = { 'x-amz-date': timestamp };
  if (opts.signPayloadHeader) added['x-amz-content-sha256'] = payloadHash;
  if (credentials.sessionToken) added['x-amz-security-token'] = credentials.sessionToken;

  // Lowercase names, trim values and collapse inner whitespace, join repeats
  // with commas in the order given, sort by name.
  const grouped = new Map<string, string[]>();
  for (const [name, value] of [...req.headers, ...Object.entries(added)]) {
    const key = name.toLowerCase();
    const values = grouped.get(key) ?? [];
    values.push(value.trim().replace(/\s+/g, ' '));
    grouped.set(key, values);
  }
  const sorted = [...grouped].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = sorted.map(([n, v]) => `${n}:${v.join(',')}\n`).join('');
  const signedHeaders = sorted.map(([n]) => n).join(';');

  const canonicalRequest = [
    req.method.toUpperCase(),
    canonicalUri(req.path, opts.uriEscapePath ?? true),
    canonicalQuery(req.query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, timestamp, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    headers: {
      ...added,
      authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

// ── Signing scope ───────────────────────────────────────────────────────────

const REGION_LABEL = /^[a-z]{2}(?:-gov|-iso[a-z]?)?-[a-z]+-\d+$/;

/** S3-family endpoint labels that are their own signing name (and use S3 path rules).
 *  Any other "s3-*" label (s3-accesspoint, s3-control, s3-fips, …) signs as "s3". */
const S3_SIGNING_NAMES = new Set(['s3', 's3-object-lambda', 's3-outposts']);

/** Endpoint prefixes whose signing name differs. Anything else: use `awsSigV4.service`. */
const SIGNING_NAME_ALIASES: Record<string, string> = {
  'aps-workspaces': 'aps',
  'bedrock-agent': 'bedrock',
  'bedrock-agent-runtime': 'bedrock',
  'bedrock-runtime': 'bedrock',
  email: 'ses',
};

/**
 * Infer the signing service and region from an `*.amazonaws.com` hostname.
 *
 *   sts.amazonaws.com                         → sts, us-east-1 (global endpoint)
 *   sts.eu-west-1.amazonaws.com               → sts, eu-west-1
 *   runtime.sagemaker.us-east-1.amazonaws.com → sagemaker, us-east-1
 *   abc123.execute-api.us-east-1.amazonaws.com → execute-api, us-east-1
 *   search-x.us-east-1.es.amazonaws.com       → es, us-east-1
 *   bucket.s3.us-west-2.amazonaws.com         → s3, us-west-2
 *   s3-us-west-2.amazonaws.com, s3.amazonaws.com → s3, us-west-2 / us-east-1
 *   ap-123.op-456.s3-outposts.us-west-2.amazonaws.com → s3-outposts, us-west-2
 *   vpce-1a2b.sts.us-east-1.vpce.amazonaws.com → sts, us-east-1
 *   iam.us-gov.amazonaws.com                  → iam, us-gov-west-1
 *
 * Returns null for a host it can't place.
 */
export function inferAwsScope(hostname: string): { service: string; region: string } | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const suffix = '.amazonaws.com';
  if (!host.endsWith(suffix)) return null;
  const labels = host.slice(0, -suffix.length).split('.');
  if (labels.some((l) => l === '')) return null;
  // Interface VPC endpoints: vpce-….<service>.<region>.vpce.amazonaws.com
  if (labels.length > 1 && labels[labels.length - 1] === 'vpce') labels.pop();

  // S3: the rightmost "s3" / "s3-*" label (bucket names can contain "s3" too).
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i];
    if (label !== 's3' && !label.startsWith('s3-')) continue;
    const service = S3_SIGNING_NAMES.has(label) ? label : 's3';
    const legacyRegion = label.slice(3);
    const region = REGION_LABEL.test(legacyRegion)
      ? legacyRegion
      : (labels.slice(i + 1).find((l) => REGION_LABEL.test(l)) ?? 'us-east-1');
    return { service, region };
  }

  let regionIdx = -1;
  for (let i = labels.length - 1; i >= 0; i--) {
    if (REGION_LABEL.test(labels[i])) {
      regionIdx = i;
      break;
    }
  }

  let prefix: string | undefined;
  let region = 'us-east-1';
  if (regionIdx === -1 && labels.length > 1 && labels[labels.length - 1] === 'us-gov') {
    // GovCloud global endpoints (iam.us-gov.amazonaws.com) sign for us-gov-west-1.
    prefix = labels[labels.length - 2];
    region = 'us-gov-west-1';
  } else if (regionIdx === -1) {
    prefix = labels[labels.length - 1];
  } else {
    region = labels[regionIdx];
    // <service>.<region>.amazonaws.com, or <id>.<region>.<service>.amazonaws.com
    prefix = regionIdx < labels.length - 1 ? labels[labels.length - 1] : labels[regionIdx - 1];
  }
  if (!prefix) return null;
  prefix = prefix.replace(/-fips$/, '');
  return { service: SIGNING_NAME_ALIASES[prefix] ?? prefix, region };
}

// ── Proxy integration ───────────────────────────────────────────────────────

/** Read a credential from the route's resolved secrets. Unset, empty, and
 *  still-a-placeholder values all count as absent. */
function credential(secrets: Record<string, string>, name: string): string | undefined {
  const value = secrets[name];
  if (typeof value !== 'string' || value === '' || /^\$\{\w+\}$/.test(value)) return undefined;
  return value;
}

export interface SignProxyRequestInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | FormData | undefined;
  config: AwsSigV4Config;
  secrets: Record<string, string>;
  /** Injectable clock for tests. */
  now?: Date;
}

/**
 * Sign a fully resolved proxy request.
 *
 * Returns the headers and body to hand to fetch(). The body comes back as
 * bytes so the payload hash covers exactly what is sent: a string is encoded
 * as UTF-8 (with fetch()'s own default content-type when none was set), and
 * FormData is serialized here, boundary and all, rather than by fetch().
 */
export async function signProxyRequest(
  input: SignProxyRequestInput,
): Promise<{ headers: Record<string, string>; body: Uint8Array<ArrayBuffer> | undefined }> {
  const url = new URL(input.url);

  const inferred = inferAwsScope(url.hostname);
  const service = input.config.service ?? inferred?.service;
  const region = input.config.region ?? inferred?.region;
  if (!service || !region) {
    throw new Error(
      `Cannot determine the AWS signing service/region for host "${url.hostname}". ` +
        'Set awsSigV4.service and awsSigV4.region on the connection.',
    );
  }

  const [idName, keyName] = AWS_SIGV4_REQUIRED_SECRETS;
  const accessKeyId = credential(input.secrets, idName);
  const secretAccessKey = credential(input.secrets, keyName);
  if (!accessKeyId || !secretAccessKey) {
    const missing = [idName, keyName].filter((n) => !credential(input.secrets, n));
    throw new Error(`AWS credentials not configured for this caller: ${missing.join(', ')}`);
  }
  const sessionToken = credential(input.secrets, AWS_SIGV4_SESSION_TOKEN_SECRET);

  // Normalize the headers the way fetch() will (validated names, lowercased,
  // repeated names merged) so the signature covers what actually goes out.
  const headers = new Headers(input.headers);
  for (const name of SIGV4_RESERVED_HEADERS) headers.delete(name);

  let body: Uint8Array<ArrayBuffer> | undefined;
  if (input.body instanceof FormData) {
    const encoded = new Response(input.body);
    body = new Uint8Array(await encoded.arrayBuffer());
    // multipart/form-data; boundary=… — generated here, so set it here.
    headers.set('content-type', encoded.headers.get('content-type') ?? 'multipart/form-data');
  } else if (typeof input.body === 'string') {
    body = new TextEncoder().encode(input.body);
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8');
  }

  const toSign: [string, string][] = [['host', url.host]];
  for (const [name, value] of headers) {
    if (!UNSIGNED_HEADERS.has(name)) toSign.push([name, value]);
  }

  const signed = signSigV4(
    {
      method: input.method,
      path: url.pathname,
      query: url.search.slice(1),
      headers: toSign,
      body,
    },
    {
      service,
      region,
      credentials: { accessKeyId, secretAccessKey, sessionToken },
      date: input.now ?? new Date(),
      uriEscapePath: !S3_SIGNING_NAMES.has(service),
      signPayloadHeader: true,
    },
  );

  return { headers: { ...Object.fromEntries(headers), ...signed.headers }, body };
}
