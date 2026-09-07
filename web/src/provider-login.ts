export function providerLoginDeviceCode(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  return text.match(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4,5})+\b/)?.[0] || null;
}
