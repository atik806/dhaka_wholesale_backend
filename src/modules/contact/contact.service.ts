import { Injectable, InternalServerErrorException } from '@nestjs/common';
import type { CreateContactDto } from './dto/create-contact.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

@Injectable()
export class ContactService {
  private supabase = createSupabaseAdminClient();

  async create(dto: CreateContactDto) {
    const { error } = await this.supabase
      .from('contact_messages')
      .insert({
        first_name: dto.first_name,
        last_name: dto.last_name,
        email: dto.email,
        subject: dto.subject,
        message: dto.message,
      });

    if (error) {
      throw new InternalServerErrorException('Failed to submit message');
    }

    return { message: 'Message submitted successfully' };
  }
}
