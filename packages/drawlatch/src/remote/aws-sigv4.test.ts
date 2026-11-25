/**
 * Tests for AWS SigV4 signing (aws-sigv4.ts) and its use by executeProxyRequest.
 *
 * The algorithm is checked against AWS's published test suite. The proxy path
 * is checked end to end against a local HTTP server that re-derives the
 * signature from the request it actually received, so a mismatch between what
 * was signed and what went over the wire fails the test.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveRoutes, type ResolvedRoute } from '../shared/config.js';
import { loadConnection } from '../shared/connections.js';
import { inferAwsScope, signProxyRequest, signSigV4, uriEncode } from './aws-sigv4.js';
import { executeProxyRequest, isEndpointAllowed, toolHandlers } from './tool-dispatch.js';
import type { ToolContext } from './tool-dispatch.js';

// ── AWS test suite ─────────────────────────────────────────────────────────

interface Vector {
  name: string;
  request: string;
  normalize: boolean;
  signBody: boolean;
  signature: string;
  canonicalRequest: string;
  sessionToken?: string;
}

const suite = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '__fixtures__',
      'aws-sigv4-test-suite.json',
    ),
    'utf-8',
  ),
) as {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  timestamp: string;
  vectors: Vector[];
};

/** Parse a raw HTTP/1.1 request from the suite into the signer's input shape. */
function parseRawRequest(raw: string) {
  const blank = raw.indexOf('\n\n');
  const head = blank === -1 ? raw : raw.slice(0, blank);
  const body = blank === -1 ? '' : raw.slice(blank + 2);
  const [requestLine, ...headerLines] = head.split('\n');
  const [method, ...rest] = requestLine.split(' ');
  const target = rest.slice(0, -1).join(' '); // the path may contain spaces
  const q = target.indexOf('?');
  return {
    method,
    path: q === -1 ? target : target.slice(0, q),
    query: q === -1 ? '' : target.slice(q + 1),
    headers: headerLines
      .filter((line) => line !== '')
      .map((line): [string, string] => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon), line.slice(colon + 1)];
      }),
    body: new TextEncoder().encode(body),
  };
}

describe('signSigV4 — AWS SigV4 test suite', () => {
  it.each(suite.vectors.map((v) => [v.name, v] as const))('%s', (_name, vector) => {
    const result = signSigV4(parseRawRequest(vector.request), {
      service: suite.service,
      region: suite.region,
      credentials: {
        accessKeyId: suite.accessKeyId,
        secretAccessKey: suite.secretAccessKey,
        sessionToken: vector.sessionToken,
      },
      date: new Date(suite.timestamp),
      uriEscapePath: vector.normalize,
      signPayloadHeader: vector.signBody,
    });

    expect(result.canonicalRequest).toBe(vector.canonicalRequest);
    expect(result.signature).toBe(vector.signature);
  });

  it('should cover the vanilla, query, header, utf8, normalization, form, and STS cases', () => {
    const names = suite.vectors.map((v) => v.name);
    for (const expected of [
      'get-vanilla',
      'get-vanilla-query-order-encoded',
      'get-header-key-duplicate',
      'get-utf8',
      'get-slashes-normalized',
      'get-slashes-unnormalized',
      'post-x-www-form-urlencoded',
      'post-sts-header-before',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('should build the full Authorization header', () => {
    const vector = suite.vectors.find((v) => v.name === 'get-vanilla')!;
    const result = signSigV4(parseRawRequest(vector.request), {
      service: suite.service,
      region: suite.region,
      credentials: { accessKeyId: suite.accessKeyId, secretAccessKey: suite.secretAccessKey },
      date: new Date(suite.timestamp),
    });
    expect(result.headers).toEqual({
      'x-amz-date': '20150830T123600Z',
      authorization:
        'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    });
  });
});

describe('uriEncode', () => {
  it('should leave only RFC 3986 unreserved characters unencoded', () => {
    expect(uriEncode("-_.~AZaz09 !'()*/+=&ሴ")).toBe(
      '-_.~AZaz09%20%21%27%28%29%2A%2F%2B%3D%26%E1%88%B4',
    );
  });
});

// ── Scope inference ─────────────────────────────────────────────────────────

describe('inferAwsScope', () => {
  it.each([
    ['sts.amazonaws.com', 'sts', 'us-east-1'],
    ['iam.amazonaws.com', 'iam', 'us-east-1'],
    ['sts.eu-west-1.amazonaws.com', 'sts', 'eu-west-1'],
    ['sts-fips.us-east-2.amazonaws.com', 'sts', 'us-east-2'],
    ['ec2.us-gov-west-1.amazonaws.com', 'ec2', 'us-gov-west-1'],
    ['dynamodb.ap-southeast-2.amazonaws.com', 'dynamodb', 'ap-southeast-2'],
    ['runtime.sagemaker.us-east-1.amazonaws.com', 'sagemaker', 'us-east-1'],
    ['abc123.execute-api.eu-central-1.amazonaws.com', 'execute-api', 'eu-central-1'],
    ['search-dom-xyz.us-west-2.es.amazonaws.com', 'es', 'us-west-2'],
    ['bedrock-runtime.us-west-2.amazonaws.com', 'bedrock', 'us-west-2'],
    ['email.eu-west-1.amazonaws.com', 'ses', 'eu-west-1'],
    ['s3.amazonaws.com', 's3', 'us-east-1'],
    ['my-bucket.s3.amazonaws.com', 's3', 'us-east-1'],
    ['my-bucket.s3.us-west-2.amazonaws.com', 's3', 'us-west-2'],
    ['my.s3.bucket.s3.eu-west-1.amazonaws.com', 's3', 'eu-west-1'],
    ['s3.dualstack.ap-south-1.amazonaws.com', 's3', 'ap-south-1'],
    ['s3-us-west-2.amazonaws.com', 's3', 'us-west-2'],
    ['s3-external-1.amazonaws.com', 's3', 'us-east-1'],
    ['STS.Amazonaws.com.', 'sts', 'us-east-1'],
    ['vpce-0a1b2c3d-x1y2z3.sts.us-east-1.vpce.amazonaws.com', 'sts', 'us-east-1'],
    ['bucket.vpce-0a1b2c3d-x1y2z3.s3.eu-west-1.vpce.amazonaws.com', 's3', 'eu-west-1'],
    ['iam.us-gov.amazonaws.com', 'iam', 'us-gov-west-1'],
    [
      'ap-123456789012.op-01ac5d28a6a232904.s3-outposts.us-west-2.amazonaws.com',
      's3-outposts',
      'us-west-2',
    ],
    [
      'ol-ap-123456789012.s3-object-lambda.us-east-1.amazonaws.com',
      's3-object-lambda',
      'us-east-1',
    ],
  ])('%s → %s / %s', (host, service, region) => {
    expect(inferAwsScope(host)).toEqual({ service, region });
  });

  it.each(['example.com', 'amazonaws.com', 'sts.amazonaws.com.evil.example', 'a..amazonaws.com'])(
    'should not place %s',
    (host) => {
      expect(inferAwsScope(host)).toBeNull();
    },
  );
});

// ── signProxyRequest ───────────────────────────────────────────────────────

const creds = {
  AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

describe('signProxyRequest', () => {
  it('should infer sts / us-east-1 for the global STS endpoint', async () => {
    const { headers } = await signProxyRequest({
      method: 'POST',
      url: 'https://sts.amazonaws.com/',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body: 'Action=GetCallerIdentity&Version=2011-06-15',
      config: {},
      secrets: creds,
      now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(headers['x-amz-content-sha256']).toBe(
      crypto
        .createHash('sha256')
        .update('Action=GetCallerIdentity&Version=2011-06-15')
        .digest('hex'),
    );
  });

  it('should let explicit service/region override inference', async () => {
    const { headers } = await signProxyRequest({
      method: 'GET',
      url: 'https://data-ats.iot.us-east-1.amazonaws.com/things',
      headers: {},
      body: undefined,
      config: { service: 'iotdata', region: 'eu-west-1' },
      secrets: creds,
    });
    expect(headers.authorization).toContain('/eu-west-1/iotdata/aws4_request');
  });

  it('should refuse to sign for a host it cannot place without an explicit scope', async () => {
    await expect(
      signProxyRequest({
        method: 'GET',
        url: 'https://example.com/',
        headers: {},
        body: undefined,
        config: {},
        secrets: creds,
      }),
    ).rejects.toThrow('awsSigV4.service and awsSigV4.region');
  });

  it.each([
    [{}, 'AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY'],
    [{ AWS_ACCESS_KEY_ID: 'AKID' }, 'AWS_SECRET_ACCESS_KEY'],
    [{ AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: 'x' }, 'AWS_ACCESS_KEY_ID'],
    [
      { AWS_ACCESS_KEY_ID: '${AWS_ACCESS_KEY_ID}', AWS_SECRET_ACCESS_KEY: 'x' },
      'AWS_ACCESS_KEY_ID',
    ],
  ])('should refuse to sign with missing credentials %#', async (secrets, missing) => {
    await expect(
      signProxyRequest({
        method: 'GET',
        url: 'https://sts.amazonaws.com/',
        headers: {},
        body: undefined,
        config: {},
        secrets,
      }),
    ).rejects.toThrow(`AWS credentials not configured for this caller: ${missing}`);
  });

  it('should add and sign the session token only when one is set', async () => {
    const base = {
      method: 'GET',
      url: 'https://sts.amazonaws.com/',
      headers: {},
      body: undefined,
      config: {},
    };
    const without = await signProxyRequest({ ...base, secrets: creds });
    expect(without.headers).not.toHaveProperty('x-amz-security-token');

    const withToken = await signProxyRequest({
      ...base,
      secrets: { ...creds, AWS_SESSION_TOKEN: 'session-tok' },
    });
    expect(withToken.headers['x-amz-security-token']).toBe('session-tok');
    expect(withToken.headers.authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,',
    );
  });

  it('should drop reserved headers and leave hop-by-hop headers unsigned', async () => {
    const { headers } = await signProxyRequest({
      method: 'GET',
      url: 'https://sts.amazonaws.com/',
      headers: {
        Authorization: 'Bearer spoof',
        'X-Amz-Date': '20000101T000000Z',
        'User-Agent': 'agent/1.0',
        'X-Amz-Target': 'Svc.Op',
      },
      body: undefined,
      config: {},
      secrets: creds,
    });
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(headers['x-amz-date']).not.toBe('20000101T000000Z');
    expect(headers['user-agent']).toBe('agent/1.0');
    expect(headers.authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-target,',
    );
  });
});

// ── End to end through executeProxyRequest ─────────────────────────────────

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Re-derive the signature from what the server received. Uses the SignedHeaders
 * list from the Authorization header and the header values as they arrived.
 */
function verifyReceived(r: Received, secretAccessKey: string): void {
  const auth = String(r.headers.authorization);
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  expect(m, auth).not.toBeNull();
  const [, accessKeyId, , region, service, signedHeaderList, signature] = m!;

  const q = r.url.indexOf('?');
  const signerAdded = new Set(['x-amz-date', 'x-amz-content-sha256', 'x-amz-security-token']);
  const headers = signedHeaderList
    .split(';')
    .filter((h) => !signerAdded.has(h))
    .map((h): [string, string] => [h, String(r.headers[h])]);

  const amzDate = String(r.headers['x-amz-date']);
  const date = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`,
  );

  const expected = signSigV4(
    {
      method: r.method,
      path: q === -1 ? r.url : r.url.slice(0, q),
      query: q === -1 ? '' : r.url.slice(q + 1),
      headers,
      body: r.body,
    },
    {
      service,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
        sessionToken: r.headers['x-amz-security-token'] as string | undefined,
      },
      date,
      signPayloadHeader: signedHeaderList.includes('x-amz-content-sha256'),
      uriEscapePath: service !== 's3',
    },
  );

  expect(signature).toBe(expected.signature);
  expect(r.headers['x-amz-content-sha256']).toBe(
    crypto.createHash('sha256').update(r.body).digest('hex'),
  );
}

describe('executeProxyRequest with awsSigV4', () => {
  let server: http.Server;
  let base: string;
  let received: Received[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        if (req.url === '/redirect') {
          res.statusCode = 302;
          res.setHeader('location', `${base}/target`);
          res.end();
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
    received = [];
    return {
      alias: 'aws',
      headers: {},
      secrets: { ...creds, AWS_SESSION_TOKEN: 'FQoGZXIvYXdzEXAMPLE//token+/=' },
      allowedEndpoints: [`${base}/**`],
      resolveSecretsInBody: false,
      awsSigV4: { service: 'sts', region: 'us-east-1' },
      ...overrides,
    };
  }

  it('should sign a GET whose path and query need encoding', async () => {
    const r = route();
    const result = await executeProxyRequest(
      {
        method: 'GET',
        url: `${base}/a b/c%2Fd/ሴ/?Version=2011-06-15&Action=List Users&empty=&x=a+b&%E1%88%B4=1`,
      },
      [r],
    );
    expect(result.status).toBe(200);
    expect(received).toHaveLength(1);
    verifyReceived(received[0], creds.AWS_SECRET_ACCESS_KEY);
    expect(received[0].headers['x-amz-security-token']).toBe('FQoGZXIvYXdzEXAMPLE//token+/=');
  });

  it('should sign a form-encoded POST body (the STS testConnection shape)', async () => {
    await executeProxyRequest(
      {
        method: 'POST',
        url: `${base}/`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
        body: 'Action=GetCallerIdentity&Version=2011-06-15',
      },
      [route()],
    );
    verifyReceived(received[0], creds.AWS_SECRET_ACCESS_KEY);
    expect(received[0].body.toString()).toBe('Action=GetCallerIdentity&Version=2011-06-15');
    expect(received[0].headers.authorization).toContain('content-type;host;');
  });

  it('should sign a JSON body with a non-ASCII payload and an x-amz-target header', async () => {
    await executeProxyRequest(
      {
        method: 'POST',
        url: `${base}/`,
        headers: {
          'Content-Type': 'application/x-amz-json-1.0',
          'X-Amz-Target': 'DynamoDB_20120810.ListTables',
        },
        body: { Limit: 5, note: 'café ☕' },
      },
      [route()],
    );
    verifyReceived(received[0], creds.AWS_SECRET_ACCESS_KEY);
    expect(received[0].headers.authorization).toContain('x-amz-target');
  });

  it('should keep fetch()’s default content-type for a bare string body', async () => {
    await executeProxyRequest({ method: 'PUT', url: `${base}/obj`, body: 'hello' }, [route()]);
    verifyReceived(received[0], creds.AWS_SECRET_ACCESS_KEY);
    expect(received[0].headers['content-type']).toBe('text/plain;charset=UTF-8');
  });

  it('should sign a multipart body byte for byte', async () => {
    await executeProxyRequest(
      {
        method: 'POST',
        url: `${base}/upload`,
        body: { a: 1 },
        files: [
          {
            field: 'file',
            data: Buffer.from('file-bytes').toString('base64'),
            filename: 'f.txt',
            contentType: 'text/plain',
          },
        ],
      },
      [route()],
    );
    verifyReceived(received[0], creds.AWS_SECRET_ACCESS_KEY);
    expect(String(received[0].headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(received[0].body.toString()).toContain('file-bytes');
  });

  it('should sign S3-style paths without double-encoding', async () => {
    await executeProxyRequest({ method: 'GET', url: `${base}/my bucket/key%20with%20spaces.txt` }, [
      route({ awsSigV4: { service: 's3', region: 'us-west-2' } }),
    ]);
    verifyReceived(received[0], creds.AWS_SECRET_ACCESS_KEY);
  });

  it('should ignore an Authorization header set by the route itself', async () => {
    await executeProxyRequest({ method: 'GET', url: `${base}/` }, [
      route({ headers: { Authorization: 'Bearer static' } }),
    ]);
    expect(received[0].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    verifyReceived(received[0], creds.AWS_SECRET_ACCESS_KEY);
  });

  it.each([
    'Authorization',
    'authorization',
    'Host',
    'X-Amz-Date',
    'x-amz-content-sha256',
    'X-Amz-Security-Token',
  ])('should reject a caller-supplied %s header without sending anything', async (name) => {
    await expect(
      executeProxyRequest({ method: 'GET', url: `${base}/`, headers: { [name]: 'spoof' } }, [
        route(),
      ]),
    ).rejects.toThrow(/set by drawlatch's AWS SigV4 signer/);
    expect(received).toHaveLength(0);
  });

  it.each(['X-Amz-Signature', 'x-amz-credential', 'X-Amz-Algorithm'])(
    'should reject a presigned-URL %s query parameter',
    async (param) => {
      await expect(
        executeProxyRequest({ method: 'GET', url: `${base}/?${param}=x` }, [route()]),
      ).rejects.toThrow(/not allowed on an AWS SigV4 route/);
      expect(received).toHaveLength(0);
    },
  );

  it('should still allow caller x-amz-* headers that are not signer-owned', async () => {
    await executeProxyRequest(
      { method: 'PUT', url: `${base}/k`, headers: { 'x-amz-meta-owner': 'me' }, body: 'x' },
      [route({ awsSigV4: { service: 's3', region: 'us-east-1' } })],
    );
    expect(received[0].headers['x-amz-meta-owner']).toBe('me');
    expect(received[0].headers.authorization).toContain('x-amz-meta-owner');
  });

  it('should fail without sending when credentials are missing', async () => {
    await expect(
      executeProxyRequest({ method: 'GET', url: `${base}/` }, [route({ secrets: {} })]),
    ).rejects.toThrow('AWS credentials not configured');
    expect(received).toHaveLength(0);
  });

  describe('signing credentials are never substituted', () => {
    const leak = (name: string) => `\${${name}}`;

    it.each(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'])(
      'should reject %s in the URL',
      async (name) => {
        await expect(
          executeProxyRequest({ method: 'GET', url: `${base}/${leak(name)}` }, [route()]),
        ).rejects.toThrow(`The request URL references ${leak(name)}, a signing credential`);
        expect(received).toHaveLength(0);
      },
    );

    it('should reject a signing credential in the query string', async () => {
      await expect(
        executeProxyRequest({ method: 'GET', url: `${base}/?k=${leak('AWS_SECRET_ACCESS_KEY')}` }, [
          route(),
        ]),
      ).rejects.toThrow('signing credential');
      expect(received).toHaveLength(0);
    });

    it.each(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'])(
      'should reject %s in a caller header',
      async (name) => {
        await expect(
          executeProxyRequest(
            { method: 'GET', url: `${base}/`, headers: { 'X-Leak': `x ${leak(name)}` } },
            [route()],
          ),
        ).rejects.toThrow(`Header "X-Leak" references ${leak(name)}`);
        expect(received).toHaveLength(0);
      },
    );

    it.each([
      ['string', `a=${leak('AWS_SECRET_ACCESS_KEY')}`],
      ['JSON', { note: leak('AWS_SECRET_ACCESS_KEY') }],
    ])('should reject a signing credential in a resolved %s body', async (_kind, body) => {
      await expect(
        executeProxyRequest({ method: 'POST', url: `${base}/`, body }, [
          route({ resolveSecretsInBody: true }),
        ]),
      ).rejects.toThrow('The request body references ${AWS_SECRET_ACCESS_KEY}');
      expect(received).toHaveLength(0);
    });

    it('should reject a signing credential in a resolved multipart payload', async () => {
      await expect(
        executeProxyRequest(
          {
            method: 'POST',
            url: `${base}/`,
            body: { k: leak('AWS_ACCESS_KEY_ID') },
            files: [{ field: 'f', data: '', filename: 'f', contentType: 'text/plain' }],
          },
          [route({ resolveSecretsInBody: true })],
        ),
      ).rejects.toThrow('signing credential');
      expect(received).toHaveLength(0);
    });

    it('should send an unresolved body placeholder literally, as on any route', async () => {
      await executeProxyRequest(
        { method: 'POST', url: `${base}/`, body: leak('AWS_SECRET_ACCESS_KEY') },
        [route()],
      );
      expect(received[0].body.toString()).toBe(leak('AWS_SECRET_ACCESS_KEY'));
    });

    it('should withhold another secret that holds a credential value', async () => {
      const r = route({
        secrets: { ...creds, ALIAS: creds.AWS_SECRET_ACCESS_KEY, OTHER: 'fine-value' },
      });
      await expect(
        executeProxyRequest({ method: 'GET', url: `${base}/${leak('ALIAS')}` }, [r]),
      ).rejects.toThrow('${ALIAS}');
      await executeProxyRequest(
        { method: 'GET', url: `${base}/x`, headers: { 'X-Other': leak('OTHER') } },
        [r],
      );
      expect(received[0].headers['x-other']).toBe('fine-value');
    });

    it('should withhold a secret whose value contains a credential', async () => {
      const r = route({
        secrets: { ...creds, WRAPPED: `pre-${creds.AWS_SECRET_ACCESS_KEY}-post` },
      });
      await expect(
        executeProxyRequest({ method: 'GET', url: `${base}/${leak('WRAPPED')}` }, [r]),
      ).rejects.toThrow('${WRAPPED}');
      expect(received).toHaveLength(0);
    });

    it('should not withhold everything when a credential is empty', async () => {
      const r = route({
        secrets: { ...creds, AWS_SESSION_TOKEN: '', OTHER: 'fine-value' },
      });
      await executeProxyRequest(
        { method: 'GET', url: `${base}/x`, headers: { 'X-Other': leak('OTHER') } },
        [r],
      );
      expect(received[0].headers['x-other']).toBe('fine-value');
    });

    it('should reject a connection header that references a signing credential', async () => {
      const [resolved] = resolveRoutes([
        {
          alias: 'aws',
          awsSigV4: { service: 'sts', region: 'us-east-1' },
          headers: { 'X-Key': `Key ${leak('AWS_SECRET_ACCESS_KEY')}` },
          secrets: {
            AWS_ACCESS_KEY_ID: creds.AWS_ACCESS_KEY_ID,
            AWS_SECRET_ACCESS_KEY: creds.AWS_SECRET_ACCESS_KEY,
          },
          allowedEndpoints: [`${base}/**`],
        },
      ]);
      expect(resolved.headers['X-Key']).toBe(`Key ${leak('AWS_SECRET_ACCESS_KEY')}`);
      received = [];
      await expect(
        executeProxyRequest({ method: 'GET', url: `${base}/` }, [resolved]),
      ).rejects.toThrow('Connection header "X-Key" references ${AWS_SECRET_ACCESS_KEY}');
      expect(received).toHaveLength(0);
    });
  });

  it('should return a redirect to the caller instead of following it', async () => {
    const result = await executeProxyRequest({ method: 'GET', url: `${base}/redirect` }, [route()]);
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe(`${base}/target`);
    expect(received.map((r) => r.url)).toEqual(['/redirect']);
  });

  it('should keep following redirects on routes without awsSigV4', async () => {
    const result = await executeProxyRequest({ method: 'GET', url: `${base}/redirect` }, [
      route({ awsSigV4: undefined }),
    ]);
    expect(result.status).toBe(200);
    expect(received.map((r) => r.url)).toEqual(['/redirect', '/target']);
  });

  it('should leave routes without awsSigV4 unsigned', async () => {
    await executeProxyRequest({ method: 'GET', url: `${base}/` }, [route({ awsSigV4: undefined })]);
    expect(received[0].headers.authorization).toBeUndefined();
    expect(received[0].headers['x-amz-date']).toBeUndefined();
  });
});

// ── Route resolution ───────────────────────────────────────────────────────

describe('aws template resolution', () => {
  it('should carry awsSigV4 through resolveRoutes and report it in list_routes', async () => {
    const [resolved] = resolveRoutes([{ ...loadConnection('aws'), alias: 'aws' }], {
      AWS_ACCESS_KEY_ID: 'AKID',
      AWS_SECRET_ACCESS_KEY: 'sk-unique-value',
    });
    expect(resolved.awsSigV4).toEqual({});
    expect(resolved.secrets).toMatchObject({ AWS_ACCESS_KEY_ID: 'AKID' });

    const routes = (await toolHandlers.list_routes({}, [resolved], {} as ToolContext)) as Record<
      string,
      unknown
    >[];
    expect(routes[0].awsSigV4).toEqual({});
    expect(JSON.stringify(routes)).not.toContain('sk-unique-value');
  });
});

// ── Wildcard hosts in allowedEndpoints ─────────────────────────────────────

describe('isEndpointAllowed — wildcard hosts', () => {
  const aws = ['https://*.amazonaws.com/**'];

  it.each([
    'https://sts.amazonaws.com/',
    'https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity',
    'https://my-bucket.s3.us-west-2.amazonaws.com/a/b.txt',
    'https://abc.execute-api.eu-west-1.amazonaws.com/prod/x',
  ])('should allow %s', (url) => {
    expect(isEndpointAllowed(url, aws)).toBe(true);
  });

  it.each([
    'https://evil.example?.amazonaws.com/',
    'https://evil.example#.amazonaws.com/',
    'https://evil.example?x=.amazonaws.com/path',
    'https://evil.example\\.amazonaws.com/',
    'http://sts.amazonaws.com/',
    'https://amazonaws.com.evil.example/',
    'https://sts.amazonaws.com.evil.example/',
  ])('should reject the lookalike %s', (url) => {
    expect(isEndpointAllowed(url, aws)).toBe(false);
  });

  it('should allow underscores in a wildcard-matched host', () => {
    expect(isEndpointAllowed('https://my_bucket.s3.amazonaws.com/k', aws)).toBe(true);
  });

  it.each([
    ['https://*.amazonaws.com:443/**', 'https://sts.amazonaws.com:443/'],
    ['http://*.example.test:80/**', 'http://a.example.test:80/x'],
  ])('should ignore an explicit default port in %s', (pattern, url) => {
    expect(isEndpointAllowed(url, [pattern])).toBe(true);
  });

  it('should still compare a non-default port', () => {
    expect(
      isEndpointAllowed('https://a.example.test:8443/', ['https://*.example.test:8443/**']),
    ).toBe(true);
    expect(isEndpointAllowed('https://a.example.test/', ['https://*.example.test:8443/**'])).toBe(
      false,
    );
  });

  it('should leave patterns without a host wildcard unchanged', () => {
    expect(isEndpointAllowed('https://api.github.com/user', ['https://api.github.com/**'])).toBe(
      true,
    );
    expect(isEndpointAllowed('/relative', ['**'])).toBe(true);
  });
});
