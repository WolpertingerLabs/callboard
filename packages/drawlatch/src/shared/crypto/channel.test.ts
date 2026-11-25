import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { deriveSessionKeys, EncryptedChannel, type SessionKeys } from './channel.js';

/** Create a matching pair of session keys (initiator + responder) */
function createKeyPair(): { initiatorKeys: SessionKeys; responderKeys: SessionKeys } {
  const sharedSecret = crypto.randomBytes(32);
  const handshakeHash = crypto.randomBytes(32);

  const initiatorKeys = deriveSessionKeys(sharedSecret, true, handshakeHash);
  const responderKeys = deriveSessionKeys(sharedSecret, false, handshakeHash);

  return { initiatorKeys, responderKeys };
}

describe('deriveSessionKeys', () => {
  it('should derive session keys with sendKey, recvKey, and sessionId', () => {
    const sharedSecret = crypto.randomBytes(32);
    const handshakeHash = crypto.randomBytes(32);
    const keys = deriveSessionKeys(sharedSecret, true, handshakeHash);

    expect(keys.sendKey).toBeDefined();
    expect(keys.sendKey.encryptionKey).toBeInstanceOf(Buffer);
    expect(keys.sendKey.encryptionKey).toHaveLength(32);

    expect(keys.recvKey).toBeDefined();
    expect(keys.recvKey.encryptionKey).toBeInstanceOf(Buffer);
    expect(keys.recvKey.encryptionKey).toHaveLength(32);

    expect(keys.sessionId).toBeDefined();
    expect(typeof keys.sessionId).toBe('string');
    expect(keys.sessionId).toHaveLength(32); // 16 bytes hex = 32 chars
  });

  it('should derive different send and recv keys', () => {
    const sharedSecret = crypto.randomBytes(32);
    const handshakeHash = crypto.randomBytes(32);
    const keys = deriveSessionKeys(sharedSecret, true, handshakeHash);

    expect(keys.sendKey.encryptionKey.equals(keys.recvKey.encryptionKey)).toBe(false);
  });

  it('should produce complementary keys for initiator and responder', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();

    // Initiator's sendKey should equal responder's recvKey (and vice versa)
    expect(initiatorKeys.sendKey.encryptionKey.equals(responderKeys.recvKey.encryptionKey)).toBe(
      true,
    );
    expect(initiatorKeys.recvKey.encryptionKey.equals(responderKeys.sendKey.encryptionKey)).toBe(
      true,
    );
  });

  it('should produce the same sessionId for both sides', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    expect(initiatorKeys.sessionId).toBe(responderKeys.sessionId);
  });

  it('should produce different keys for different shared secrets', () => {
    const hash = crypto.randomBytes(32);
    const keys1 = deriveSessionKeys(crypto.randomBytes(32), true, hash);
    const keys2 = deriveSessionKeys(crypto.randomBytes(32), true, hash);

    expect(keys1.sendKey.encryptionKey.equals(keys2.sendKey.encryptionKey)).toBe(false);
    expect(keys1.sessionId).not.toBe(keys2.sessionId);
  });

  it('should produce different keys for different handshake hashes', () => {
    const secret = crypto.randomBytes(32);
    const keys1 = deriveSessionKeys(secret, true, crypto.randomBytes(32));
    const keys2 = deriveSessionKeys(secret, true, crypto.randomBytes(32));

    expect(keys1.sendKey.encryptionKey.equals(keys2.sendKey.encryptionKey)).toBe(false);
  });
});

describe('EncryptedChannel', () => {
  it('should encrypt and decrypt a message between paired channels', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    const plaintext = Buffer.from('hello, encrypted world!');
    const encrypted = initiator.encrypt(plaintext);
    const decrypted = responder.decrypt(encrypted);

    expect(decrypted.toString()).toBe('hello, encrypted world!');
  });

  it('should support bidirectional communication', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    // initiator -> responder
    const msg1 = Buffer.from('from initiator');
    const enc1 = initiator.encrypt(msg1);
    expect(responder.decrypt(enc1).toString()).toBe('from initiator');

    // responder -> initiator
    const msg2 = Buffer.from('from responder');
    const enc2 = responder.encrypt(msg2);
    expect(initiator.decrypt(enc2).toString()).toBe('from responder');
  });

  it('should expose sessionId', () => {
    const { initiatorKeys } = createKeyPair();
    const channel = new EncryptedChannel(initiatorKeys);
    expect(channel.sessionId).toBe(initiatorKeys.sessionId);
  });

  it('should expose underlying keys via getKeys()', () => {
    const { initiatorKeys } = createKeyPair();
    const channel = new EncryptedChannel(initiatorKeys);
    expect(channel.getKeys()).toBe(initiatorKeys);
  });

  it('should encrypt multiple messages with incrementing counters', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    for (let i = 0; i < 10; i++) {
      const msg = Buffer.from(`message ${i}`);
      const encrypted = initiator.encrypt(msg);
      const decrypted = responder.decrypt(encrypted);
      expect(decrypted.toString()).toBe(`message ${i}`);
    }
  });

  it('should reject replayed messages (duplicate counter)', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    const msg1 = initiator.encrypt(Buffer.from('first'));
    initiator.encrypt(Buffer.from('second')); // advance sender counter

    // Decrypt first message
    responder.decrypt(msg1);

    // Replay first message — same counter, should be rejected
    expect(() => responder.decrypt(msg1)).toThrow('Duplicate counter');
  });

  it('should accept out-of-order messages within the anti-replay window', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    const msg0 = initiator.encrypt(Buffer.from('first'));
    const msg1 = initiator.encrypt(Buffer.from('second'));
    const msg2 = initiator.encrypt(Buffer.from('third'));

    // Deliver out of order: msg2, msg0, msg1
    expect(responder.decrypt(msg2).toString()).toBe('third');
    expect(responder.decrypt(msg0).toString()).toBe('first');
    expect(responder.decrypt(msg1).toString()).toBe('second');
  });

  it('should reject duplicate of an out-of-order message', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    const msg0 = initiator.encrypt(Buffer.from('first'));
    const msg1 = initiator.encrypt(Buffer.from('second'));

    // Deliver msg1 first (out of order), then msg0 — both succeed
    responder.decrypt(msg1);
    responder.decrypt(msg0);

    // Replay msg0 — should be rejected as duplicate
    expect(() => responder.decrypt(msg0)).toThrow('Duplicate counter');
  });

  it('should reject counters that have fallen outside the anti-replay window', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    // Capture an early message
    const earlyMsg = initiator.encrypt(Buffer.from('early'));

    // Advance the sender counter well past the window (256+)
    const messages: Buffer[] = [];
    for (let i = 0; i < 257; i++) {
      messages.push(initiator.encrypt(Buffer.from(`msg-${i}`)));
    }

    // Decrypt all the later messages to advance the receiver's window
    for (const msg of messages) {
      responder.decrypt(msg);
    }

    // Now try the early message — its counter is outside the window
    expect(() => responder.decrypt(earlyMsg)).toThrow('too old');
  });

  it('should reject tampered messages', () => {
    const { initiatorKeys, responderKeys } = createKeyPair();
    const initiator = new EncryptedChannel(initiatorKeys);
    const responder = new EncryptedChannel(responderKeys);

    const encrypted = initiator.encrypt(Buffer.from('sensitive data'));

    // Tamper with the ciphertext (last byte)
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff;

    expect(() => responder.decrypt(tampered)).toThrow();
  });

  it('should reject messages that are too short', () => {
    const { responderKeys } = createKeyPair();
    const responder = new EncryptedChannel(responderKeys);

    // Minimum is IV(12) + AuthTag(16) + Counter(8) = 36 bytes
    const tooShort = Buffer.alloc(35);
    expect(() => responder.decrypt(tooShort)).toThrow('Message too short');
  });

  it('should reject messages encrypted with wrong key', () => {
    const pair1 = createKeyPair();
    const pair2 = createKeyPair();

    const sender = new EncryptedChannel(pair1.initiatorKeys);
    const wrongReceiver = new EncryptedChannel(pair2.responderKeys);

    const encrypted = sender.encrypt(Buffer.from('secret'));
    expect(() => wrongReceiver.decrypt(encrypted)).toThrow();
  });

  describe('encryptJSON / decryptJSON', () => {
    it('should round-trip JSON objects', () => {
      const { initiatorKeys, responderKeys } = createKeyPair();
      const initiator = new EncryptedChannel(initiatorKeys);
      const responder = new EncryptedChannel(responderKeys);

      const obj = { type: 'test', data: [1, 2, 3], nested: { key: 'value' } };
      const encrypted = initiator.encryptJSON(obj);
      const decrypted = responder.decryptJSON(encrypted);

      expect(decrypted).toEqual(obj);
    });

    it('should handle string values', () => {
      const { initiatorKeys, responderKeys } = createKeyPair();
      const initiator = new EncryptedChannel(initiatorKeys);
      const responder = new EncryptedChannel(responderKeys);

      const encrypted = initiator.encryptJSON('just a string');
      const decrypted = responder.decryptJSON(encrypted);

      expect(decrypted).toBe('just a string');
    });

    it('should handle null and numbers', () => {
      const { initiatorKeys, responderKeys } = createKeyPair();
      const initiator = new EncryptedChannel(initiatorKeys);
      const responder = new EncryptedChannel(responderKeys);

      const encNull = initiator.encryptJSON(null);
      expect(responder.decryptJSON(encNull)).toBeNull();

      const encNum = initiator.encryptJSON(42);
      expect(responder.decryptJSON(encNum)).toBe(42);
    });

    it('should handle empty objects and arrays', () => {
      const { initiatorKeys, responderKeys } = createKeyPair();
      const initiator = new EncryptedChannel(initiatorKeys);
      const responder = new EncryptedChannel(responderKeys);

      const encObj = initiator.encryptJSON({});
      expect(responder.decryptJSON(encObj)).toEqual({});

      const encArr = initiator.encryptJSON([]);
      expect(responder.decryptJSON(encArr)).toEqual([]);
    });
  });
});
