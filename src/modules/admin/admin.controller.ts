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

const UpdateStatusSchema = z.object({
  status: z.enum(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']),
});

const UpdatePaymentStatusSchema = z.object({
  payment_status: z.enum(['pending', 'paid', 'failed', 'refunded']),
});

const UpdateRoleSchema = z.object({
  role: z.enum(['customer', 'admin']),
});

const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(6).max(100),
  role: z.enum(['customer', 'admin']).default('admin'),
});

const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
});

const OrdersQuerySchema = PaginationQuerySchema.extend({
  status: z
    .enum(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'])
    .optional(),
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
  async getDashboard() {
    return this.adminService.getDashboardStats();
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
    },
  ) {
    return this.adminService.findAllOrders(query);
  }

  @Get('orders/:id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order detail' })
  async getOrderDetail(@Param('id') id: string) {
    return this.adminService.getOrderDetail(id);
  }

  @Patch('orders/:id/status')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update order status' })
  async updateOrderStatus(
    @Param('id') id: string,
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
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdatePaymentStatusSchema))
    body: { payment_status: string },
  ) {
    return this.adminService.updatePaymentStatus(id, body.payment_status);
  }

  @Get('users')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all users' })
  async findAllUsers() {
    return this.adminService.findAllUsers();
  }

  @Post('users')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new user (admin or customer)' })
  async createUser(
    @Body(new ZodValidationPipe(CreateUserSchema))
    body: { name: string; email: string; password: string; role: string },
  ) {
    return this.adminService.createUser(body);
  }

  @Patch('users/:id/role')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update user role' })
  async updateUserRole(
    @Param('id') id: string,
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
  async deleteUser(@Param('id') id: string) {
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
  async deleteReview(@Param('id') id: string) {
    return this.adminService.deleteReview(id);
  }
}
