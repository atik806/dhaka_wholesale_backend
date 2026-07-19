import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { z } from 'zod';
import { AdminService } from './admin.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe.js';

const UpdateStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']),
});

const UpdatePaymentStatusSchema = z.object({
  payment_status: z.enum(['pending', 'paid', 'failed', 'refunded']),
});

const UpdateRoleSchema = z.object({
  role: z.enum(['customer', 'admin']),
});

const UpdateBugReportSchema = z.object({
  status: z.enum(['pending', 'reviewed', 'resolved']).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  admin_reply: z.string().max(2000).optional(),
});

const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z
    .string()
    .min(8)
    .max(100)
    .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
    .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  role: z.enum(['customer', 'admin']).default('customer'),
});

const AdminUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
  search: z.string().max(200).default(''),
});

const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(10),
});

const DashboardQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const OrdersQuerySchema = PaginationQuerySchema.extend({
  status: z
    .enum(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'])
    .optional(),
  search: z.string().max(200).optional(),
});

@ApiTags('Admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('dashboard')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get admin dashboard stats' })
  async getDashboard(
    @Query(new ZodValidationPipe(DashboardQuerySchema))
    query: {
      from?: string;
      to?: string;
    },
  ) {
    return this.adminService.getDashboardStats(query);
  }

  @Get('orders')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all orders with pagination and status filter' })
  async findAllOrders(
    @Query(new ZodValidationPipe(OrdersQuerySchema))
    query: {
      page?: number;
      limit?: number;
      status?: string;
      search?: string;
    },
  ) {
    return this.adminService.findAllOrders(query);
  }

  @Get('orders/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order detail' })
  async getOrderDetail(@Param('id', UuidParamPipe) id: string) {
    return this.adminService.getOrderDetail(id);
  }

  @Patch('orders/:id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order status' })
  async updateOrderStatus(
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(UpdateStatusSchema))
    body: { status: string },
  ) {
    return this.adminService.updateOrderStatus(id, body.status);
  }

  @Patch('orders/:id/payment')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update payment status' })
  async updatePaymentStatus(
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(UpdatePaymentStatusSchema))
    body: { payment_status: string },
  ) {
    return this.adminService.updatePaymentStatus(id, body.payment_status);
  }

  @Delete('orders/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete an order and its items' })
  async deleteOrder(@Param('id', UuidParamPipe) id: string) {
    return this.adminService.deleteOrder(id);
  }

  @Get('users')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all users' })
  async findAllUsers(
    @Query(new ZodValidationPipe(AdminUsersQuerySchema))
    query: {
      page: number;
      limit: number;
      search: string;
    },
  ) {
    return this.adminService.findAllUsers(query);
  }

  @Post('users')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new user (admin or customer)' })
  async createUser(
    @Body(new ZodValidationPipe(CreateUserSchema))
    body: {
      name: string;
      email: string;
      password: string;
      role: string;
    },
  ) {
    return this.adminService.createUser(body);
  }

  @Patch('users/:id/role')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user role' })
  async updateUserRole(
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(UpdateRoleSchema))
    body: { role: string },
  ) {
    return this.adminService.updateUserRole(id, body.role);
  }

  @Delete('users/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete user' })
  async deleteUser(@Param('id', UuidParamPipe) id: string) {
    return this.adminService.deleteUser(id);
  }

  @Get('reviews')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all reviews with pagination' })
  async findAllReviews(
    @Query(new ZodValidationPipe(PaginationQuerySchema))
    query: {
      page?: number;
      limit?: number;
    },
  ) {
    return this.adminService.findAllReviews(query);
  }

  @Delete('reviews/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a review' })
  async deleteReview(@Param('id', UuidParamPipe) id: string) {
    return this.adminService.deleteReview(id);
  }

  @Get('contact-messages')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all contact messages with pagination' })
  async findAllContactMessages(
    @Query(new ZodValidationPipe(PaginationQuerySchema))
    query: {
      page?: number;
      limit?: number;
    },
  ) {
    return this.adminService.findAllContactMessages(query);
  }

  @Patch('contact-messages/:id/read')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark contact message as read' })
  async markContactMessageRead(@Param('id', UuidParamPipe) id: string) {
    return this.adminService.markContactMessageRead(id);
  }

  @Delete('contact-messages/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a contact message' })
  async deleteContactMessage(@Param('id', UuidParamPipe) id: string) {
    return this.adminService.deleteContactMessage(id);
  }

  @Get('bug-reports')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all bug reports with pagination' })
  async findAllBugReports(
    @Query(new ZodValidationPipe(PaginationQuerySchema))
    query: {
      page?: number;
      limit?: number;
    },
  ) {
    return this.adminService.findAllBugReports(query);
  }

  @Patch('bug-reports/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update bug report status or reply' })
  async updateBugReport(
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(UpdateBugReportSchema))
    body: { status?: string; admin_reply?: string },
  ) {
    return this.adminService.updateBugReport(id, body);
  }
}
