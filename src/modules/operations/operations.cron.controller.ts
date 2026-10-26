import {
  Controller,
  Get,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { OperationsService } from './operations.service.js';
@Controller('internal/operations')
export class OperationsCronController {
  constructor(private readonly service: OperationsService) {}
  @Get('reminders') reminders(
    @Headers('authorization') authorization?: string,
  ) {
    const secret = process.env.CRON_SECRET;
    const expected = Buffer.from('Bearer ' + (secret ?? '')),
      actual = Buffer.from(authorization ?? '');
    if (
      !secret ||
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    )
      throw new UnauthorizedException('Invalid scheduler credentials');
    return this.service.reminders();
  }
}
