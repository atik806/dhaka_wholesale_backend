import {
  Injectable,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { CreateCategoryDto } from './dto/create-category.dto.js';
import type { UpdateCategoryDto } from './dto/update-category.dto.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

@Injectable()
export class CategoriesService {
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
    const slug =
      dto.slug ||
      dto.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

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
      if (error.code === '23505') {
        throw new ConflictException('A category with this slug already exists');
      }
      throw new NotFoundException('Category not found');
    }
    if (!data) throw new NotFoundException('Category not found');
    return data;
  }

  async remove(id: string) {
    const { count } = await this.supabase
      .from('products')
      .select('*', { count: 'exact', head: true })
      .eq('category_id', id);

    if (count && count > 0) {
      throw new ConflictException(
        `Cannot delete category: it still has ${count} product(s) assigned to it`,
      );
    }

    const { error } = await this.supabase
      .from('categories')
      .delete()
      .eq('id', id);

    if (error) throw new NotFoundException('Category not found');
    return { message: 'Category deleted successfully' };
  }
}
