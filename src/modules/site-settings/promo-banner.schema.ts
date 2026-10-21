import { z } from 'zod';

function validButtonLink(value: string): boolean {
  if (/[\s\\]/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export const PromoBannerSchema = z
  .object({
    badge: z.string().trim().max(80),
    title: z.string().trim().max(160),
    subtitle: z.string().trim().max(500),
    button_text: z.string().trim().max(60),
    button_link: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(
        validButtonLink,
        'Use a site path such as /shop or a full HTTP/HTTPS URL',
      ),
    enabled: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.enabled && !value.title) {
      context.addIssue({
        code: 'custom',
        path: ['title'],
        message: 'A visible banner needs a title',
      });
    }
    if (value.enabled && !value.button_text) {
      context.addIssue({
        code: 'custom',
        path: ['button_text'],
        message: 'A visible banner needs button text',
      });
    }
  });
