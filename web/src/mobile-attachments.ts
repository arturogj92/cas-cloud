export const MAX_MOBILE_ATTACHMENTS = 40;
export const MAX_MOBILE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_MOBILE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_MOBILE_ATTACHMENTS_BYTES = 30 * 1024 * 1024;
export const MOBILE_ATTACHMENT_CHUNK_CHARS = 448 * 1024;
export const MOBILE_IMAGE_MAX_EDGE = 1440;
export const MOBILE_IMAGE_QUALITY = .9;
export const MOBILE_IMAGE_RETRY_QUALITY = .75;
export const MOBILE_CAMERA_MAX_EDGE = 1024;
export const MOBILE_CAMERA_QUALITY = .4;

export type MobileAttachment = {
  type: 'image' | 'audio' | 'file';
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
  durationMs?: number;
};

export type LocalImageReference = { label: string; path: string; name: string };

export function extractLocalImageReferences(text: string): LocalImageReference[] {
  const found: LocalImageReference[] = [];
  const seen = new Set<string>();
  const links = /!?\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))\)/g;
  for (const match of text.matchAll(links)) {
    const imagePath = (match[2] || match[3] || '').trim();
    if (!/\.(?:png|jpe?g|webp|gif|heic)$/i.test(imagePath) || seen.has(imagePath)) continue;
    seen.add(imagePath);
    found.push({
      label: match[1].trim() || 'View image',
      path: imagePath,
      name: imagePath.split(/[\\/]/).pop() || 'image',
    });
  }
  return found;
}

export function createMobileAttachment(input: Omit<MobileAttachment, 'sizeBytes'>): MobileAttachment {
  const match = input.dataUrl.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/]*={0,2})$/i);
  if (!match || (input.type !== 'file' && !match[1].toLowerCase().startsWith(`${input.type}/`))) {
    throw new Error(`Could not read the ${input.type} attachment`);
  }
  const sizeBytes = Math.floor((match[2].length * 3) / 4) - (match[2].match(/=*$/)?.[0].length || 0);
  const maximum = input.type === 'file' ? MAX_MOBILE_FILE_BYTES : MAX_MOBILE_ATTACHMENT_BYTES;
  if (sizeBytes > maximum) {
    throw new Error(`Attachment is too large. Keep it under ${maximum / (1024 * 1024)} MB.`);
  }
  return {
    ...input,
    name: input.name.split(/[\\/]/).pop()?.slice(0, 255) || input.type,
    mimeType: match[1].toLowerCase(),
    sizeBytes,
  };
}

export function appendMobileAttachment(current: MobileAttachment[], attachment: MobileAttachment) {
  if (current.length >= MAX_MOBILE_ATTACHMENTS) throw new Error(`You can attach up to ${MAX_MOBILE_ATTACHMENTS} files.`);
  if (current.reduce((sum, item) => sum + item.sizeBytes, attachment.sizeBytes) > MAX_MOBILE_ATTACHMENTS_BYTES) {
    throw new Error('Attachments are too large. Keep the combined size under 30 MB.');
  }
  return [...current, attachment];
}

export function attachmentUploadChunks(attachment: MobileAttachment) {
  const separator = attachment.dataUrl.indexOf(',');
  const encoded = separator >= 0 ? attachment.dataUrl.slice(separator + 1) : '';
  const chunks: Array<{ index: number; data: string }> = [];
  for (let offset = 0; offset < encoded.length; offset += MOBILE_ATTACHMENT_CHUNK_CHARS) {
    chunks.push({ index: chunks.length, data: encoded.slice(offset, offset + MOBILE_ATTACHMENT_CHUNK_CHARS) });
  }
  return chunks;
}
