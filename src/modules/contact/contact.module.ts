import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller.js';
import { ContactService } from './contact.service.js';

@Module({
  controllers: [ContactController],
  providers: [ContactService],
  exports: [ContactService],
})
export class ContactModule {}
