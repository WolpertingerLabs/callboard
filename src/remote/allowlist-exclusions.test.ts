/**
 * `!pattern` exclusions in allowedEndpoints: a URL an exclusion matches is
 * refused even when another entry allows it.
 */
import { describe, it, expect } from 'vitest';

import { connectionOverlapWarnings, type RemoteServerConfig } from '../shared/config.js';
import { validateOAuth2Route } from '../shared/connections.js';
import { isEndpointAllowed } from './url-policy.js';

const E = 'https://api.example.com/v1/events';
const PATTERNS = [E, `${E}/*`, `${E}/*?**`, `!${E}/watch`, `!${E}/watch?**`];

describe('allowlist exclusions', () => {
  it.each([
    [E, true],
    [`${E}/abc123`, true],
    [`${E}/abc123?x=1`, true],
    [`${E}/watcher`, true],
    [`${E}/watch`, false],
    [`${E}/watch?alt=json`, false],
    // Unreserved escapes decode upstream, so they can't dodge an exclusion.
    [`${E}/w%61tch`, false],
    [`${E}/%77%61%74%63%68?x=1`, false],
  ])('%s → %s', (url, allowed) => {
    expect(isEndpointAllowed(url, PATTERNS)).toBe(allowed);
  });

  it('canonicalizes an exclusion like any other pattern (case, default port)', () => {
    const patterns = [`${E}/*`, '!HTTPS://API.Example.com:443/v1/events/watch'];
    expect(isEndpointAllowed(`${E}/watch`, patterns)).toBe(false);
    expect(isEndpointAllowed('https://API.example.com:443/v1/events/watch', patterns)).toBe(false);
    expect(isEndpointAllowed(`${E}/abc`, patterns)).toBe(true);
  });

  it('does not decode reserved escapes for the exclusion check', () => {
    // %2F stays an escape: `watch%2Fx` is a different segment from `watch`.
    expect(isEndpointAllowed(`${E}/watch%2Fx`, PATTERNS)).toBe(true);
  });

  it('a list of only exclusions allows nothing; an empty list still allows everything', () => {
    expect(isEndpointAllowed(`${E}/a`, [`!${E}/watch`])).toBe(false);
    expect(isEndpointAllowed(`${E}/a`, [])).toBe(true);
  });

  it('exclusions are ignored by the token-endpoint reach check', () => {
    expect(() =>
      validateOAuth2Route(
        {
          alias: 'x',
          allowedEndpoints: ['https://api.example.com/**', '!**', '!https://auth.example.com/**'],
          secrets: { A: 'a', B: 'b', R: 'r' },
          oauth2: {
            tokenUrl: 'https://auth.example.com/token',
            grant: 'refresh_token',
            clientAuth: 'body',
            secretRefs: { clientId: 'A', clientSecret: 'B', refreshToken: 'R' },
          },
        },
        'connector',
      ),
    ).not.toThrow();
  });

  it('exclusions are ignored by the overlap warning', () => {
    const config: RemoteServerConfig = {
      host: '127.0.0.1',
      port: 0,
      rateLimitPerMinute: 60,
      connectors: [
        { alias: 'a', allowedEndpoints: [`${E}/*`] },
        { alias: 'b', allowedEndpoints: ['https://other.example.com/**', '!**'] },
      ],
      callers: { c: { connections: ['a', 'b'] } },
    };
    expect(connectionOverlapWarnings(config)).toEqual([]);
  });
});
