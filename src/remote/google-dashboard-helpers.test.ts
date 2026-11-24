/**
 * The Google editor's pure helpers (frontend/src/utils/googleSelection.ts),
 * run against the real catalog payload: when saving must be confirmed as a
 * widening, what must be re-consented, and the inline draft checks, which
 * must not be stricter than the daemon.
 */
import { describe, it, expect } from 'vitest';

import { catalogPayload } from './admin-google.js';
import { googleConsentScopes, validateGoogleSelection } from '../shared/google.js';
import {
  addedScopes,
  consentScopesOf,
  draftProblem,
  wideningReasons,
  type GoogleDraft,
} from '../../frontend/src/utils/googleSelection.js';
import type { AdminGoogleSelectionConfig } from './admin-types.js';

const catalog = catalogPayload();
const sa = (services: Record<string, string>, subject?: string): AdminGoogleSelectionConfig => ({
  auth: 'service-account',
  services,
  ...(subject !== undefined && { subject }),
});
const user = (services: Record<string, string>): AdminGoogleSelectionConfig => ({
  auth: 'user',
  services,
});
const draft = (d: Partial<GoogleDraft>): GoogleDraft => ({
  auth: 'service-account',
  services: {},
  subject: '',
  ...d,
});

describe('wideningReasons: confirm whenever reach could grow', () => {
  it('service account → user OAuth with the same scopes', () => {
    const lines = wideningReasons(catalog, sa({ sheets: 'edit' }), user({ sheets: 'edit' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Auth mode: service account → user OAuth/);
    expect(addedScopes(catalog, sa({ sheets: 'edit' }), user({ sheets: 'edit' }))).toEqual([]);
  });

  it('user OAuth → service account', () => {
    const lines = wideningReasons(
      catalog,
      user({ sheets: 'edit' }),
      sa({ sheets: 'edit' }, 'a@example.com'),
    );
    expect(lines[0]).toMatch(/^Auth mode: user OAuth → service account/);
    expect(lines).toContain('Acts as a@example.com for every selected service.');
  });

  it('a level that adds a scope (and a level change, which adds one)', () => {
    expect(
      wideningReasons(catalog, user({ sheets: 'edit' }), user({ sheets: 'edit', drive: 'read' })),
    ).toEqual([expect.stringMatching(/^drive · read: /)]);
    expect(wideningReasons(catalog, user({ sheets: 'edit' }), user({ sheets: 'read' }))).toEqual([
      expect.stringMatching(/^sheets · read: /),
    ]);
  });

  it('a subject set or changed', () => {
    expect(wideningReasons(catalog, sa({ docs: 'edit' }), sa({ docs: 'edit' }, 'a@x'))).toEqual([
      'Acts as a@x for every selected service.',
    ]);
    expect(
      wideningReasons(catalog, sa({ docs: 'edit' }, 'a@x'), sa({ docs: 'edit' }, 'b@x')),
    ).toEqual(['Acts as b@x for every selected service.']);
  });

  it('a first selection lists every level', () => {
    expect(wideningReasons(catalog, null, user({ docs: 'edit', slides: 'edit' }))).toEqual([
      expect.stringMatching(/^docs · edit: /),
      expect.stringMatching(/^slides · edit: /),
    ]);
  });

  it('pure narrowing needs no confirm', () => {
    expect(
      wideningReasons(catalog, user({ sheets: 'edit', drive: 'read' }), user({ sheets: 'edit' })),
    ).toEqual([]);
    expect(wideningReasons(catalog, sa({ docs: 'edit' }, 'a@x'), sa({ docs: 'edit' }))).toEqual([]);
    expect(
      wideningReasons(catalog, sa({ docs: 'edit' }, 'a@x'), sa({ docs: 'edit' }, 'a@x')),
    ).toEqual([]);
  });
});

describe('consent scopes and draft checks match the daemon', () => {
  it('consentScopesOf equals googleConsentScopes', () => {
    const sel = user({ gmail: 'read', drive: 'file', sheets: 'read', docs: 'edit' });
    expect(consentScopesOf(catalog, sel)).toEqual(
      googleConsentScopes(validateGoogleSelection(sel)),
    );
  });

  it.each(['a@b', 'alice@localhost', 'alice@example.com'])(
    'accepts %s, as the daemon does',
    (subject) => {
      expect(draftProblem(catalog, draft({ services: { gmail: 'read' }, subject }))).toBeNull();
      expect(() => validateGoogleSelection(sa({ gmail: 'read' }, subject))).not.toThrow();
    },
  );

  it.each(['alice', 'a b@c', '@x'])('refuses %s, as the daemon does', (subject) => {
    expect(draftProblem(catalog, draft({ services: { docs: 'edit' }, subject }))).toMatch(
      /subject must be an email address/,
    );
    expect(() => validateGoogleSelection(sa({ docs: 'edit' }, subject))).toThrow(
      'google.subject must be an email address',
    );
  });

  it('gmail with a service account needs a subject', () => {
    expect(draftProblem(catalog, draft({ services: { gmail: 'read' } }))).toMatch(
      /needs a subject/,
    );
  });
});
