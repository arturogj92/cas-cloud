const LOCAL_PREVIEW_URL = /http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#][^\s<>"'`]*)?/gi;

export function localPreviewUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(LOCAL_PREVIEW_URL)) {
    const candidate = match[0].replace(/[),.;!?]+$/, '');
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        urls.add(candidate);
      }
    } catch {
      // Keep malformed model output as text.
    }
  }
  return [...urls];
}
