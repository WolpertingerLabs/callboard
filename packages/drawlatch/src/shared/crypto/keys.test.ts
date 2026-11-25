import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateKeyBundle,
  extractPublicKeys,
  serializeKeyBundle,
  deserializeKeyBundle,
  serializePublicKeys,
  deserializePublicKeys,
  saveKeyBundle,
  loadKeyBundle,
  loadPublicKeys,
  fingerprint,
} from './keys.js';

describe('generateKeyBundle', () => {
  it('should generate a valid key bundle with signing and exchange keypairs', () => {
    const bundle = generateKeyBundle();

    expect(bundle.signing).toBeDefined();
    expect(bundle.signing.publicKey).toBeDefined();
    expect(bundle.signing.privateKey).toBeDefined();
    expect(bundle.exchange).toBeDefined();
    expect(bundle.exchange.publicKey).toBeDefined();
    expect(bundle.exchange.privateKey).toBeDefined();
  });

  it('should generate Ed25519 signing keys', () => {
    const bundle = generateKeyBundle();
    const pubExport = bundle.signing.publicKey.export({ type: 'spki', format: 'pem' });
    expect(pubExport).toContain('PUBLIC KEY');
  });

  it('should generate X25519 exchange keys', () => {
    const bundle = generateKeyBundle();
    const pubExport = bundle.exchange.publicKey.export({ type: 'spki', format: 'pem' });
    expect(pubExport).toContain('PUBLIC KEY');
  });

  it('should generate unique keys each time', () => {
    const bundle1 = generateKeyBundle();
    const bundle2 = generateKeyBundle();
    const pem1 = bundle1.signing.publicKey.export({ type: 'spki', format: 'pem' });
    const pem2 = bundle2.signing.publicKey.export({ type: 'spki', format: 'pem' });
    expect(pem1).not.toBe(pem2);
  });
});

describe('extractPublicKeys', () => {
  it('should extract only public keys from a full bundle', () => {
    const bundle = generateKeyBundle();
    const pub = extractPublicKeys(bundle);

    expect(pub.signing).toBe(bundle.signing.publicKey);
    expect(pub.exchange).toBe(bundle.exchange.publicKey);
  });

  it('should not include private keys', () => {
    const bundle = generateKeyBundle();
    const pub = extractPublicKeys(bundle);

    // PublicKeyBundle only has signing and exchange, both KeyObjects
    expect(pub).not.toHaveProperty('signing.privateKey');
    expect(pub).not.toHaveProperty('exchange.privateKey');
  });
});

describe('serializeKeyBundle / deserializeKeyBundle', () => {
  it('should round-trip through serialization', () => {
    const bundle = generateKeyBundle();
    const serialized = serializeKeyBundle(bundle);
    const restored = deserializeKeyBundle(serialized);

    // Compare by exporting to PEM
    const origSigningPub = bundle.signing.publicKey.export({ type: 'spki', format: 'pem' });
    const restoredSigningPub = restored.signing.publicKey.export({ type: 'spki', format: 'pem' });
    expect(origSigningPub).toBe(restoredSigningPub);

    const origExchangePub = bundle.exchange.publicKey.export({ type: 'spki', format: 'pem' });
    const restoredExchangePub = restored.exchange.publicKey.export({ type: 'spki', format: 'pem' });
    expect(origExchangePub).toBe(restoredExchangePub);
  });

  it('should produce PEM strings', () => {
    const bundle = generateKeyBundle();
    const serialized = serializeKeyBundle(bundle);

    expect(serialized.signing.publicKey).toContain('-----BEGIN PUBLIC KEY-----');
    expect(serialized.signing.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
    expect(serialized.exchange.publicKey).toContain('-----BEGIN PUBLIC KEY-----');
    expect(serialized.exchange.privateKey).toContain('-----BEGIN PRIVATE KEY-----');
  });
});

describe('serializePublicKeys / deserializePublicKeys', () => {
  it('should round-trip public keys through serialization', () => {
    const bundle = generateKeyBundle();
    const pub = extractPublicKeys(bundle);
    const serialized = serializePublicKeys(pub);
    const restored = deserializePublicKeys(serialized);

    const origPem = pub.signing.export({ type: 'spki', format: 'pem' });
    const restoredPem = restored.signing.export({ type: 'spki', format: 'pem' });
    expect(origPem).toBe(restoredPem);
  });

  it('should only contain public key PEM strings', () => {
    const bundle = generateKeyBundle();
    const pub = extractPublicKeys(bundle);
    const serialized = serializePublicKeys(pub);

    expect(serialized.signing).toContain('-----BEGIN PUBLIC KEY-----');
    expect(serialized.exchange).toContain('-----BEGIN PUBLIC KEY-----');
    expect(serialized.signing).not.toContain('PRIVATE');
    expect(serialized.exchange).not.toContain('PRIVATE');
  });
});

describe('saveKeyBundle / loadKeyBundle / loadPublicKeys', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-keys-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should save and load a full key bundle', () => {
    const bundle = generateKeyBundle();
    const keysDir = path.join(tmpDir, 'keys');
    saveKeyBundle(bundle, keysDir);

    const loaded = loadKeyBundle(keysDir);

    const origPem = bundle.signing.publicKey.export({ type: 'spki', format: 'pem' });
    const loadedPem = loaded.signing.publicKey.export({ type: 'spki', format: 'pem' });
    expect(origPem).toBe(loadedPem);

    const origExPem = bundle.exchange.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const loadedExPem = loaded.exchange.privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(origExPem).toBe(loadedExPem);
  });

  it('should create the expected PEM files', () => {
    const bundle = generateKeyBundle();
    const keysDir = path.join(tmpDir, 'keys');
    saveKeyBundle(bundle, keysDir);

    expect(fs.existsSync(path.join(keysDir, 'signing.pub.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keysDir, 'signing.key.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keysDir, 'exchange.pub.pem'))).toBe(true);
    expect(fs.existsSync(path.join(keysDir, 'exchange.key.pem'))).toBe(true);
  });

  it('should set proper file permissions', () => {
    const bundle = generateKeyBundle();
    const keysDir = path.join(tmpDir, 'keys');
    saveKeyBundle(bundle, keysDir);

    const pubMode = fs.statSync(path.join(keysDir, 'signing.pub.pem')).mode & 0o777;
    const privMode = fs.statSync(path.join(keysDir, 'signing.key.pem')).mode & 0o777;
    expect(pubMode).toBe(0o644);
    expect(privMode).toBe(0o600);
  });

  it('should load only public keys', () => {
    const bundle = generateKeyBundle();
    const keysDir = path.join(tmpDir, 'keys');
    saveKeyBundle(bundle, keysDir);

    const pub = loadPublicKeys(keysDir);
    expect(pub.signing).toBeDefined();
    expect(pub.exchange).toBeDefined();

    const origPem = bundle.signing.publicKey.export({ type: 'spki', format: 'pem' });
    const loadedPem = pub.signing.export({ type: 'spki', format: 'pem' });
    expect(origPem).toBe(loadedPem);
  });

  it('should create nested directories', () => {
    const bundle = generateKeyBundle();
    const keysDir = path.join(tmpDir, 'deep', 'nested', 'keys');
    saveKeyBundle(bundle, keysDir);

    expect(fs.existsSync(keysDir)).toBe(true);
    const loaded = loadKeyBundle(keysDir);
    expect(loaded.signing.publicKey).toBeDefined();
  });
});

describe('fingerprint', () => {
  it('should return a colon-separated hex string', () => {
    const bundle = generateKeyBundle();
    const pub = extractPublicKeys(bundle);
    const fp = fingerprint(pub);

    expect(fp).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){15}$/);
  });

  it('should produce consistent fingerprints for the same key', () => {
    const bundle = generateKeyBundle();
    const pub = extractPublicKeys(bundle);

    expect(fingerprint(pub)).toBe(fingerprint(pub));
  });

  it('should produce different fingerprints for different keys', () => {
    const bundle1 = generateKeyBundle();
    const bundle2 = generateKeyBundle();
    const pub1 = extractPublicKeys(bundle1);
    const pub2 = extractPublicKeys(bundle2);

    expect(fingerprint(pub1)).not.toBe(fingerprint(pub2));
  });

  it('should produce 16-byte (32 hex char) fingerprints', () => {
    const bundle = generateKeyBundle();
    const pub = extractPublicKeys(bundle);
    const fp = fingerprint(pub);
    const bytes = fp.split(':');
    expect(bytes).toHaveLength(16);
  });
});
