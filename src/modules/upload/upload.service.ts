import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';
import { compressImage } from './image-compress.js';

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif']);

/**
 * File names are unique per upload and never overwritten, so the CDN and
 * browsers can keep them for a year.
 */
const STORAGE_CACHE_CONTROL = '31536000';

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);
  private supabase = createSupabaseAdminClient();
  private bucketInitPromises = new Map<string, Promise<void>>();

  async uploadImage(file: Express.Multer.File): Promise<string> {
    return this.uploadToBucket(file, 'product-images');
  }

  async uploadToBucket(
    file: Express.Multer.File,
    bucketName: string,
  ): Promise<string> {
    const fileExt = file.originalname.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED_EXTENSIONS.has(fileExt)) {
      throw new InternalServerErrorException(
        `Invalid file extension: .${fileExt}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
      );
    }

    let compressed: Awaited<ReturnType<typeof compressImage>>;
    try {
      compressed = await compressImage(file.buffer);
    } catch (err) {
      this.logger.error(`Image compression failed: ${(err as Error).message}`);
      throw new BadRequestException('Image could not be processed');
    }

    await this.ensureBucket(bucketName);

    const fileName = `${Date.now()}-${randomUUID()}.${compressed.extension}`;

    const { error } = await this.supabase.storage
      .from(bucketName)
      .upload(fileName, compressed.buffer, {
        contentType: compressed.contentType,
        cacheControl: STORAGE_CACHE_CONTROL,
        upsert: false,
      });

    if (error)
      throw new InternalServerErrorException('Upload failed: ' + error.message);

    const { data: publicUrl } = this.supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return publicUrl.publicUrl;
  }

  private ensureBucket(bucketName: string): Promise<void> {
    let pending = this.bucketInitPromises.get(bucketName);
    if (!pending) {
      pending = this.createBucketIfMissing(bucketName).catch((err) => {
        // Don't cache a failure; the next upload retries.
        this.bucketInitPromises.delete(bucketName);
        throw err;
      });
      this.bucketInitPromises.set(bucketName, pending);
    }
    return pending;
  }

  private async createBucketIfMissing(bucketName: string): Promise<void> {
    const { data: buckets } = await this.supabase.storage.listBuckets();
    const bucketExists = buckets?.some((b) => b.name === bucketName);
    if (!bucketExists) {
      await this.supabase.storage.createBucket(bucketName, { public: true });
    }
  }
}
