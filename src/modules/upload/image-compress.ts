import sharp from 'sharp';

/**
 * Longest edge kept for stored images. The product gallery renders at most
 * ~1080px wide, so 1600 leaves headroom for 1.5x screens without storing the
 * 3-4000px originals phones produce.
 */
export const MAX_IMAGE_EDGE = 1600;
export const WEBP_QUALITY = 80;

export interface CompressedImage {
  buffer: Buffer;
  contentType: 'image/webp';
  extension: 'webp';
}

/**
 * Re-encode an uploaded image as a resized WebP. The storefront serves
 * Supabase images straight from Supabase's CDN (no Vercel image optimizer,
 * which is quota-limited on Hobby), so the stored file must already be small:
 * raw admin uploads were PNGs with a 380 KB median and up to 2.8 MB.
 */
export async function compressImage(input: Buffer): Promise<CompressedImage> {
  const buffer = await sharp(input, { failOn: 'error' })
    .rotate() // apply EXIF orientation before metadata is dropped
    .resize({
      width: MAX_IMAGE_EDGE,
      height: MAX_IMAGE_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: WEBP_QUALITY, effort: 4 })
    .toBuffer();

  return { buffer, contentType: 'image/webp', extension: 'webp' };
}
