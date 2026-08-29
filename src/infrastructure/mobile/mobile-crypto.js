const zlib = require('zlib');
const nacl = require('tweetnacl');
const util = require('tweetnacl-util');

const KEY_BYTES = 32;

function encode(bytes) {
  return util.encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value, expectedBytes, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const bytes = util.decodeBase64(padded);
  if (expectedBytes !== null && bytes.length !== expectedBytes) throw new Error(`Invalid ${label}`);
  return bytes;
}

function createKeyPair() {
  const pair = nacl.box.keyPair();
  return { publicKey: encode(pair.publicKey), secretKey: encode(pair.secretKey) };
}

function sharedKey(secretKey, peerPublicKey) {
  return nacl.box.before(
    decode(peerPublicKey, KEY_BYTES, 'mobile public key'),
    decode(secretKey, KEY_BYTES, 'mobile secret key')
  );
}

function verificationCode(secretKey, peerPublicKey, pairingId) {
  if (typeof pairingId !== 'string' || !pairingId) throw new Error('Invalid pairing id');
  const context = util.decodeUTF8(`CodeAgentSwarm pairing v2\0${pairingId}`);
  const material = new Uint8Array(context.length + KEY_BYTES);
  material.set(context);
  material.set(sharedKey(secretKey, peerPublicKey), context.length);
  const digest = nacl.hash(material);
  const value = (((digest[0] << 24) >>> 0) + (digest[1] << 16) + (digest[2] << 8) + digest[3]) % 1_000_000;
  return String(value).padStart(6, '0');
}

// `codec` is optional and only 'deflate' is understood: the JSON bytes are raw-deflated
// before encryption, for phones that negotiated it. Callers that omit it keep sending
// plain JSON boxes, which is what every unnegotiated client still expects.
function encryptJson(payload, secretKey, peerPublicKey, codec) {
  const json = JSON.stringify(payload);
  const plaintext = codec === 'deflate'
    ? new Uint8Array(zlib.deflateRawSync(Buffer.from(json, 'utf8')))
    : util.decodeUTF8(json);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(plaintext, nonce, sharedKey(secretKey, peerPublicKey));
  return { nonce: encode(nonce), ciphertext: encode(ciphertext) };
}

function decryptJson(box, secretKey, peerPublicKey, codec) {
  try {
    const plaintext = nacl.secretbox.open(
      decode(box?.ciphertext, null, 'encrypted mobile payload'),
      decode(box?.nonce, nacl.secretbox.nonceLength, 'mobile message nonce'),
      sharedKey(secretKey, peerPublicKey)
    );
    if (!plaintext) throw new Error('invalid ciphertext');
    if (codec === 'deflate') return JSON.parse(zlib.inflateRawSync(Buffer.from(plaintext)).toString('utf8'));
    return JSON.parse(util.encodeUTF8(plaintext));
  } catch (_) {
    throw new Error('Encrypted mobile message could not be verified');
  }
}

module.exports = { createKeyPair, decryptJson, encryptJson, verificationCode };
