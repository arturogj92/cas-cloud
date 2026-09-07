import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

export type MobileKeyPair = { publicKey: string; secretKey: string };
export type EncryptedBox = { nonce: string; ciphertext: string };

const KEY_BYTES = 32;

export function configurePrng(fill: (target: Uint8Array) => void) {
  nacl.setPRNG((target) => fill(target));
}

function encode(bytes: Uint8Array) {
  return util.encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: unknown, expectedBytes: number | null, label: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${label}`);
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const bytes = util.decodeBase64(padded);
  if (expectedBytes !== null && bytes.length !== expectedBytes) throw new Error(`Invalid ${label}`);
  return bytes;
}

export function createKeyPair(): MobileKeyPair {
  const pair = nacl.box.keyPair();
  return { publicKey: encode(pair.publicKey), secretKey: encode(pair.secretKey) };
}

function sharedKey(secretKey: string, peerPublicKey: string) {
  return nacl.box.before(
    decode(peerPublicKey, KEY_BYTES, 'mobile public key'),
    decode(secretKey, KEY_BYTES, 'mobile secret key'),
  );
}

export function verificationCode(secretKey: string, peerPublicKey: string, pairingId: string) {
  if (!pairingId) throw new Error('Invalid pairing id');
  const context = util.decodeUTF8(`CodeAgentSwarm pairing v2\0${pairingId}`);
  const material = new Uint8Array(context.length + KEY_BYTES);
  material.set(context);
  material.set(sharedKey(secretKey, peerPublicKey), context.length);
  const digest = nacl.hash(material);
  const value = (((digest[0] << 24) >>> 0) + (digest[1] << 16) + (digest[2] << 8) + digest[3]) % 1_000_000;
  return String(value).padStart(6, '0');
}

// fflate's deflateSync/inflateSync are raw DEFLATE, the same stream Node's
// zlib.deflateRawSync produces on the desktop.
export function encryptJson(
  payload: unknown,
  secretKey: string,
  peerPublicKey: string,
  codec?: string | null,
): EncryptedBox {
  const json = JSON.stringify(payload);
  const plaintext = codec === 'deflate' ? deflateSync(strToU8(json)) : util.decodeUTF8(json);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(plaintext, nonce, sharedKey(secretKey, peerPublicKey));
  return { nonce: encode(nonce), ciphertext: encode(ciphertext) };
}

// `codec` is optional and only 'deflate' is understood: the desktop raw-deflates the JSON
// bytes before encrypting when this client announced it accepts that codec. Without it the
// box is plain JSON, exactly as every earlier build expects.
export function decryptJson(
  box: Partial<EncryptedBox> | null,
  secretKey: string,
  peerPublicKey: string,
  codec?: string | null,
) {
  try {
    const plaintext = nacl.secretbox.open(
      decode(box?.ciphertext, null, 'encrypted mobile payload'),
      decode(box?.nonce, nacl.secretbox.nonceLength, 'mobile message nonce'),
      sharedKey(secretKey, peerPublicKey),
    );
    if (!plaintext) throw new Error('invalid ciphertext');
    if (codec === 'deflate') return JSON.parse(strFromU8(inflateSync(plaintext))) as Record<string, unknown>;
    return JSON.parse(util.encodeUTF8(plaintext)) as Record<string, unknown>;
  } catch {
    throw new Error('Encrypted mobile message could not be verified');
  }
}
