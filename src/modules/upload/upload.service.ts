import { randomUUID } from 'node:crypto';
import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif']);

@Injectable()
export class UploadService {
  private supabase = createSupabaseAdminClient();
  private bucketInitPromise: Promise<void> | null = null;

  async uploadImage(file: Express.Multer.File): Promise<string> {
    const bucketName = 'product-images';

    const fileExt = file.originalname.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED_EXTENSIONS.has(fileExt)) {
      throw new InternalServerErrorException(
        `Invalid file extension: .${fileExt}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
      );
    }

    if (this.bucketInitPromise) {
      await this.bucketInitPromise;
    } else {
      this.bucketInitPromise = this.ensureBucket(bucketName);
      await this.bucketInitPromise;
    }

    const fileName = `${Date.now()}-${randomUUID()}.${fileExt}`;

    const { error } = await this.supabase.storage
      .from(bucketName)
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });

    if (error)
      throw new InternalServerErrorException('Upload failed: ' + error.message);

    const { data: publicUrl } = this.supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return publicUrl.publicUrl;
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

    const { data: buckets } = await this.supabase.storage.listBuckets();
    const bucketExists = buckets?.some((b) => b.name === bucketName);
    if (!bucketExists) {
      await this.supabase.storage.createBucket(bucketName, { public: true });
    }

    const fileName = `${Date.now()}-${randomUUID()}.${fileExt}`;

    const { error } = await this.supabase.storage
      .from(bucketName)
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        cacheControl: '3600',
        upsert: false,
      });

    if (error)
      throw new InternalServerErrorException('Upload failed: ' + error.message);

    const { data: publicUrl } = this.supabase.storage
      .from(bucketName)
      .getPublicUrl(fileName);

    return publicUrl.publicUrl;
  }

  private async ensureBucket(bucketName: string): Promise<void> {
    const { data: buckets } = await this.supabase.storage.listBuckets();
    const bucketExists = buckets?.some((b) => b.name === bucketName);
    if (!bucketExists) {
      await this.supabase.storage.createBucket(bucketName, { public: true });
    }
  }
}
