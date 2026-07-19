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
import { ReviewsService } from './reviews.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import type { JwtUser } from '../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe.js';
import {
  CreateReviewSchema,
  UpdateReviewSchema,
  type CreateReviewDto,
  type UpdateReviewDto,
} from './dto/create-review.dto.js';

@ApiTags('Reviews')
@Controller()
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get('reviews/recent')
  @ApiOperation({ summary: 'Get recent reviews across all products' })
  async findRecent() {
    return this.reviewsService.findRecent();
  }

  @Get('products/:productId/reviews')
  @ApiOperation({ summary: 'Get reviews for a product' })
  async findByProduct(
    @Param('productId', UuidParamPipe) productId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reviewsService.findByProduct(
      productId,
      page ? Math.max(1, Number(page)) : 1,
      limit ? Math.min(50, Math.max(1, Number(limit))) : 20,
    );
  }

  @Post('products/:productId/reviews')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Add a review to a product' })
  async create(
    @CurrentUser() user: JwtUser,
    @Param('productId', UuidParamPipe) productId: string,
    @Body(new ZodValidationPipe(CreateReviewSchema)) dto: CreateReviewDto,
  ) {
    return this.reviewsService.create(user.id, productId, dto);
  }

  @Patch('reviews/:id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update own review' })
  async update(
    @CurrentUser() user: JwtUser,
    @Param('id', UuidParamPipe) id: string,
    @Body(new ZodValidationPipe(UpdateReviewSchema)) dto: UpdateReviewDto,
  ) {
    return this.reviewsService.update(id, user.id, dto);
  }

  @Delete('reviews/:id')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete own review' })
  async remove(
    @CurrentUser() user: JwtUser,
    @Param('id', UuidParamPipe) id: string,
  ) {
    return this.reviewsService.remove(id, user.id);
  }
}
