import {
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiConsumes,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UploadService } from './upload.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.decorator.js';

const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const REPORT_MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * Magic-byte signatures for the allowed image types. The browser-supplied
 * Content-Type is advisory at best — a malicious client can upload any
 * payload labelled image/png. Sniffing the first bytes gives a cheap,
 * reliable second opinion.
 */
const MAGIC_BYTES: Array<{ mime: string; sniff: (buf: Buffer) => boolean }> = [
  {
    mime: 'image/jpeg',
    sniff: (b) =>
      b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/png',
    sniff: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mime: 'image/webp',
    sniff: (b) =>
      b.length >= 12 &&
      b.toString('latin1', 0, 4) === 'RIFF' &&
      b.toString('latin1', 8, 12) === 'WEBP',
  },
  {
    mime: 'image/avif',
    sniff: (b) =>
      b.length >= 12 &&
      b.toString('latin1', 4, 8) === 'ftyp' &&
      ['avif', 'avis'].includes(b.toString('latin1', 8, 12)),
  },
];

function assertImagePayload(file: Express.Multer.File) {
  if (!file) throw new BadRequestException('File is required');
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new BadRequestException(
      `Invalid file type: ${file.mimetype}. Allowed: ${ALLOWED_MIME_TYPES.join(', ')}`,
    );
  }
  const buffer = file.buffer;
  if (!buffer || buffer.length === 0) {
    throw new BadRequestException('File is empty');
  }
  const match = MAGIC_BYTES.find((m) => m.mime === file.mimetype);
  if (!match || !match.sniff(buffer)) {
    throw new BadRequestException(
      `File content does not match its declared type (${file.mimetype})`,
    );
  }
}

@ApiTags('Upload')
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE } }),
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload an image (Admin only)' })
  @ApiConsumes('multipart/form-data')
  async uploadImage(@UploadedFile() file: Express.Multer.File) {
    assertImagePayload(file);
    const url = await this.uploadService.uploadImage(file);
    return { url };
  }

  @Post('report-screenshot')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: REPORT_MAX_FILE_SIZE } }),
  )
  @ApiOperation({ summary: 'Upload a bug report screenshot (Public)' })
  @ApiConsumes('multipart/form-data')
  async uploadReportScreenshot(@UploadedFile() file: Express.Multer.File) {
    assertImagePayload(file);
    const url = await this.uploadService.uploadToBucket(file, 'bug-reports');
    return { url };
  }
}
