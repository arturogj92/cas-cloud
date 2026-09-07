import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  appendMobileAttachment,
  attachmentUploadChunks,
  createMobileAttachment,
  extractLocalImageReferences,
  MAX_MOBILE_ATTACHMENT_BYTES,
  MAX_MOBILE_FILE_BYTES,
  MOBILE_ATTACHMENT_CHUNK_CHARS,
  MOBILE_CAMERA_MAX_EDGE,
  MOBILE_CAMERA_QUALITY,
  MOBILE_IMAGE_MAX_EDGE,
  MOBILE_IMAGE_QUALITY,
  MOBILE_IMAGE_RETRY_QUALITY,
} from '../src/mobile-attachments';

test('keeps picked photos sharp within the image pixel limit', () => {
  assert.ok(MOBILE_IMAGE_QUALITY >= .9);
  assert.ok(MOBILE_IMAGE_RETRY_QUALITY >= .75);
  assert.ok(MOBILE_IMAGE_MAX_EDGE ** 2 * 4 <= MAX_MOBILE_ATTACHMENT_BYTES);
});

test('prevents iOS Retina scaling from inflating edited PNGs', () => {
  const editor = readFileSync(resolve(import.meta.dirname, '../src/mobile-image-editor.tsx'), 'utf8');
  assert.match(editor, /Platform\.OS === 'ios' \? \{/);
  assert.match(editor, /size\.width \/ PixelRatio\.get\(\)/);
  assert.match(editor, /size\.height \/ PixelRatio\.get\(\)/);
});

test('compresses new camera photos aggressively before attaching them', () => {
  assert.ok(MOBILE_CAMERA_QUALITY <= .5);
  assert.ok(MOBILE_CAMERA_MAX_EDGE <= 1024);
  assert.ok(MOBILE_CAMERA_MAX_EDGE ** 2 * 4 <= MAX_MOBILE_ATTACHMENT_BYTES);
  const app = readFileSync(resolve(import.meta.dirname, '../App.tsx'), 'utf8');
  assert.match(app, /launchCameraAsync\(\{ mediaTypes: \['images'\], quality: MOBILE_CAMERA_QUALITY \}\)/);
  assert.match(app, /pickedImageAttachment\(result\.assets\[0\], MOBILE_CAMERA_MAX_EDGE, MOBILE_CAMERA_QUALITY, true\)/);
});

test('bounds encrypted mobile media and derives its identity from the data URL', () => {
  assert.deepEqual(createMobileAttachment({
    type: 'audio',
    name: '../voice.m4a',
    mimeType: 'audio/wav',
    dataUrl: 'data:audio/mp4;base64,YWJj',
  }), {
    type: 'audio',
    name: 'voice.m4a',
    mimeType: 'audio/mp4',
    sizeBytes: 3,
    dataUrl: 'data:audio/mp4;base64,YWJj',
  });
  const tooLarge = Buffer.alloc(MAX_MOBILE_ATTACHMENT_BYTES + 1).toString('base64');
  assert.throws(() => createMobileAttachment({
    type: 'image',
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${tooLarge}`,
  }), /20 MB/);
  assert.throws(() => createMobileAttachment({
    type: 'audio',
    name: 'fake.m4a',
    mimeType: 'audio/mp4',
    dataUrl: 'data:image/jpeg;base64,YWJj',
  }), /audio attachment/);
  const half = createMobileAttachment({
    type: 'image',
    name: 'half.jpg',
    mimeType: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${Buffer.alloc(Math.floor(MAX_MOBILE_ATTACHMENT_BYTES / 2) + 1).toString('base64')}`,
  });
  assert.throws(() => appendMobileAttachment([half, half, half, half, half], half), /combined size/);
});

test('splits large encrypted media into relay-safe chunks without changing its bytes', () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 7);
  const attachment = createMobileAttachment({
    type: 'audio',
    name: 'long-note.m4a',
    mimeType: 'audio/mp4',
    dataUrl: `data:audio/mp4;base64,${bytes.toString('base64')}`,
  });
  const chunks = attachmentUploadChunks(attachment);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.map((chunk) => chunk.data).join(''), bytes.toString('base64'));
  assert.deepEqual(chunks.map((chunk) => chunk.index), chunks.map((_, index) => index));
  assert.ok(chunks.every((chunk) => chunk.data.length <= MOBILE_ATTACHMENT_CHUNK_CHARS));
});

test('keeps a file at the advertised 20 MB limit inside the relay chunk limit', () => {
  const bytes = Buffer.alloc(MAX_MOBILE_FILE_BYTES, 7);
  const attachment = createMobileAttachment({
    type: 'file',
    name: 'demo.mp4',
    mimeType: 'video/mp4',
    dataUrl: `data:video/mp4;base64,${bytes.toString('base64')}`,
  });

  assert.ok(attachmentUploadChunks(attachment).length <= 64);
});

test('accepts ordinary documents and keeps their real mime type', () => {
  const attachment = createMobileAttachment({
    type: 'file',
    name: '../requirements.txt',
    mimeType: 'text/plain',
    dataUrl: 'data:text/plain;base64,aGVsbG8=',
  });

  assert.equal(attachment.name, 'requirements.txt');
  assert.equal(attachment.mimeType, 'text/plain');
  assert.equal(attachment.sizeBytes, 5);
});

test('allows forty attachments but rejects the forty-first', () => {
  const file = createMobileAttachment({
    type: 'file',
    name: 'notes.txt',
    mimeType: 'text/plain',
    dataUrl: 'data:text/plain;base64,YQ==',
  });
  const forty = Array.from({ length: 40 }, () => file);
  assert.equal(appendMobileAttachment(forty.slice(0, 39), file).length, 40);
  assert.throws(() => appendMobileAttachment(forty, file), /up to 40/);
});

test('finds local screenshot links without treating ordinary links as files', () => {
  assert.deepEqual(extractLocalImageReferences([
    'Done. [View screenshot](</Users/me/Build results/dark.png>).',
    'Duplicate: ![dark](</Users/me/Build results/dark.png>)',
    'Ignore [docs](https://example.com/docs) and `/tmp/not-an-image.txt`.',
  ].join('\n')), [{
    label: 'View screenshot',
    path: '/Users/me/Build results/dark.png',
    name: 'dark.png',
  }]);
});
