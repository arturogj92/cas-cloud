import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const appSource = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'App.tsx'), 'utf8');
const viewer = appSource.match(/<Modal visible=\{Boolean\(viewingGallery\)\}[\s\S]*?<\/Modal>/)?.[0] || '';

test('opening uses only original image bytes, including a scoped cached reopen', () => {
  const body = appSource.match(/const openImage = useCallback\([\s\S]*?=> \{([\s\S]*?)\n  \},/)?.[1];
  assert.ok(body);
  let shown: any;
  let requested: any;
  const lastFullImage = { current: null as any };
  const session = { sessionId: 'host-a:chat' };
  const open = new Function('image', 'gallery', 'imageDismissY', 'resetImageZoom', 'setViewingGallery', 'loadFullImage', 'lastFullImage', 'session', body);
  const image = { name: 'portrait', attachmentId: 'image-1', dataUrl: 'small-thumbnail' };
  const show = (candidate = image) => open(candidate, [candidate], { setValue() {} }, () => {}, (value: any) => { shown = value; }, (value: any) => { requested = value; }, lastFullImage, session);
  show();
  assert.equal(shown.images[0].dataUrl, undefined, 'never enlarge the thumbnail inside the viewer');
  assert.equal(requested, shown.images[0]);
  lastFullImage.current = { sessionId: session.sessionId, attachmentId: image.attachmentId, dataUrl: 'original' };
  show();
  assert.equal(shown.images[0].dataUrl, 'original');
  session.sessionId = 'host-b:chat';
  show();
  assert.equal(shown.images[0].dataUrl, undefined, 'do not reuse another host or conversation image');
  show({ name: 'local', attachmentId: '', dataUrl: 'local-original' });
  assert.equal(shown.images[0].dataUrl, 'local-original');
});

test('closing preserves the offscreen position throughout native modal dismissal', () => {
  const body = appSource.match(/const closeImageViewer = useCallback\(\(\) => \{([\s\S]*?)\n  \},/)?.[1];
  assert.ok(body);
  let position = 900;
  let gallery: unknown = { images: [] };
  const close = new Function('imageDismissY', 'resetImageZoom', 'setViewingGallery', body);
  close({ stopAnimation() {}, setValue(value: number) { position = value; } }, () => {}, (value: unknown) => { gallery = value; });
  assert.equal(gallery, null);
  assert.equal(position, 900, 'iOS still renders the modal during its fade-out');
});

test('late downloads do not replace the current image and loaded images need no reread', async () => {
  const body = appSource.match(/const loadFullImage = useCallback\([\s\S]*?=> \{([\s\S]*?)\n  \},/)?.[1];
  assert.ok(body);
  const pending = new Map<string, (value: any) => void>();
  const request = { current: 0 };
  const cached = { current: null as any };
  const a = { name: 'a', attachmentId: 'a' };
  const b = { name: 'b', attachmentId: 'b' };
  let gallery: any = { images: [a, b], index: 1 };
  let loading = false;
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const load = new AsyncFunction('image', 'imageLoadRequest', 'lastFullImage', 'setImageLoading', 'readAttachment', 'session', 'setViewingGallery', 'notify', body);
  const run = (image: any) => load(image, request, cached, (value: boolean) => { loading = value; }, (_session: string, id: string) => new Promise((resolve) => pending.set(id, resolve)), { sessionId: 'chat' }, (update: any) => { gallery = update(gallery); }, assert.fail);
  const first = run(a);
  const second = run(b);
  pending.get('a')!({ dataUrl: 'original-a' });
  await first;
  assert.equal(loading, true);
  assert.equal(gallery.images[0].dataUrl, undefined);
  pending.get('b')!({ dataUrl: 'original-b' });
  await second;
  assert.equal(loading, false);
  assert.equal(gallery.images[1].dataUrl, 'original-b');
  pending.clear();
  await run({ ...a, dataUrl: 'original-a' });
  assert.equal(pending.size, 0);
  assert.equal(cached.current.dataUrl, 'original-a');
});

test('native image viewer gives its child full control of pinch gestures', () => {
  assert.match(viewer, /disableScrollViewPanResponder/);
  assert.match(viewer, /Platform\.OS === 'ios'/);
  assert.match(viewer, /minimumZoomScale=\{1\}/);
  assert.match(viewer, /maximumZoomScale=\{4\}/);
  assert.match(viewer, /pinchGestureEnabled/);
  assert.match(viewer, /bouncesZoom/);
});

test('image zoom buttons remain web-only', () => {
  assert.match(viewer, /Platform\.OS === 'web' && viewingGallery \? <Animated\.View style=\{\[styles\.imageViewerZoomControls/);
});

test('native scroll views yield to dismissal until the gesture chooses another direction or pinch', () => {
  assert.match(viewer, /<GestureHandlerRootView style=\{styles\.imageViewerShell\}>/);
  assert.match(viewer, /<PanGestureHandler ref=\{imageDismissRef\}/);
  assert.equal((viewer.match(/waitFor=\{imageDismissRef\}/g) || []).length, 2);
  assert.match(appSource, /maxPointers: 1/);
  assert.match(appSource, /failOffsetY: -8/);
});

test('image viewer dismiss follows one downward touch only at fitted zoom', () => {
  assert.match(viewer, /<PanGestureHandler[^>]*\{\.\.\.imageDismissHandlers\}>/);
  assert.match(viewer, /testID="image-viewer-content"/);
  assert.match(viewer, /translateY: imageDismissY\.interpolate/);
  assert.match(appSource, /!nativeImageZoomed/);
  assert.match(appSource, /imageViewport\.scale <= 1\.01/);
  assert.match(appSource, /activeOffsetY: 8/);
  assert.match(appSource, /failOffsetX: \[-16, 16\]/);
  assert.match(appSource, /nativeID="image-viewer-gesture-area"/);
  assert.match(appSource, /document\.addEventListener\('touchstart', start/);
  assert.match(appSource, /document\.addEventListener\('touchmove', move, \{ passive: false, capture: true \}\)/);
  assert.match(appSource, /dy > 0 && dy > Math\.abs\(dx\) \? 'dismiss'/);
  assert.match(appSource, /shouldDismissSheet\(Math\.max\(0, translationY\), Math\.max\(0, velocityY \/ 1_000\)\)/);
  assert.match(appSource, /shouldDismissSheet\(Math\.max\(0, drag\.lastY - drag\.startY\), Math\.max\(0, drag\.velocity\)\)/);
  assert.match(appSource, /imageViewerRef\.current\?\.scrollTo\(\{ x: viewportWidth \* drag\.index - dx/);
});
