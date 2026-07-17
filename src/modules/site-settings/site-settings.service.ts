import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

@Injectable()
export class SiteSettingsService {
  private supabase = createSupabaseAdminClient();

  async getAll() {
    const { data, error } = await this.supabase
      .from('site_settings')
      .select('key, value');

    if (error)
      throw new InternalServerErrorException('Failed to fetch site settings');

    const settings: Record<string, unknown> = {};
    data?.forEach((row) => {
      settings[row.key] = row.value;
    });
    return settings;
  }

  async get(key: string) {
    const { data, error } = await this.supabase
      .from('site_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    if (error)
      throw new InternalServerErrorException('Failed to fetch site setting');
    return data?.value || null;
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
