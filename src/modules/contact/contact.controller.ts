import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ContactService } from './contact.service.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { CreateContactSchema, type CreateContactDto } from './dto/create-contact.dto.js';

@ApiTags('Contact')
@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  @Post()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiOperation({ summary: 'Submit a contact form message' })
  async create(@Body(new ZodValidationPipe(CreateContactSchema)) dto: CreateContactDto) {
    return this.contactService.create(dto);
  }
}
