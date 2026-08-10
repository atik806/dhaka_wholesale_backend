import { z } from 'zod';

/**
 * Only `http:`/`https:` URLs with a host pass. `page_url` lands in an
 * `<a href>` in the admin bug-reports UI, so schemes like `javascript:`,
 * `data:`, or `file:` must never reach it. `new URL()` parses (but does not
 * fetch) the value, then the scheme + host are checked explicitly.
 */
const httpUrl = (field: string, max: number) =>
  z
    .string()
    .min(1, `${field} is required`)
    .max(max, `${field} must be at most ${max} characters`)
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          return (
            (url.protocol === 'http:' || url.protocol === 'https:') &&
            url.host.length > 0
          );
        } catch {
          return false;
        }
      },
      { message: `${field} must be a valid http(s) URL` },
    );

export const CreateReportSchema = z.object({
  message: z.string().min(1, 'Description is required').max(2000),
  screenshot_url: httpUrl('Screenshot URL', 500).optional().nullable(),
  page_url: httpUrl('Page URL', 500),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
});

export type CreateReportDto = z.infer<typeof CreateReportSchema>;
