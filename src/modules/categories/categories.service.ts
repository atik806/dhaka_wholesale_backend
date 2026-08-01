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
import { CacheStore } from '../../common/cache/cache-store.js';

@Injectable()
export class CategoriesService {
  private readonly logger = new Logger(CategoriesService.name);
  private supabase = createSupabaseAdminClient();

  constructor(private readonly cacheStore: CacheStore) {}

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
    // Prefer the database-side recursive CTE (single round trip, no full
    // categories payload). Falls back to a lightweight in-memory walk.
    try {
      const { data, error } = await this.supabase.rpc(
        'get_child_category_ids',
        { p_parent_id: parentId },
      );
      if (!error && Array.isArray(data)) return data as string[];
    } catch {
      // fall through to the client-side fallback below
    }

    // Fallback: fetch only the lightweight relationship columns (avoids
    // pulling every category's full row — including name, description,
    // image_url — on each category-filtered product listing).
    const { data, error } = await this.supabase
      .from('categories')
      .select('id, parent_id');

    if (error)
      throw new InternalServerErrorException('An internal error occurred');

    const childrenMap = new Map<string, string[]>();
    for (const cat of data ?? []) {
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

    if (dto.parent_id) {
      const { data: parentExists } = await this.supabase
        .from('categories')
        .select('id')
        .eq('id', dto.parent_id)
        .maybeSingle();

      if (!parentExists) {
        throw new NotFoundException('Parent category not found');
      }
    }

    const insertData: Record<string, any> = { ...dto, slug, product_count: 0 };

    if (dto.parent_id === undefined) {
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
    this.invalidateCategoryCaches();
    return data;
  }

  async update(id: string, dto: UpdateCategoryDto) {
    if (dto.parent_id) {
      if (dto.parent_id === id) {
        throw new ConflictException('A category cannot be its own parent');
      }

      const childIds = await this.getChildIds(id);
      if (childIds.includes(dto.parent_id)) {
        throw new ConflictException(
          'Cannot set a descendant as the parent (would create a cycle)',
        );
      }

      const { data: parentExists } = await this.supabase
        .from('categories')
        .select('id')
        .eq('id', dto.parent_id)
        .maybeSingle();

      if (!parentExists) {
        throw new NotFoundException('Parent category not found');
      }
    }

    const updateData: Record<string, any> = { ...dto };

    // Only strip the key when the caller did not send it. An explicit `null`
    // means "promote this category to a top-level (parent) category", so it
    // must be kept so the parent relationship is cleared.
    if (dto.parent_id === undefined) {
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
    this.invalidateCategoryCaches();
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
    this.invalidateCategoryCaches();
    return { message: 'Category deleted successfully' };
  }

  private invalidateCategoryCaches(): void {
    this.cacheStore.deleteByPrefix('GET:/categories');
    this.cacheStore.deleteByPrefix('GET:/products');
  }
}
