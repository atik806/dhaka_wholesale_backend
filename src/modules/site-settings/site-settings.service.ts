import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

/**
 * Keys the public (unauthenticated) GET endpoints may expose. Everything
 * else — payment config, contact info, keys — stays admin-only. The frontend
 * reads exactly one public key today: `promo_banner`.
 */
const PUBLIC_SETTINGS_KEYS = ['promo_banner'];

@Injectable()
export class SiteSettingsService {
  private supabase = createSupabaseAdminClient();

  async getAll() {
    const { data, error } = await this.supabase
      .from('site_settings')
      .select('key, value')
      .in('key', PUBLIC_SETTINGS_KEYS);

    if (error)
      throw new InternalServerErrorException('Failed to fetch site settings');

    const settings: Record<string, unknown> = {};
    data?.forEach((row) => {
      settings[row.key] = row.value;
    });
    return settings;
  }

  async get(key: string) {
    // Non-allowlisted keys 404 exactly like a missing row, so an attacker
    // cannot distinguish "key exists but hidden" from "key doesn't exist".
    if (!PUBLIC_SETTINGS_KEYS.includes(key)) {
      throw new NotFoundException('Site setting not found');
    }

    const { data, error } = await this.supabase
      .from('site_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    if (error)
      throw new InternalServerErrorException('Failed to fetch site setting');
    if (!data) throw new NotFoundException('Site setting not found');
    return data.value;
  }

  async update(key: string, value: Record<string, unknown>, userId?: string) {
    const updatePayload: Record<string, unknown> = {
      value,
      updated_at: new Date().toISOString(),
    };
    if (userId) updatePayload.updated_by = userId;

    const { data, error } = await this.supabase
      .from('site_settings')
      .upsert({ key, ...updatePayload }, { onConflict: 'key' })
      .select()
      .single();

    if (error)
      throw new InternalServerErrorException('Failed to update site setting');
    return data;
  }

  async updateMany(settings: Record<string, unknown>, userId?: string) {
    const updates = Object.entries(settings).map(([key, value]) => ({
      key,
      value,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    }));

    const { data, error } = await this.supabase
      .from('site_settings')
      .upsert(updates, { onConflict: 'key' })
      .select();

    if (error)
      throw new InternalServerErrorException('Failed to update site settings');
    return data;
  }
}
