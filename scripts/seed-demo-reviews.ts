import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createClient, type User } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const shouldApply = process.argv.includes('--apply');

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DEMO_AVATAR_MARKER = 'demo-review://generated';

interface DemoReview {
  reviewerSlug: string;
  reviewerName: string;
  productSlug: string;
  rating: number;
  text: string;
  daysAgo: number;
}

// These are fictional, clearly marked demo profiles. The reviews are specific
// to the current catalog so development and showcase environments look natural.
const demoReviews: DemoReview[] = [
  {
    reviewerSlug: 'nusrat-jahan',
    reviewerName: 'Nusrat Jahan',
    productSlug: 'qcy-melobuds-n50-adaptive-anc-true-wireless-earbuds-pruple',
    rating: 5,
    text: 'Noise cancellation works well during my daily bus commute, and the bass is clear without sounding muddy. The purple colour also matches the photos. Delivery to Mirpur took two days.',
    daysAgo: 2,
  },
  {
    reviewerSlug: 'sadiya-rahman',
    reviewerName: 'Sadiya Rahman',
    productSlug: 'crystal-floral-hair-claw-clip-pink-and-amber',
    rating: 4,
    text: 'The clip looks just like the picture and holds my thick hair for around four to five hours. Packaging was careful, although I expected the spring to feel a little tighter.',
    daysAgo: 5,
  },
  {
    reviewerSlug: 'tanvir-hasan',
    reviewerName: 'Tanvir Hasan',
    productSlug: 'vgr-v-052-trimmer-hair-clipper-beard-trimmer',
    rating: 4,
    text: 'Gives an even trim and did not pull my beard. USB charging is convenient and the battery easily handled two full trims. The guard feels slightly light, but the trimmer itself is solid for the price.',
    daysAgo: 9,
  },
  {
    reviewerSlug: 'farzana-akter',
    reviewerName: 'Farzana Akter',
    productSlug: 'daisy-bracelet',
    rating: 5,
    text: 'Simple, neat design and comfortable on my wrist. I wore it twice for long events and the colour still looks fresh. It also arrived in a nice little pouch.',
    daysAgo: 14,
  },
  {
    reviewerSlug: 'imran-hossain',
    reviewerName: 'Imran Hossain',
    productSlug: 'triangle-wooden-style-digital-led-clock-dark-wood',
    rating: 4,
    text: 'The display is easy to read at night and the dark wood finish looks good on my desk. Setup took a few tries because the instructions are brief, but it has kept time accurately.',
    daysAgo: 20,
  },
  {
    reviewerSlug: 'mehedi-hasan',
    reviewerName: 'Mehedi Hasan',
    productSlug: '7-color-crocodile-shape-silicone-night-light-toy-for-kids',
    rating: 5,
    text: 'Bought this for my niece and she loved it. The silicone is soft, the light is gentle enough for bedtime, and changing the colours is fun. It was packed safely with no damage.',
    daysAgo: 27,
  },
  {
    reviewerSlug: 'jannatul-ferdous',
    reviewerName: 'Jannatul Ferdous',
    productSlug: 'silk-style-scrunchie-hair-band-assorted-colors',
    rating: 4,
    text: 'The fabric feels smooth and does not tug at my hair. The colours I received were wearable for everyday use. A little more stretch would make it perfect, but it is good value.',
    daysAgo: 35,
  },
  {
    reviewerSlug: 'arif-mahmud',
    reviewerName: 'Arif Mahmud',
    productSlug: 'hoco-ew76-true-wireless-bluetooth-earbuds',
    rating: 4,
    text: 'Music and indoor calls sound clear, and the battery gets me through a normal workday. The microphone picks up some traffic noise outdoors, but overall this is a dependable budget option.',
    daysAgo: 43,
  },
];

function demoEmail(reviewerSlug: string) {
  return `review-demo-${reviewerSlug}@example.invalid`;
}

async function findAuthUser(email: string): Promise<User | null> {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    const match = data.users.find((user) => user.email === email);
    if (match) return match;
    if (data.users.length < 1000) return null;
  }
  throw new Error(`Could not finish searching auth users for ${email}`);
}

async function ensureDemoProfile(review: DemoReview): Promise<string> {
  const email = demoEmail(review.reviewerSlug);
  let user = await findAuthUser(email);

  if (!user) {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: `${randomUUID()}Aa1!`,
      email_confirm: true,
      user_metadata: {
        name: review.reviewerName,
        is_demo_review_profile: true,
      },
    });
    if (error || !data.user)
      throw error ?? new Error(`Could not create ${email}`);
    user = data.user;
  }

  const { error: profileError } = await supabase.from('profiles').upsert(
    {
      id: user.id,
      name: review.reviewerName,
      email,
      avatar_url: DEMO_AVATAR_MARKER,
      role: 'customer',
    },
    { onConflict: 'id' },
  );
  if (profileError) throw profileError;

  return user.id;
}

async function seedDemoReviews() {
  const productSlugs = [
    ...new Set(demoReviews.map((review) => review.productSlug)),
  ];
  const { data: products, error: productsError } = await supabase
    .from('products')
    .select('id, name, slug')
    .in('slug', productSlugs);

  if (productsError) throw productsError;

  const productsBySlug = new Map(
    (products ?? []).map((product) => [product.slug, product]),
  );
  const missingSlugs = productSlugs.filter((slug) => !productsBySlug.has(slug));
  if (missingSlugs.length > 0) {
    throw new Error(`Products not found: ${missingSlugs.join(', ')}`);
  }

  if (process.argv.includes('--verify')) {
    const { data: saved, error } = await supabase
      .from('reviews')
      .select(
        'rating, text, profiles(name, avatar_url), products(name, rating, review_count)',
      )
      .in(
        'product_id',
        (products ?? []).map((product) => product.id),
      )
      .like('text', 'Sample review (fictional):%');
    if (error) throw error;
    if (saved?.length !== demoReviews.length) {
      throw new Error(
        `Expected ${demoReviews.length} sample reviews; found ${saved?.length ?? 0}`,
      );
    }
    for (const review of saved) {
      console.log(JSON.stringify(review));
    }
    console.log(
      `Verified ${saved.length} saved sample reviews and their product totals.`,
    );
    return;
  }

  if (!shouldApply) {
    console.log(
      'Dry run only. The following clearly labelled demo reviews are ready:',
    );
    for (const review of demoReviews) {
      console.log(
        `- ${review.reviewerName} -> ${productsBySlug.get(review.productSlug)?.name} (${review.rating}/5)`,
      );
    }
    console.log('\nRun npm run seed:demo-reviews -- --apply to write them.');
    return;
  }

  for (const review of demoReviews) {
    const product = productsBySlug.get(review.productSlug)!;
    const userId = await ensureDemoProfile(review);
    const { data: existing, error: existingError } = await supabase
      .from('reviews')
      .select('id')
      .eq('product_id', product.id)
      .eq('user_id', userId)
      .maybeSingle();
    if (existingError) throw existingError;

    const reviewRecord = {
      rating: review.rating,
      // Keep disclosure visible even before the updated storefront is deployed.
      text: `Sample review (fictional): ${review.text}`,
    };

    const { error: reviewError } = existing
      ? await supabase
          .from('reviews')
          .update(reviewRecord)
          .eq('id', existing.id)
      : await supabase.from('reviews').insert({
          ...reviewRecord,
          product_id: product.id,
          user_id: userId,
          created_at: new Date(
            Date.now() - review.daysAgo * 86_400_000,
          ).toISOString(),
        });
    if (reviewError) throw reviewError;

    console.log(`Seeded ${review.reviewerName} -> ${product.name}`);
  }

  console.log(`\nSeeded ${demoReviews.length} demo reviews successfully.`);
}

seedDemoReviews().catch((error: unknown) => {
  console.error(
    'Demo review seed failed:',
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
