// Photos are shrunk on this computer before any model sees them: the on-device
// model accepts JPEG or PNG within a token budget, and smaller images are faster.

export interface PreparedImage {
  base64: string;
  mimeType: 'image/jpeg';
  sha256: string; // fingerprint of the original file, stored instead of the photo
  previewUrl: string;
}

const MAX_SIDE = 768;

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function prepareImage(blob: Blob): Promise<PreparedImage> {
  const original = await blob.arrayBuffer();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return {
    base64: btoa(bin),
    mimeType: 'image/jpeg',
    sha256: await sha256Hex(original),
    previewUrl: URL.createObjectURL(blob),
  };
}

export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export const SAMPLES: Record<string, { file: string; caption: string }[]> = {
  waterproofing: [
    { file: 'wp-good.jpg', caption: 'North wall, before backfill' },
    { file: 'wp-corner.jpg', caption: 'North-east corner' },
  ],
  rebar: [
    { file: 'rebar-good.jpg', caption: 'Ground floor slab, bay A' },
    { file: 'rebar-ground.jpg', caption: 'Garage slab' },
  ],
  insulation: [{ file: 'insulation-gaps.jpg', caption: 'Living room, east wall' }],
  vapour: [{ file: 'vapour-good.jpg', caption: 'Bedroom 1, outer wall' }],
  services: [{ file: 'pipes-notch.jpg', caption: 'Bathroom, pipe wall' }],
  roof: [{ file: 'roof-underlay.jpg', caption: 'South roof slope' }],
};
