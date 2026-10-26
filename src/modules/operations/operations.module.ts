import { OperationsCronController } from './operations.cron.controller.js';
import { Module } from '@nestjs/common';
import {
  OperationsController,
  CustomerOperationsController,
} from './operations.controller.js';
import { OperationsService } from './operations.service.js';
@Module({
  controllers: [
    OperationsController,
    CustomerOperationsController,
    OperationsCronController,
  ],
  providers: [OperationsService],
})
export class OperationsModule {}
