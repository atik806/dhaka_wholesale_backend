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
import { ProductsService } from './products.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { RolesGuard } from '../../common/guards/roles.guard.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe.js';
import { CacheTTL } from '../../common/decorators/cache.decorator.js';
import {
  CreateProductSchema,
  type CreateProductDto,
} from './dto/create-product.dto.js';
import {
  UpdateProductSchema,
  type UpdateProductDto,
} from './dto/update-product.dto.js';
import {
  QueryProductsSchema,
  type QueryProductsDto,
} from './dto/query-products.dto.js';

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @CacheTTL(60)
  @ApiOperation({
    summary: 'List products with search, filter, pagination, and sort',
  })
  async findAll(
    @Query(new ZodValidationPipe(QueryProductsSchema)) query: QueryProductsDto,
  ) {
    return this.productsService.findAll(query);
  }

  @Get('featured')
  @CacheTTL(600)
  @ApiOperation({ summary: 'Get featured products' })
  async getFeatured() {
    return this.productsService.getFeatured();
  }

  @Get('stats')
  @CacheTTL(60)
  @ApiOperation({ summary: 'Get product stock counts for admin/overview cards' })
  async getStockStats() {
    return this.productsService.getStockStats();
  }

  @Get(':slug')
  @CacheTTL(300)
  @ApiOperation({ summary: 'Get product by slug' })
  async findBySlug(@Param('slug') slug: string) {
    return this.productsService.findBySlug(slug);
  }

  @Get(':slug/related')
  @CacheTTL(300)
  @ApiOperation({ summary: 'Get related products' })
  async getRelated(@Param('slug') slug: string) {
    return this.productsService.getRelatedBySlug(slug);
  }

  @Post()
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a product (Admin only)' })
  async create(
    @Body(new ZodValidationPipe(CreateProductSchema)) dto: CreateProductDto,
  ) {
    return this.productsService.create(dto);
  }

  @Patch(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a product (Admin only)' })
  async update(
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(UpdateProductSchema)) dto: UpdateProductDto,
  ) {
    return this.productsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a product (Admin only)' })
  async remove(@Param('id', UuidParamPipe) id: string) {
    return this.productsService.remove(id);
  }
}
