import assert from 'node:assert/strict';
import test from 'node:test';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';

import {
  createKeyPair,
  decryptJson,
  encryptJson,
  verificationCode,
  type MobileKeyPair,
} from '../src/mobile-crypto';

const base64Url = (bytes: Uint8Array) => util.encodeBase64(bytes)
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeKey = (value: string) => util.decodeBase64(
  value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4),
);

/** Encrypts already-compressed bytes the way the desktop relay client does. */
const desktopBox = (compressedBase64: string, desktop: MobileKeyPair, phone: MobileKeyPair) => {
  const shared = nacl.box.before(decodeKey(phone.publicKey), decodeKey(desktop.secretKey));
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plaintext = new Uint8Array(Buffer.from(compressedBase64, 'base64'));
  return { nonce: base64Url(nonce), ciphertext: base64Url(nacl.secretbox(plaintext, nonce, shared)) };
};

test('encrypts runtime messages so only the paired devices can read them', () => {
  const desktop = createKeyPair();
  const phone = createKeyPair();
  const stranger = createKeyPair();

  assert.equal(
    verificationCode(desktop.secretKey, phone.publicKey, 'pair-1'),
    verificationCode(phone.secretKey, desktop.publicKey, 'pair-1'),
  );

  const box = encryptJson({ kind: 'hello', protocolVersion: 2 }, phone.secretKey, desktop.publicKey);
  assert.deepEqual(decryptJson(box, desktop.secretKey, phone.publicKey), {
    kind: 'hello',
    protocolVersion: 2,
  });
  assert.throws(
    () => decryptJson(box, stranger.secretKey, phone.publicKey),
    /could not be verified/,
  );
});

// The desktop compresses with Node's zlib.deflateRawSync, this client inflates with fflate.
// The vector below is valid Node output for WELCOME. Compressed bytes can differ between zlib
// versions, so interoperability is the contract rather than byte-for-byte encoder output.
const WELCOME = {
  kind: 'welcome',
  protocolVersion: 2,
  runtimeId: 'runtime-1',
  reset: true,
  builtMs: 742,
  snapshot: { sessions: [{ sessionId: 's1', title: 'Añadir compresión' }] },
};
const NODE_DEFLATE_RAW_VECTOR = 'PcwxCsJQEIThq8jUz8IgCNtZWtjaiEVMFlx8eRt2N6QIOZR4hFxMImI3PwzfhKeUFoSRc6MdI6E3DW00X9hctICqBBtKSMen9fnb2x0SjJ0DFDZwwn2QHGcHHfZVgpe694cGaIKzr5SDrv/4Wr4iIZEZhOPyqluxTaNdb+yyvAvm2zx/AA==';

test('reads a welcome the desktop raw-deflated with Node zlib before encrypting it', () => {
  const desktop = createKeyPair();
  const phone = createKeyPair();

  assert.deepEqual(
    decryptJson(desktopBox(NODE_DEFLATE_RAW_VECTOR, desktop, phone), phone.secretKey, desktop.publicKey, 'deflate'),
    WELCOME,
  );
  // The reverse direction of the same raw-deflate contract.
  const compressed = encryptJson(WELCOME, phone.secretKey, desktop.publicKey, 'deflate');
  assert.deepEqual(decryptJson(compressed, desktop.secretKey, phone.publicKey, 'deflate'), WELCOME);
});

test('an uncompressed box is still read by a client that accepts deflate', () => {
  const desktop = createKeyPair();
  const phone = createKeyPair();
  const box = encryptJson(WELCOME, desktop.secretKey, phone.publicKey);

  assert.deepEqual(decryptJson(box, phone.secretKey, desktop.publicKey), WELCOME);
  assert.deepEqual(decryptJson(box, phone.secretKey, desktop.publicKey, null), WELCOME);
});
