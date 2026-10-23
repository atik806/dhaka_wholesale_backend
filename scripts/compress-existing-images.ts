/**
 * One-time backfill: re-encode every image already in the `product-images`
 * bucket as a resized WebP (same settings as new uploads, see
 * src/modules/upload/image-compress.ts) and point the database at the new
 * files.
 *
 *   npx tsx scripts/compress-existing-images.ts            # dry run, no writes
 *   npx tsx scripts/compress-existing-images.ts --apply    # upload + rewrite rows
 *
 * Originals are NOT deleted, so any reference this script misses keeps
 * working, and the old->new map written to scripts/output/ is enough to
 * roll back (swap the URLs the other way).
 *
 * Rewritten columns: products.images, products.colors, categories.image_url,
 * order_items.product_image, site_settings.value.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { compressImage } from '../src/modules/upload/image-compress.js';

const BUCKET = 'product-images';
const APPLY = process.argv.includes('--apply');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const publicPrefix = `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/${BUCKET}/`;

interface Target {
  table: string;
  key: string;
  columns: string[];
}

const TARGETS: Target[] = [
  { table: 'products', key: 'id', columns: ['images', 'colors'] },
  { table: 'categories', key: 'id', columns: ['image_url'] },
  { table: 'order_items', key: 'id', columns: ['product_image'] },
  { table: 'site_settings', key: 'key', columns: ['value'] },
];

type Row = Record<string, unknown>;

async function fetchAll(target: Target): Promise<Row[]> {
  const rows: Row[] = [];
  const pageSize = 500;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(target.table)
      .select([target.key, ...target.columns].join(','))
      .order(target.key)
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${target.table}: ${error.message}`);
    rows.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < pageSize) return rows;
  }
}

/** Every bucket URL mentioned anywhere in a value. */
function collectUrls(value: unknown, out: Set<string>) {
  const text = JSON.stringify(value ?? null);
  const escaped = publicPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of text.matchAll(new RegExp(`${escaped}[^"\\\\?#]+`, 'g'))) {
    out.add(match[0]);
  }
}

function rewrite(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let next = value;
    for (const [from, to] of map) next = next.split(from).join(to);
    return next;
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rewrite(v, map)]),
    );
  }
  return value;
}

async function main() {
  console.log(APPLY ? 'MODE: APPLY (writes!)' : 'MODE: dry run');

  const tables = new Map<Target, Row[]>();
  const urls = new Set<string>();
  for (const target of TARGETS) {
    const rows = await fetchAll(target);
    tables.set(target, rows);
    for (const row of rows) for (const c of target.columns) collectUrls(row[c], urls);
    console.log(`${target.table}: ${rows.length} rows`);
  }
  console.log(`${urls.size} distinct ${BUCKET} URLs referenced`);

  const map = new Map<string, string>();
  let before = 0;
  let after = 0;
  let failed = 0;

  for (const url of urls) {
    const path = decodeURIComponent(url.slice(publicPrefix.length));
    const { data: blob, error } = await supabase.storage.from(BUCKET).download(path);
    if (error || !blob) {
      console.warn(`  skip (download failed): ${path} ${error?.message ?? ''}`);
      failed++;
      continue;
    }
    const original = Buffer.from(await blob.arrayBuffer());
    let compressed: Buffer;
    try {
      compressed = (await compressImage(original)).buffer;
    } catch (err) {
      console.warn(`  skip (not decodable): ${path} ${(err as Error).message}`);
      failed++;
      continue;
    }
    if (compressed.length >= original.length) {
      console.log(`  keep (already small): ${path} ${kb(original.length)}`);
      continue;
    }

    before += original.length;
    after += compressed.length;
    const newPath = `${Date.now()}-${randomUUID()}.webp`;
    console.log(`  ${path} ${kb(original.length)} -> ${kb(compressed.length)}`);

    if (APPLY) {
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(newPath, compressed, {
          contentType: 'image/webp',
          cacheControl: '31536000',
          upsert: false,
        });
      if (upErr) {
        console.warn(`  skip (upload failed): ${path} ${upErr.message}`);
        failed++;
        continue;
      }
    }
    map.set(url, `${publicPrefix}${newPath}`);
  }

  console.log(
    `\n${map.size} images: ${kb(before)} -> ${kb(after)} (${failed} failed)`,
  );

  let changedRows = 0;
  for (const [target, rows] of tables) {
    for (const row of rows) {
      const patch: Row = {};
      for (const c of target.columns) {
        const next = rewrite(row[c], map);
        if (JSON.stringify(next) !== JSON.stringify(row[c])) patch[c] = next;
      }
      if (Object.keys(patch).length === 0) continue;
      changedRows++;
      if (!APPLY) continue;
      const { error } = await supabase
        .from(target.table)
        .update(patch)
        .eq(target.key, row[target.key] as string);
      if (error) {
        console.error(`  row update failed ${target.table}/${String(row[target.key])}: ${error.message}`);
        failed++;
      }
    }
  }
  console.log(`${changedRows} rows ${APPLY ? 'updated' : 'would be updated'}`);

  if (APPLY && map.size > 0) {
    mkdirSync('scripts/output', { recursive: true });
    const file = `scripts/output/image-compress-map-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify(Object.fromEntries(map), null, 2));
    console.log(`rollback map: ${file}`);
  }
  if (failed > 0) process.exitCode = 1;
}

function kb(bytes: number) {
  return `${Math.round(bytes / 1024)} KB`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
