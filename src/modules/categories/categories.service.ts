import {
  Injectable,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { CreateCategoryDto } from './dto/create-category.dto.js';
import type { UpdateCategoryDto } from './dto/update-category.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);
  private supabase = createSupabaseAdminClient();

  async findAll() {
    const { data, error } = await this.supabase
      .from('categories')
      .select('*')
      .order('name');

    if (error)
      throw new InternalServerErrorException('An internal error occurred');

    return data || [];
  }

  async findBySlug(slug: string) {
    const { data, error } = await this.supabase
      .from('categories')
      .select('*')
      .eq('slug', slug)
      .single();

    if (error || !data) throw new NotFoundException('Category not found');
    return data;
  }

  async create(dto: CreateCategoryDto) {
    let slug =
      dto.slug ||
      dto.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

    if (!slug) {
      slug = 'category-' + Date.now();
    }

    const { data, error } = await this.supabase
      .from('categories')
      .insert({ ...dto, slug, product_count: 0 })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('A category with this slug already exists');
      }
      throw new InternalServerErrorException('An internal error occurred');
    }
    return data;
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const { data, error } = await this.supabase
      .from('categories')
      .update(dto)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      this.logger.error(
        `Failed to update category ${id}: code=${error.code} message=${error.message}`,
      );
      if (error.code === '23505') {
        throw new ConflictException('A category with this slug already exists');
      }
      throw new InternalServerErrorException('An internal error occurred');
    }
    if (!data) throw new NotFoundException('Category not found');
    return data;
  }

  async remove(id: string) {
    const { data: products, error: countError } = await this.supabase
      .from('products')
      .select('id')
      .eq('category_id', id);

    if (countError) {
      this.logger.error(
        `Failed to count products for category ${id}: ${countError.message}`,
      );
      throw new InternalServerErrorException('An internal error occurred');
    }

    const actualCount = products?.length || 0;

    if (actualCount > 0) {
      throw new ConflictException(
        `Cannot delete category: it still has ${actualCount} product(s) assigned to it.`,
      );
    }

    const { error } = await this.supabase
      .from('categories')
      .delete()
      .eq('id', id);

    if (error) {
      this.logger.error(
        `Failed to delete category ${id}: code=${error.code} message=${error.message}`,
      );
      if (error.code === '23503') {
        throw new ConflictException(
          'Cannot delete category: it still has products assigned to it.',
        );
      }
      throw new InternalServerErrorException('An internal error occurred');
    }
    return { message: 'Category deleted successfully' };
  }
}
