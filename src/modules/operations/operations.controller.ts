import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { OperationsService } from './operations.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import {
  CurrentUser,
  type JwtUser,
} from '../../common/decorators/current-user.decorator.js';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { Permission } from './permissions.js';
import * as S from './operations.schemas.js';

@Controller('admin/operations')
@UseGuards(AuthGuard)
export class OperationsController {
  constructor(private readonly service: OperationsService) {}
  @Get('session') session(@CurrentUser() u: JwtUser) {
    return this.service.access(u.id);
  }
  @Get('order/:id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('orders.read')
  order(@CurrentUser() u: JwtUser, @Param('id', UuidParamPipe) id: string) {
    return this.service.orderDetail(id, u.id);
  }
  @Post('order/:id/cancel')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('orders.manage')
  cancel(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.CancelSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'order.cancel', id, data);
  }
  @Patch('order/:id/review')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('orders.manage')
  review(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.ReviewSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'review.save', id, data);
  }
  @Post('order/:id/notes')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('orders.read')
  note(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.NoteSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'note.add', id, data);
  }
  @Patch('order/:id/shipment')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('shipments.manage')
  shipment(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.ShipmentSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'shipment.save', id, data);
  }
  @Post('inventory/:id/configure')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('inventory.manage')
  configure(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.ConfigureSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'inventory.configure', id, data);
  }
  @Post('inventory/:id/adjust')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('inventory.manage')
  adjust(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.AdjustSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'inventory.adjust', id, data);
  }
  @Post('order/:id/returns')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('returns.request')
  createReturn(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.ReturnCreateSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'return.create', id, data);
  }
  @Patch('returns/:id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('returns.request')
  updateReturn(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.ReturnUpdateSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'return.update', id, data);
  }
  @Post('returns/:id/refund')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('refunds.approve')
  approveRefund(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.RefundApproveSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'refund.approve', id, data);
  }
  @Post('returns/:id/refund/complete')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('refunds.complete')
  completeRefund(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.RefundCompleteSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'refund.complete', id, data);
  }
  @Patch('access/:id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('*')
  access(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(S.AccessSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'access.save', id, data);
  }
  @Get('settings')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('orders.read')
  settings() {
    return this.service.settings();
  }
  @Patch('settings')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('*')
  saveSettings(
    @CurrentUser() u: JwtUser,
    @Body(new ZodValidationPipe(S.SettingsSchema)) data: unknown,
  ) {
    return this.service.mutate(u.id, 'settings.save', u.id, data);
  }
  @Get('notifications') notifications(
    @CurrentUser() u: JwtUser,
    @Query(new ZodValidationPipe(S.ListSchema)) q: S.ListQuery,
  ) {
    return this.service.notifications(u.id, q);
  }
  @Post('notifications/:id/read') read(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
  ) {
    return this.service.readNotification(u.id, id);
  }
  @Get('assignees')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('orders.read')
  assignees() {
    return this.service.assignees();
  }
  @Get('report-options')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('reports.read')
  reportOptions(@Query(new ZodValidationPipe(S.ListSchema)) q: S.ListQuery) {
    return this.service.reportOptions(q.search ?? '');
  }
  @Get('reports')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @Permission('reports.read')
  reports(
    @CurrentUser() u: JwtUser,
    @Query(new ZodValidationPipe(S.ReportSchema)) q: unknown,
  ) {
    return this.service.report(u.id, q);
  }
  @Get(':resource') list(
    @CurrentUser() u: JwtUser,
    @Param('resource') resource: string,
    @Query(new ZodValidationPipe(S.ListSchema)) q: S.ListQuery,
  ) {
    return this.service.list(resource, q, u.id);
  }
}

@Controller('orders/:id/operations')
@UseGuards(AuthGuard)
export class CustomerOperationsController {
  constructor(private readonly service: OperationsService) {}
  @Get() detail(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
  ) {
    return this.service.customerOrder(u.id, id);
  }
  @Post('returns') request(
    @CurrentUser() u: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(
      new ZodValidationPipe(
        S.ReturnCreateSchema.omit({ override_window: true }),
      ),
    )
    data: unknown,
  ) {
    return this.service.customerReturn(u.id, id, data);
  }
}
