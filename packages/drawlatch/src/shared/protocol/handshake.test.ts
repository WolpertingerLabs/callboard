import { describe, it, expect } from 'vitest';
import { HandshakeInitiator, HandshakeResponder, type HandshakeInit } from './handshake.js';
import { generateKeyBundle, extractPublicKeys, EncryptedChannel } from '../crypto/index.js';

/** Helper: generate two identities and perform a full handshake */
function performHandshake() {
  const initiatorKeys = generateKeyBundle();
  const responderKeys = generateKeyBundle();
  const initiatorPub = extractPublicKeys(initiatorKeys);
  const responderPub = extractPublicKeys(responderKeys);

  const initiator = new HandshakeInitiator(initiatorKeys, responderPub);
  const responder = new HandshakeResponder(responderKeys, [initiatorPub]);

  // Step 1: Initiator creates init
  const init = initiator.createInit();

  // Step 2: Responder processes init
  const { reply } = responder.processInit(init);

  // Step 3: Initiator processes reply
  const initiatorSessionKeys = initiator.processReply(reply);

  // Responder derives keys
  const responderSessionKeys = responder.deriveKeys(init);

  // Step 3b: Initiator creates finish
  const finish = initiator.createFinish(initiatorSessionKeys);

  // Step 4: Responder verifies finish
  const verified = responder.verifyFinish(finish, responderSessionKeys);

  return {
    initiatorKeys,
    responderKeys,
    initiatorPub,
    responderPub,
    initiator,
    responder,
    init,
    reply,
    finish,
    initiatorSessionKeys,
    responderSessionKeys,
    verified,
  };
}

describe('HandshakeInitiator', () => {
  it('should create a valid init message', () => {
    const initiatorKeys = generateKeyBundle();
    const responderKeys = generateKeyBundle();
    const responderPub = extractPublicKeys(responderKeys);

    const initiator = new HandshakeInitiator(initiatorKeys, responderPub);
    const init = initiator.createInit();

    expect(init.type).toBe('handshake_init');
    expect(init.version).toBe(1);
    expect(init.signingPubKey).toContain('-----BEGIN PUBLIC KEY-----');
    expect(init.ephemeralPubKey).toContain('-----BEGIN PUBLIC KEY-----');
    expect(init.nonceI).toMatch(/^[0-9a-f]{64}$/); // 32 bytes = 64 hex chars
    expect(init.signature).toBeDefined();
    expect(init.signature.length).toBeGreaterThan(0);
  });

  it('should produce different nonces each time', () => {
    const initiatorKeys = generateKeyBundle();
    const responderKeys = generateKeyBundle();
    const responderPub = extractPublicKeys(responderKeys);

    const init1 = new HandshakeInitiator(initiatorKeys, responderPub).createInit();
    const init2 = new HandshakeInitiator(initiatorKeys, responderPub).createInit();

    expect(init1.nonceI).not.toBe(init2.nonceI);
    expect(init1.ephemeralPubKey).not.toBe(init2.ephemeralPubKey);
  });

  it('should reject a reply signed by a different responder', () => {
    const initiatorKeys = generateKeyBundle();
    const realResponderKeys = generateKeyBundle();
    const imposterKeys = generateKeyBundle();
    const realResponderPub = extractPublicKeys(realResponderKeys);
    const initiatorPub = extractPublicKeys(initiatorKeys);

    // Initiator expects the real responder
    const initiator = new HandshakeInitiator(initiatorKeys, realResponderPub);
    const init = initiator.createInit();

    // But the imposter responds instead
    const imposter = new HandshakeResponder(imposterKeys, [initiatorPub]);
    const { reply } = imposter.processInit(init);

    // Initiator should reject — reply is signed by imposter, not the expected responder
    expect(() => initiator.processReply(reply)).toThrow('responder signature invalid');
  });
});

describe('HandshakeResponder', () => {
  it('should process a valid init and return a reply', () => {
    const initiatorKeys = generateKeyBundle();
    const responderKeys = generateKeyBundle();
    const initiatorPub = extractPublicKeys(initiatorKeys);
    const responderPub = extractPublicKeys(responderKeys);

    const initiator = new HandshakeInitiator(initiatorKeys, responderPub);
    const init = initiator.createInit();

    const responder = new HandshakeResponder(responderKeys, [initiatorPub]);
    const { reply, initiatorPubKey } = responder.processInit(init);

    expect(reply.type).toBe('handshake_reply');
    expect(reply.ephemeralPubKey).toContain('-----BEGIN PUBLIC KEY-----');
    expect(reply.nonceR).toMatch(/^[0-9a-f]{64}$/);
    expect(reply.signature).toBeDefined();
    expect(initiatorPubKey).toBe(initiatorPub);
  });

  it('should reject unauthorized initiators', () => {
    const initiatorKeys = generateKeyBundle();
    const responderKeys = generateKeyBundle();
    const responderPub = extractPublicKeys(responderKeys);
    const unrelatedPub = extractPublicKeys(generateKeyBundle());

    const initiator = new HandshakeInitiator(initiatorKeys, responderPub);
    const init = initiator.createInit();

    // Responder only authorizes unrelatedPub, not the actual initiator
    const responder = new HandshakeResponder(responderKeys, [unrelatedPub]);

    expect(() => responder.processInit(init)).toThrow('initiator not authorized');
  });

  it('should reject invalid initiator signatures', () => {
    const initiatorKeys = generateKeyBundle();
    const responderKeys = generateKeyBundle();
    const initiatorPub = extractPublicKeys(initiatorKeys);
    const responderPub = extractPublicKeys(responderKeys);

    const initiator = new HandshakeInitiator(initiatorKeys, responderPub);
    const init = initiator.createInit();

    // Tamper with the signature
    const tamperedInit: HandshakeInit = {
      ...init,
      signature: init.signature.replace(/[0-9a-f]/, 'x'),
    };

    const responder = new HandshakeResponder(responderKeys, [initiatorPub]);
    expect(() => responder.processInit(tamperedInit)).toThrow();
  });

  it('should reject unsupported versions', () => {
    const initiatorKeys = generateKeyBundle();
    const responderKeys = generateKeyBundle();
    const initiatorPub = extractPublicKeys(initiatorKeys);
    const responderPub = extractPublicKeys(responderKeys);

    const initiator = new HandshakeInitiator(initiatorKeys, responderPub);
    const init = initiator.createInit();

    // Change version
    const badVersion = { ...init, version: 2 as 1 };

    const responder = new HandshakeResponder(responderKeys, [initiatorPub]);
    expect(() => responder.processInit(badVersion)).toThrow('Unsupported handshake version');
  });

  it('should throw if deriveKeys called before processInit', () => {
    const responderKeys = generateKeyBundle();
    const responder = new HandshakeResponder(responderKeys, []);
    const fakeInit = {} as HandshakeInit;

    expect(() => responder.deriveKeys(fakeInit)).toThrow('Must call processInit() first');
  });
});

describe('Full handshake flow', () => {
  it('should complete successfully and verify the finish message', () => {
    const result = performHandshake();
    expect(result.verified).toBe(true);
  });

  it('should produce matching session IDs on both sides', () => {
    const result = performHandshake();
    expect(result.initiatorSessionKeys.sessionId).toBe(result.responderSessionKeys.sessionId);
  });

  it('should produce complementary send/recv keys', () => {
    const result = performHandshake();

    // Initiator's sendKey == Responder's recvKey
    expect(
      result.initiatorSessionKeys.sendKey.encryptionKey.equals(
        result.responderSessionKeys.recvKey.encryptionKey,
      ),
    ).toBe(true);

    // Initiator's recvKey == Responder's sendKey
    expect(
      result.initiatorSessionKeys.recvKey.encryptionKey.equals(
        result.responderSessionKeys.sendKey.encryptionKey,
      ),
    ).toBe(true);
  });

  it('should enable encrypted communication after handshake', () => {
    const result = performHandshake();

    const initiatorChannel = new EncryptedChannel(result.initiatorSessionKeys);
    const responderChannel = new EncryptedChannel(result.responderSessionKeys);

    // Initiator -> Responder
    const msg = { type: 'test', payload: 'hello from handshake' };
    const encrypted = initiatorChannel.encryptJSON(msg);
    const decrypted = responderChannel.decryptJSON(encrypted);
    expect(decrypted).toEqual(msg);

    // Responder -> Initiator
    const reply = { type: 'reply', payload: 'acknowledged' };
    const encReply = responderChannel.encryptJSON(reply);
    const decReply = initiatorChannel.decryptJSON(encReply);
    expect(decReply).toEqual(reply);
  });

  it('should fail verification with tampered finish payload', () => {
    const initiatorKeys = generateKeyBundle();
    const responderKeys = generateKeyBundle();
    const initiatorPub = extractPublicKeys(initiatorKeys);
    const responderPub = extractPublicKeys(responderKeys);

    const initiator = new HandshakeInitiator(initiatorKeys, responderPub);
    const responder = new HandshakeResponder(responderKeys, [initiatorPub]);

    const init = initiator.createInit();
    const { reply } = responder.processInit(init);
    const initiatorSessionKeys = initiator.processReply(reply);
    const responderSessionKeys = responder.deriveKeys(init);

    const finish = initiator.createFinish(initiatorSessionKeys);

    // Tamper with the finish payload. payload is hex, so flip the first nibble
    // to a guaranteed-different value — replacing the first [0-9a-f] with '0'
    // was a no-op whenever that char was already '0' (~1/16 of runs), leaving
    // the payload intact and the verification (correctly) passing → flaky.
    const tampered = {
      ...finish,
      payload: finish.payload.replace(/[0-9a-f]/, (c) => (c === '0' ? '1' : '0')),
    };

    const verified = responder.verifyFinish(tampered, responderSessionKeys);
    // The tampered ciphertext must fail authenticated decryption; verifyFinish
    // catches the exception and returns false.
    expect(verified).toBe(false);
  });

  it('should produce different session keys for each handshake', () => {
    const result1 = performHandshake();
    const result2 = performHandshake();

    expect(result1.initiatorSessionKeys.sessionId).not.toBe(result2.initiatorSessionKeys.sessionId);
  });

  it('should support multiple authorized peers', () => {
    const peer1Keys = generateKeyBundle();
    const peer2Keys = generateKeyBundle();
    const responderKeys = generateKeyBundle();

    const peer1Pub = extractPublicKeys(peer1Keys);
    const peer2Pub = extractPublicKeys(peer2Keys);
    const responderPub = extractPublicKeys(responderKeys);

    // Responder authorizes both peers
    const responder = new HandshakeResponder(responderKeys, [peer1Pub, peer2Pub]);

    // Peer 2 initiates
    const initiator = new HandshakeInitiator(peer2Keys, responderPub);
    const init = initiator.createInit();
    const { reply, initiatorPubKey } = responder.processInit(init);

    expect(initiatorPubKey).toBe(peer2Pub);

    const sessionKeys = initiator.processReply(reply);
    expect(sessionKeys.sessionId).toBeDefined();
  });
});
