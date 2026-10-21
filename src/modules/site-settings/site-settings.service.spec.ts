import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { SiteSettingsService } from './site-settings.service.js';
import { createSupabaseAdminClient } from '../../config/supabase.config.js';

jest.mock('../../config/supabase.config.js', () => ({
  createSupabaseAdminClient: jest.fn(),
}));

describe('Promo banner persistence', () => {
  const valid = {
    badge: ' Sale ',
    title: ' Promotion ',
    subtitle: 'Details',
    button_text: 'Shop',
    button_link: '/shop',
    enabled: true,
  };
  const from = jest.fn();
  const upsert = jest.fn();
  const select = jest.fn();
  const single = jest.fn();
  let service: SiteSettingsService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(createSupabaseAdminClient).mockReturnValue({ from } as never);
    from.mockReturnValue({ upsert });
    upsert.mockReturnValue({ select });
    select.mockResolvedValue({ data: [], error: null });
    single.mockResolvedValue({ data: { key: 'promo_banner' }, error: null });
    service = new SiteSettingsService();
  });

  it('persists normalized settings and the updating administrator', async () => {
    await service.updateMany({ promo_banner: valid }, 'admin-id');
    expect(upsert).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          key: 'promo_banner',
          updated_by: 'admin-id',
          value: { ...valid, badge: 'Sale', title: 'Promotion' },
        }),
      ],
      { onConflict: 'key' },
    );
  });

  it.each([
    null,
    [],
    'invalid',
    {},
    { ...valid, enabled: 'false' },
    { ...valid, title: '  ' },
    { ...valid, title: 'x'.repeat(161) },
    { ...valid, button_text: '' },
    ...['javascript:alert(1)', '//evil.test', '/\\evil.test', 'not a link'].map(
      (button_link) => ({ ...valid, button_link }),
    ),
  ])('rejects invalid banner data before writing: %j', async (value) => {
    await expect(
      service.updateMany({ promo_banner: value }, 'admin-id'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('validates the single-key endpoint as well', async () => {
    await expect(
      service.update('promo_banner', { ...valid, enabled: 'false' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('allows hiding a banner with empty draft text', async () => {
    await service.updateMany({
      promo_banner: { ...valid, enabled: false, title: '', button_text: '' },
    });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('does not report success when the database rejects the save', async () => {
    select.mockResolvedValue({
      data: null,
      error: { message: 'Database unavailable' },
    });
    await expect(
      service.updateMany({ promo_banner: valid }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
