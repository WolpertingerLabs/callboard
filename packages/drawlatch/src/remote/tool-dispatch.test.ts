/**
 * Unit tests for outbound request timeout resolution in tool-dispatch.ts.
 *
 * The three nested ceilings must fire innermost-first
 * (`upstream < local → remote < MCP client`) so that the only layer able to
 * cancel the upstream API call is the one that expires first. These tests pin
 * the precedence, clamping, and malformed-input behavior of that innermost
 * deadline.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ResolvedRoute } from '../shared/config.js';

import {
  resolveOutboundTimeout,
  applyOutboundBudget,
  executeProxyRequest,
  DEFAULT_OUTBOUND_TIMEOUT_MS,
  MAX_OUTBOUND_TIMEOUT_MS,
} from './tool-dispatch.js';
import { LOCAL_TIMEOUT_SLACK_MS } from '../shared/config.js';

// ── resolveOutboundTimeout ─────────────────────────────────────────────────

describe('resolveOutboundTimeout', () => {
  describe('fallback', () => {
    it('should use the module default when neither caller nor route specifies one', () => {
      expect(resolveOutboundTimeout(undefined, undefined)).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
    });

    it('should keep the default below the MCP client cap (60s) with room for slack', () => {
      expect(DEFAULT_OUTBOUND_TIMEOUT_MS + LOCAL_TIMEOUT_SLACK_MS).toBeLessThan(60_000);
    });
  });

  describe('precedence', () => {
    it('should prefer the route value over the module default', () => {
      expect(resolveOutboundTimeout(undefined, 120_000)).toBe(120_000);
    });

    it('should prefer the caller value over the module default', () => {
      expect(resolveOutboundTimeout(10_000, undefined)).toBe(10_000);
    });

    it('should prefer the caller value over the route value', () => {
      expect(resolveOutboundTimeout(45_000, 120_000)).toBe(45_000);
    });

    it('should let the caller request less than the route default', () => {
      expect(resolveOutboundTimeout(5_000, 180_000)).toBe(5_000);
    });
  });

  describe('clamping', () => {
    it('should clamp a caller value to the route ceiling', () => {
      expect(resolveOutboundTimeout(500_000, 120_000)).toBe(120_000);
    });

    it('should allow a caller value exactly at the route ceiling', () => {
      expect(resolveOutboundTimeout(120_000, 120_000)).toBe(120_000);
    });

    it('should clamp a caller value to the global max when the route sets none', () => {
      expect(resolveOutboundTimeout(999_999_999, undefined)).toBe(MAX_OUTBOUND_TIMEOUT_MS);
    });

    it('should clamp a route value above the global max', () => {
      expect(resolveOutboundTimeout(undefined, 999_999_999)).toBe(MAX_OUTBOUND_TIMEOUT_MS);
    });

    it('should clamp a caller value to the global max when the route ceiling also exceeds it', () => {
      expect(resolveOutboundTimeout(999_999_999, 999_999_999)).toBe(MAX_OUTBOUND_TIMEOUT_MS);
    });
  });

  describe('malformed values', () => {
    it.each([0, -1, -60_000, NaN, Infinity, -Infinity])(
      'should ignore a caller value of %p and fall back to the route value',
      (bad) => {
        expect(resolveOutboundTimeout(bad, 120_000)).toBe(120_000);
      },
    );

    it.each([0, -1, NaN, Infinity])(
      'should ignore a caller value of %p and fall back to the module default',
      (bad) => {
        expect(resolveOutboundTimeout(bad, undefined)).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
      },
    );

    it.each([0, -1, NaN, Infinity])(
      'should ignore a route value of %p and fall back to the module default',
      (bad) => {
        expect(resolveOutboundTimeout(undefined, bad)).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
      },
    );
  });

  // A present-but-unusable route value must fail *closed*. Treating it as
  // absent removes the ceiling and jumps to MAX_OUTBOUND_TIMEOUT_MS, silently
  // widening the bound the template author wrote — and templates are
  // hand-written JSON, so `"requestTimeoutMs": "45000"` is a plausible typo.
  describe('malformed route ceilings fail closed', () => {
    it.each([
      ['a numeric string', '45000'],
      ['null', null],
      ['zero', 0],
      ['negative', -1],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['a boolean', true],
      ['an object', {}],
    ])('should clamp a large request to the default when the route value is %s', (_label, bad) => {
      expect(resolveOutboundTimeout(999_999, bad)).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
      expect(resolveOutboundTimeout(999_999, bad)).not.toBe(MAX_OUTBOUND_TIMEOUT_MS);
    });

    it('should still honour a request smaller than the fallback ceiling', () => {
      expect(resolveOutboundTimeout(5_000, '45000')).toBe(5_000);
    });

    it('should treat only undefined as "no ceiling set"', () => {
      expect(resolveOutboundTimeout(999_999, undefined)).toBe(MAX_OUTBOUND_TIMEOUT_MS);
    });
  });

  describe('global maximum', () => {
    // Passing an AbortSignal does not disable undici's 300s headersTimeout, it
    // races it. Any effective deadline at or above 300s is unreachable: undici
    // fires first with UND_ERR_HEADERS_TIMEOUT wrapped in a bare TypeError.
    it("should stay below undici's 300s headers timeout", () => {
      expect(MAX_OUTBOUND_TIMEOUT_MS).toBeLessThan(300_000);
    });
  });
});

// ── applyOutboundBudget ────────────────────────────────────────────────────

describe('applyOutboundBudget', () => {
  it('should clamp the connection ceiling down to the budget', () => {
    expect(applyOutboundBudget(120_000, 25_000)).toBe(25_000);
  });

  it('should leave a ceiling already inside the budget alone', () => {
    expect(applyOutboundBudget(25_000, 180_000)).toBe(25_000);
  });

  // Two real callers arrive with no budget: the admin API, and an older
  // local proxy against a newer remote. `Math.min(ceiling, undefined - slack)` would be NaN.
  it('should treat an absent budget as no clamp, not zero', () => {
    expect(applyOutboundBudget(120_000, undefined)).toBe(120_000);
  });

  it.each([0, -1, NaN, Infinity, null, '25000'])(
    'should treat a malformed budget of %p as no clamp',
    (bad) => {
      expect(applyOutboundBudget(120_000, bad)).toBe(120_000);
    },
  );
});

// ── executeProxyRequest: outbound signal ───────────────────────────────────

function testRoute(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return {
    alias: 'test',
    headers: {},
    secrets: {},
    allowedEndpoints: ['https://api.example.com/**'],
    resolveSecretsInBody: false,
    ...overrides,
  };
}

/** Stub fetch, capture the init it was called with, return an empty 200. */
function stubFetch() {
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  return spy;
}

describe('executeProxyRequest outbound timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should always pass an abort signal (never a bare fetch)', async () => {
    const spy = stubFetch();

    await executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/thing' }, [
      testRoute(),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('should surface a timeout as a drawlatch error naming the URL and the deadline', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );

    await expect(
      executeProxyRequest(
        { method: 'POST', url: 'https://api.example.com/v1/slow', timeoutMs: 1_500 },
        [testRoute()],
      ),
    ).rejects.toThrow(
      'Upstream request timed out after 1500ms: POST https://api.example.com/v1/slow',
    );
  });

  it('should report the clamped deadline, not the requested one', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'TimeoutError'));

    await expect(
      executeProxyRequest(
        { method: 'GET', url: 'https://api.example.com/v1/slow', timeoutMs: 900_000 },
        [testRoute({ requestTimeoutMs: 60_000 })],
      ),
    ).rejects.toThrow('timed out after 60000ms');
  });

  it('should report the caller URL, not the secret-resolved URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('aborted', 'TimeoutError'));

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x?token=${TOKEN}' }, [
        testRoute({
          secrets: { TOKEN: 'super-secret-value' },
          allowedEndpoints: ['https://api.example.com/**'],
        }),
      ]),
    ).rejects.toThrow(/\$\{TOKEN\}/);
  });

  it('should pass through non-timeout errors unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [testRoute()]),
    ).rejects.toThrow('fetch failed');
  });
});

// ── executeProxyRequest: the body read is inside the deadline ──────────────

/**
 * `AbortSignal.timeout()` is one wall-clock budget spanning connect, headers,
 * *and* body. When an upstream dribbles out its response, the deadline fires
 * on `resp.json()` / `resp.text()`, not on `fetch()`. With the body read
 * outside the try/catch the caller got a bare `DOMException(TimeoutError)` —
 * precisely the opaque error the drawlatch deadline exists to replace.
 */
describe('executeProxyRequest body-read timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A Response whose headers arrive fine but whose body read never lands. */
  function stalledBody(contentType: string, err: Error): Response {
    return {
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': contentType }),
      json: () => Promise.reject(err),
      text: () => Promise.reject(err),
    } as unknown as Response;
  }

  it('should report a JSON body stall as a drawlatch timeout, not a raw DOMException', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      stalledBody(
        'application/json',
        new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      ),
    );

    await expect(
      executeProxyRequest(
        { method: 'GET', url: 'https://api.example.com/v1/slow-body', timeoutMs: 1_500 },
        [testRoute()],
      ),
    ).rejects.toThrow(
      'Upstream request timed out after 1500ms: GET https://api.example.com/v1/slow-body',
    );
  });

  it('should report a text body stall the same way', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      stalledBody('text/plain', new DOMException('aborted', 'TimeoutError')),
    );

    await expect(
      executeProxyRequest(
        { method: 'GET', url: 'https://api.example.com/v1/slow-body', timeoutMs: 2_000 },
        [testRoute()],
      ),
    ).rejects.toThrow('Upstream request timed out after 2000ms');
  });

  it('should not swallow a genuine body parse error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      stalledBody('application/json', new SyntaxError('Unexpected token < in JSON')),
    );

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [testRoute()]),
    ).rejects.toThrow('Unexpected token < in JSON');
  });
});

// ── executeProxyRequest: undici's own deadlines ────────────────────────────

describe('executeProxyRequest undici timeout classification', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** How undici surfaces its internal deadlines: a bare TypeError + cause. */
  function undiciError(message: string, name: string, code: string): TypeError {
    const cause = new Error('timeout');
    cause.name = name;
    (cause as Error & { code: string }).code = code;
    return new TypeError(message, { cause });
  }

  it('should distinguish a connect timeout from our own deadline firing', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      undiciError('fetch failed', 'ConnectTimeoutError', 'UND_ERR_CONNECT_TIMEOUT'),
    );

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [testRoute()]),
    ).rejects.toThrow(/Upstream never accepted the connection/);
  });

  it('should tell the caller that raising timeoutMs will not fix a connect timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      undiciError('fetch failed', 'ConnectTimeoutError', 'UND_ERR_CONNECT_TIMEOUT'),
    );

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [testRoute()]),
    ).rejects.toThrow(/Raising timeoutMs will not help/);
  });

  it.each([
    ['UND_ERR_HEADERS_TIMEOUT', 'HeadersTimeoutError', 'fetch failed'],
    ['UND_ERR_BODY_TIMEOUT', 'BodyTimeoutError', 'terminated'],
  ])('should route %s into the drawlatch timeout message', async (code, name, message) => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(undiciError(message, name, code));

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [testRoute()]),
    ).rejects.toThrow(/Upstream request timed out after 25000ms/);
  });
});

// ── executeProxyRequest: outbound budget clamping ──────────────────────────

describe('executeProxyRequest outbound budget', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Read back the deadline the request was actually armed with. */
  async function armedTimeout(
    input: Parameters<typeof executeProxyRequest>[0],
    route: ResolvedRoute,
    budget?: number,
  ): Promise<number> {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('x', 'TimeoutError'));
    try {
      await executeProxyRequest(input, [route], budget);
    } catch (err) {
      const m = /timed out after (\d+)ms/.exec(err instanceof Error ? err.message : '');
      if (m) return Number(m[1]);
    }
    throw new Error('expected a timeout error carrying the armed deadline');
  }

  const GET = { method: 'GET', url: 'https://api.example.com/v1/x' };

  it('should clamp a generous connection ceiling to a smaller budget', async () => {
    expect(await armedTimeout(GET, testRoute({ requestTimeoutMs: 180_000 }), 25_000)).toBe(25_000);
  });

  it('should clamp a caller timeoutMs to the budget', async () => {
    expect(
      await armedTimeout(
        { ...GET, timeoutMs: 120_000 },
        testRoute({ requestTimeoutMs: 180_000 }),
        30_000,
      ),
    ).toBe(30_000);
  });

  it('should leave the ceiling alone when the budget is larger', async () => {
    expect(await armedTimeout(GET, testRoute({ requestTimeoutMs: 45_000 }), 180_000)).toBe(45_000);
  });

  // The regression this whole mechanism guards against: an absent budget must
  // mean "no clamp", never zero. Math.min(ceiling, undefined - slack) is NaN,
  // and AbortSignal.timeout(NaN) rejects outright.
  it('should apply no clamp at all when the budget is absent', async () => {
    expect(await armedTimeout(GET, testRoute({ requestTimeoutMs: 180_000 }), undefined)).toBe(
      180_000,
    );
  });

  it('should not arm a NaN deadline when the budget is absent', async () => {
    const spy = stubFetch();

    await executeProxyRequest(GET, [testRoute({ requestTimeoutMs: 180_000 })], undefined);

    expect(spy.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(spy.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });

  // B5: raising the shipped local requestTimeout to 185s must not slow down
  // ordinary connections. A route with no requestTimeoutMs still gets 25s.
  it('should still give a route with no requestTimeoutMs the 25s default under a 185s budget', async () => {
    expect(await armedTimeout(GET, testRoute(), 180_000)).toBe(DEFAULT_OUTBOUND_TIMEOUT_MS);
  });

  it('should name the budget as the binding constraint when it clamps', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('x', 'TimeoutError'));

    await expect(
      executeProxyRequest(GET, [testRoute({ requestTimeoutMs: 120_000 })], 25_000),
    ).rejects.toThrow(
      /This connection allows 120000ms, but the local proxy's requestTimeout capped this call at 25000ms/,
    );
  });

  it('should not blame the budget when the connection ceiling is the binding one', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('x', 'TimeoutError'));

    await expect(
      executeProxyRequest(GET, [testRoute({ requestTimeoutMs: 25_000 })], 180_000),
    ).rejects.toThrow(/Raise timeoutMs/);
  });
});

// ── executeProxyRequest: secrets must not leak through error messages ──────

describe('executeProxyRequest secret hygiene', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should reject a header value with an embedded newline without echoing it', async () => {
    const spy = stubFetch();

    const attempt = executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [
      testRoute({ headers: { Authorization: 'Bearer SUPER\nSECRET' } }),
    ]);

    await expect(attempt).rejects.toThrow(/Invalid value for header "Authorization"/);
    await expect(attempt).rejects.not.toThrow(/SUPERSECRET|SUPER\nSECRET/);
    // Rejected before the request goes out, so fetch() never sees the value.
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([['\r'], ['\n'], ['\0']])(
    'should reject a header value containing %j',
    async (control) => {
      await expect(
        executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [
          testRoute({ headers: { 'x-api-key': `abc${control}def` } }),
        ]),
      ).rejects.toThrow(/carriage return, newline, or NUL/);
    },
  );

  it('should scrub resolved secrets out of a generic fetch error', async () => {
    // `Failed to parse URL from …` echoes the *resolved* URL. Reachable when a
    // user-defined allowedEndpoints of bare `**` matches a relative URL.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Failed to parse URL from /1/boards?key=abcd-super-secret-key'),
    );

    const attempt = executeProxyRequest({ method: 'GET', url: '/1/boards?key=${TRELLO_KEY}' }, [
      testRoute({
        secrets: { TRELLO_KEY: 'abcd-super-secret-key' },
        allowedEndpoints: ['**'],
      }),
    ]);

    await expect(attempt).rejects.not.toThrow(/abcd-super-secret-key/);
    await expect(attempt).rejects.toThrow(/\$\{TRELLO_KEY\}/);
  });

  it('should scrub a secret carried only on the cause chain', async () => {
    // undici's usual shape: a clean `fetch failed` wrapper over the real reason.
    // In-process hosts log the error object, which prints [cause].
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', {
        cause: new Error('connect ECONNREFUSED using key abcd-super-secret-key'),
      }),
    );

    const attempt = executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [
      testRoute({ secrets: { TOKEN: 'abcd-super-secret-key' } }),
    ]);

    await expect(attempt).rejects.not.toThrow(/abcd-super-secret-key/);
    await expect(attempt).rejects.toSatisfy((e: Error) => e.cause === undefined);
  });

  it('should not hang on a self-referencing cause chain', async () => {
    const looping = new TypeError('fetch failed');
    looping.cause = looping;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(looping);

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [
        testRoute({ secrets: { TOKEN: 'abcd-super-secret-key' } }),
      ]),
    ).rejects.toThrow('fetch failed');
  });

  it('should scrub the longest secret first so no tail survives', async () => {
    // INNER is a prefix of OUTER. Replacing INNER first would leave "ER-VALUE".
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Failed to parse URL from /x?k=tok-OUTER-VALUE'),
    );

    const attempt = executeProxyRequest({ method: 'GET', url: '/x?k=${OUTER}' }, [
      testRoute({
        secrets: { INNER: 'tok-OUT', OUTER: 'tok-OUTER-VALUE' },
        allowedEndpoints: ['**'],
      }),
    ]);

    await expect(attempt).rejects.toThrow(/\$\{OUTER\}/);
    await expect(attempt).rejects.not.toThrow(/ER-VALUE/);
  });

  it('should leave a generic error without secrets untouched', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

    await expect(
      executeProxyRequest({ method: 'GET', url: 'https://api.example.com/v1/x' }, [
        testRoute({ secrets: { TOKEN: 'abcd-super-secret-key' } }),
      ]),
    ).rejects.toThrow('fetch failed');
  });
});
