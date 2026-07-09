import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'avif']);

@Injectable()
export class UploadService {
  private supabase = createSupabaseAdminClient();
  private bucketInitialized = false;

  async uploadImage(file: Express.Multer.File): Promise<string> {
    const bucketName = 'product-images';

    const fileExt = file.originalname.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED_EXTENSIONS.has(fileExt)) {
      throw new InternalServerErrorException(
        `Invalid file extension: .${fileExt}. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
      );
    }

    if (!this.bucketInitialized) {
      const { data: buckets } = await this.supabase.storage.listBuckets();
      const bucketExists = buckets?.some((b) => b.name === bucketName);
      if (!bucketExists) {
        await this.supabase.storage.createBucket(bucketName, { public: true });
      }
      this.bucketInitialized = true;
    }

    const fileName = `${Date.now()}-${crypto.randomUUID()}.${fileExt}`;

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
}
