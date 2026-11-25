/**
 * The docs that enumerate the built-in templates stay in step with
 * src/connections: README's count and CONNECTIONS.md's main table.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listAvailableConnections } from './connections.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name: string) => fs.readFileSync(path.join(ROOT, name), 'utf8');

describe('connection docs', () => {
  const templates = listAvailableConnections();

  it('README counts every template file', () => {
    const m = /\*\*(\d+) pre-built connections\*\*/.exec(read('README.md'));
    expect(m, 'README "**N pre-built connections**"').not.toBeNull();
    expect(Number(m?.[1])).toBe(templates.length);
  });

  it('CONNECTIONS.md "Available connections" lists exactly the templates', () => {
    const doc = read('CONNECTIONS.md');
    const start = doc.indexOf('## Available connections');
    const section = doc.slice(start, doc.indexOf('\n## ', start + 1));
    const rows = [...section.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
    expect(rows).toEqual([...rows].sort());
    expect([...rows].sort()).toEqual([...templates].sort());
  });
});
