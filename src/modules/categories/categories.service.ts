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

  async findTree() {
    const categories = await this.findAll();

    const map = new Map<string, any>();
    const roots: any[] = [];

    for (const cat of categories) {
      map.set(cat.id, { ...cat, children: [] });
    }

    for (const cat of map.values()) {
      if (cat.parent_id && map.has(cat.parent_id)) {
        map.get(cat.parent_id).children.push(cat);
      } else {
        roots.push(cat);
      }
    }

    return roots;
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

  async getChildIds(parentId: string): Promise<string[]> {
    const allCategories = await this.findAll();

    const childrenMap = new Map<string, string[]>();
    for (const cat of allCategories) {
      if (cat.parent_id) {
        const existing = childrenMap.get(cat.parent_id) || [];
        existing.push(cat.id);
        childrenMap.set(cat.parent_id, existing);
      }
    }

    const result: string[] = [];
    const stack = [parentId];

    while (stack.length > 0) {
      const current = stack.pop()!;
      const directChildren = childrenMap.get(current);
      if (directChildren) {
        for (const childId of directChildren) {
          result.push(childId);
          stack.push(childId);
        }
      }
    }

    return result;
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

    const insertData: Record<string, any> = { ...dto, slug, product_count: 0 };

    if (dto.parent_id === null || dto.parent_id === undefined) {
      delete insertData.parent_id;
    }

    const { data, error } = await this.supabase
      .from('categories')
      .insert(insertData)
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
    const updateData: Record<string, any> = { ...dto };

    if (dto.parent_id === null || dto.parent_id === undefined) {
      delete updateData.parent_id;
    }

    const { data, error } = await this.supabase
      .from('categories')
      .update(updateData)
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
    const { data: childCategories, error: childError } = await this.supabase
      .from('categories')
      .select('id')
      .eq('parent_id', id);

    if (childError) {
      this.logger.error(
        `Failed to check child categories for ${id}: ${childError.message}`,
      );
      throw new InternalServerErrorException('An internal error occurred');
    }

    if (childCategories && childCategories.length > 0) {
      throw new ConflictException(
        `Cannot delete category: it still has ${childCategories.length} sub-categor(ies). Remove or reassign them first.`,
      );
    }

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
