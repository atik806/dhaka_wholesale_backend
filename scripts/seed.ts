import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const categories = [
  { name: 'Electronics', slug: 'electronics', description: 'Cutting-edge gadgets and devices', image_url: 'https://picsum.photos/seed/electronics/800/600' },
  { name: 'Fashion', slug: 'fashion', description: 'Trendsetting apparel and accessories', image_url: 'https://picsum.photos/seed/fashion/800/600' },
  { name: 'Home & Living', slug: 'home-living', description: 'Elevate your living space', image_url: 'https://picsum.photos/seed/home-living/800/600' },
  { name: 'Beauty', slug: 'beauty', description: 'Premium skincare and cosmetics', image_url: 'https://picsum.photos/seed/beauty/800/600' },
  { name: 'Sports', slug: 'sports', description: 'Gear for an active lifestyle', image_url: 'https://picsum.photos/seed/sports/800/600' },
  { name: 'Groceries', slug: 'groceries', description: 'Fresh and organic essentials', image_url: 'https://picsum.photos/seed/groceries/800/600' },
  { name: 'Toys & Games', slug: 'toys', description: 'Fun for all ages', image_url: 'https://picsum.photos/seed/toys/800/600' },
];

interface ProductData {
  name: string;
  category: string;
  price: number;
  original_price: number | null;
  images: string[];
  rating: number;
  review_count: number;
  stock: 'in-stock' | 'low-stock' | 'out-of-stock';
  description: string;
  tags: string[];
  is_new: boolean;
  is_featured: boolean;
  created_at: string;
}

const products: ProductData[] = [
  { name: 'Wireless Noise-Canceling Headphones', category: 'Electronics', price: 249, original_price: 349, images: ['https://picsum.photos/seed/elec-001-0/600/600', 'https://picsum.photos/seed/elec-001-1/600/600'], rating: 4.8, review_count: 234, stock: 'in-stock', description: 'Premium wireless headphones with active noise cancellation, 30-hour battery life, and ultra-comfortable memory foam ear cushions.', tags: ['wireless', 'audio', 'noise-canceling'], is_new: true, is_featured: true, created_at: '2025-12-01' },
  { name: 'Smart Watch Pro', category: 'Electronics', price: 399, original_price: 499, images: ['https://picsum.photos/seed/elec-002-0/600/600', 'https://picsum.photos/seed/elec-002-1/600/600'], rating: 4.6, review_count: 189, stock: 'in-stock', description: 'Advanced smartwatch with health monitoring, GPS tracking, and a stunning always-on AMOLED display.', tags: ['wearable', 'fitness', 'smart'], is_new: false, is_featured: true, created_at: '2025-11-20' },
  { name: 'Ultra-Slim Laptop 15', category: 'Electronics', price: 1299, original_price: 1599, images: ['https://picsum.photos/seed/elec-003-0/600/600', 'https://picsum.photos/seed/elec-003-1/600/600'], rating: 4.7, review_count: 156, stock: 'in-stock', description: 'Powerful ultrabook with the latest processor, 16GB RAM, and a brilliant 15.6-inch 4K OLED display.', tags: ['laptop', 'ultrabook', 'productivity'], is_new: false, is_featured: true, created_at: '2025-10-15' },
  { name: 'Portable Bluetooth Speaker', category: 'Electronics', price: 79, original_price: 99, images: ['https://picsum.photos/seed/elec-004-0/600/600', 'https://picsum.photos/seed/elec-004-1/600/600'], rating: 4.5, review_count: 412, stock: 'in-stock', description: 'Waterproof portable speaker with 360-degree sound, 20-hour battery, and a built-in power bank.', tags: ['audio', 'portable', 'waterproof'], is_new: false, is_featured: false, created_at: '2025-09-10' },
  { name: 'Mechanical Keyboard RGB', category: 'Electronics', price: 149, original_price: null, images: ['https://picsum.photos/seed/elec-005-0/600/600', 'https://picsum.photos/seed/elec-005-1/600/600'], rating: 4.4, review_count: 89, stock: 'in-stock', description: 'Hot-swappable mechanical keyboard with per-key RGB, PBT keycaps, and gasket-mounted switches.', tags: ['gaming', 'typing', 'rgb'], is_new: true, is_featured: false, created_at: '2025-12-10' },
  { name: '4K Webcam Pro', category: 'Electronics', price: 199, original_price: 249, images: ['https://picsum.photos/seed/elec-006-0/600/600'], rating: 4.3, review_count: 67, stock: 'low-stock', description: 'Professional 4K webcam with auto-focus, built-in ring light, and AI-powered background blur.', tags: ['camera', 'streaming', '4k'], is_new: false, is_featured: false, created_at: '2025-08-20' },
  { name: 'Wireless Charging Pad', category: 'Electronics', price: 39, original_price: 49, images: ['https://picsum.photos/seed/elec-007-0/600/600'], rating: 4.2, review_count: 523, stock: 'in-stock', description: 'Fast wireless charger compatible with all Qi devices. Sleek aluminum design.', tags: ['charger', 'wireless', 'accessory'], is_new: false, is_featured: false, created_at: '2025-07-15' },
  { name: 'Tablet Pro 11', category: 'Electronics', price: 799, original_price: null, images: ['https://picsum.photos/seed/elec-008-0/600/600', 'https://picsum.photos/seed/elec-008-1/600/600'], rating: 4.7, review_count: 198, stock: 'in-stock', description: 'Versatile tablet with 11-inch Liquid Retina display and M-series chip.', tags: ['tablet', 'creative', 'productivity'], is_new: true, is_featured: false, created_at: '2025-12-05' },
  { name: 'Premium Cashmere Sweater', category: 'Fashion', price: 195, original_price: 295, images: ['https://picsum.photos/seed/fash-001-0/600/600', 'https://picsum.photos/seed/fash-001-1/600/600'], rating: 4.9, review_count: 145, stock: 'in-stock', description: 'Luxuriously soft cashmere sweater made from Grade-A Mongolian cashmere.', tags: ['cashmere', 'luxury', 'winter'], is_new: true, is_featured: true, created_at: '2025-12-08' },
  { name: 'Slim Fit Tailored Blazer', category: 'Fashion', price: 299, original_price: null, images: ['https://picsum.photos/seed/fash-002-0/600/600', 'https://picsum.photos/seed/fash-002-1/600/600'], rating: 4.7, review_count: 89, stock: 'in-stock', description: 'Sharp tailored blazer in Italian wool blend. Peak lapels, dual vents.', tags: ['formal', 'blazer', 'wool'], is_new: false, is_featured: true, created_at: '2025-11-10' },
  { name: 'Artisan Leather Tote', category: 'Fashion', price: 259, original_price: 329, images: ['https://picsum.photos/seed/fash-003-0/600/600', 'https://picsum.photos/seed/fash-003-1/600/600'], rating: 4.8, review_count: 212, stock: 'in-stock', description: 'Handcrafted full-grain leather tote with gold hardware.', tags: ['leather', 'handbag', 'artisan'], is_new: false, is_featured: true, created_at: '2025-10-25' },
  { name: 'Classic White Sneakers', category: 'Fashion', price: 129, original_price: null, images: ['https://picsum.photos/seed/fash-004-0/600/600', 'https://picsum.photos/seed/fash-004-1/600/600'], rating: 4.6, review_count: 534, stock: 'in-stock', description: 'Minimalist leather sneakers with cushioned insoles and gum rubber sole.', tags: ['sneakers', 'leather', 'classic'], is_new: false, is_featured: false, created_at: '2025-09-05' },
  { name: 'Silk Evening Dress', category: 'Fashion', price: 449, original_price: null, images: ['https://picsum.photos/seed/fash-005-0/600/600', 'https://picsum.photos/seed/fash-005-1/600/600'], rating: 4.9, review_count: 56, stock: 'low-stock', description: 'Elegant 100% mulberry silk evening gown with flattering A-line silhouette.', tags: ['silk', 'evening', 'luxury'], is_new: true, is_featured: false, created_at: '2025-12-12' },
  { name: 'Cashmere Blend Scarf', category: 'Fashion', price: 89, original_price: 120, images: ['https://picsum.photos/seed/fash-006-0/600/600'], rating: 4.5, review_count: 321, stock: 'in-stock', description: 'Luxurious cashmere-blend scarf with classic herringbone pattern.', tags: ['scarf', 'cashmere', 'winter'], is_new: false, is_featured: false, created_at: '2025-09-20' },
  { name: 'Denim Jacket Vintage', category: 'Fashion', price: 159, original_price: null, images: ['https://picsum.photos/seed/fash-007-0/600/600', 'https://picsum.photos/seed/fash-007-1/600/600'], rating: 4.4, review_count: 178, stock: 'in-stock', description: 'Vintage-wash denim jacket with relaxed fit and corduroy collar.', tags: ['denim', 'jacket', 'vintage'], is_new: true, is_featured: false, created_at: '2025-11-30' },
  { name: 'Leather Crossbody Bag', category: 'Fashion', price: 179, original_price: null, images: ['https://picsum.photos/seed/fash-008-0/600/600', 'https://picsum.photos/seed/fash-008-1/600/600'], rating: 4.6, review_count: 267, stock: 'in-stock', description: 'Sleek crossbody bag in pebbled leather with adjustable strap.', tags: ['leather', 'crossbody', 'everyday'], is_new: false, is_featured: false, created_at: '2025-10-10' },
  { name: 'Scented Soy Candle Set', category: 'Home & Living', price: 45, original_price: 58, images: ['https://picsum.photos/seed/home-001-0/600/600', 'https://picsum.photos/seed/home-001-1/600/600'], rating: 4.7, review_count: 345, stock: 'in-stock', description: 'Set of three hand-poured soy wax candles in amber, vanilla, and sandalwood.', tags: ['candle', 'soy', 'gift'], is_new: false, is_featured: true, created_at: '2025-11-15' },
  { name: 'Linen Throw Blanket', category: 'Home & Living', price: 89, original_price: 119, images: ['https://picsum.photos/seed/home-002-0/600/600', 'https://picsum.photos/seed/home-002-1/600/600'], rating: 4.8, review_count: 167, stock: 'in-stock', description: 'Premium French linen throw in heathered oat. Stonewashed for softness.', tags: ['linen', 'blanket', 'boho'], is_new: false, is_featured: true, created_at: '2025-10-05' },
  { name: 'Ceramic Plant Pot Set', category: 'Home & Living', price: 55, original_price: null, images: ['https://picsum.photos/seed/home-003-0/600/600', 'https://picsum.photos/seed/home-003-1/600/600'], rating: 4.5, review_count: 98, stock: 'in-stock', description: 'Set of three matte ceramic planters in graduated sizes with drainage holes.', tags: ['ceramic', 'plants', 'decor'], is_new: false, is_featured: false, created_at: '2025-09-25' },
  { name: 'Minimalist Wall Clock', category: 'Home & Living', price: 69, original_price: null, images: ['https://picsum.photos/seed/home-004-0/600/600'], rating: 4.3, review_count: 76, stock: 'in-stock', description: 'Silent quartz wall clock with clean white face and slim gold rim.', tags: ['clock', 'minimalist', 'gold'], is_new: false, is_featured: false, created_at: '2025-08-12' },
  { name: 'Marble Serving Board', category: 'Home & Living', price: 39, original_price: null, images: ['https://picsum.photos/seed/home-005-0/600/600'], rating: 4.4, review_count: 134, stock: 'in-stock', description: 'Natural marble serving board with brass handles.', tags: ['marble', 'kitchen', 'entertaining'], is_new: false, is_featured: false, created_at: '2025-07-20' },
  { name: 'Bamboo Storage Set', category: 'Home & Living', price: 49, original_price: null, images: ['https://picsum.photos/seed/home-006-0/600/600'], rating: 4.2, review_count: 211, stock: 'in-stock', description: 'Sustainable bamboo storage boxes with lids. Set of 4.', tags: ['bamboo', 'storage', 'eco'], is_new: false, is_featured: false, created_at: '2025-06-15' },
  { name: 'Hydrating Face Serum', category: 'Beauty', price: 68, original_price: 85, images: ['https://picsum.photos/seed/beau-001-0/600/600', 'https://picsum.photos/seed/beau-001-1/600/600'], rating: 4.8, review_count: 423, stock: 'in-stock', description: 'Lightweight hyaluronic acid serum with vitamin C and niacinamide.', tags: ['serum', 'skincare', 'hydration'], is_new: false, is_featured: true, created_at: '2025-11-20' },
  { name: 'Natural Lipstick Set', category: 'Beauty', price: 42, original_price: null, images: ['https://picsum.photos/seed/beau-002-0/600/600', 'https://picsum.photos/seed/beau-002-1/600/600'], rating: 4.6, review_count: 189, stock: 'in-stock', description: 'Set of 5 clean, vegan lipsticks in everyday nudes and berries.', tags: ['lipstick', 'vegan', 'natural'], is_new: true, is_featured: false, created_at: '2025-12-01' },
  { name: 'Rose Quartz Facial Roller', category: 'Beauty', price: 29, original_price: null, images: ['https://picsum.photos/seed/beau-003-0/600/600'], rating: 4.4, review_count: 312, stock: 'in-stock', description: 'Genuine rose quartz facial roller with ergonomic handle.', tags: ['facial', 'skincare', 'self-care'], is_new: false, is_featured: false, created_at: '2025-08-30' },
  { name: 'Perfume Discovery Set', category: 'Beauty', price: 35, original_price: null, images: ['https://picsum.photos/seed/beau-004-0/600/600', 'https://picsum.photos/seed/beau-004-1/600/600'], rating: 4.7, review_count: 156, stock: 'in-stock', description: 'Curated set of 8 mini EDPs showcasing our signature collection.', tags: ['perfume', 'discovery', 'gift'], is_new: false, is_featured: false, created_at: '2025-10-15' },
  { name: 'Hair Repair Treatment', category: 'Beauty', price: 48, original_price: null, images: ['https://picsum.photos/seed/beau-005-0/600/600'], rating: 4.5, review_count: 278, stock: 'low-stock', description: 'Intensive bond-repair hair treatment with keratin and argan oil.', tags: ['hair', 'repair', 'treatment'], is_new: false, is_featured: false, created_at: '2025-09-10' },
  { name: 'Performance Running Shoes', category: 'Sports', price: 189, original_price: 239, images: ['https://picsum.photos/seed/spor-001-0/600/600', 'https://picsum.photos/seed/spor-001-1/600/600'], rating: 4.7, review_count: 345, stock: 'in-stock', description: 'Carbon-plated running shoes with responsive foam cushioning.', tags: ['running', 'shoes', 'performance'], is_new: false, is_featured: true, created_at: '2025-11-25' },
  { name: 'Yoga Mat Premium', category: 'Sports', price: 79, original_price: 99, images: ['https://picsum.photos/seed/spor-002-0/600/600', 'https://picsum.photos/seed/spor-002-1/600/600'], rating: 4.8, review_count: 523, stock: 'in-stock', description: 'Extra-thick 6mm eco-friendly TPE yoga mat with alignment marks.', tags: ['yoga', 'fitness', 'eco'], is_new: false, is_featured: true, created_at: '2025-10-20' },
  { name: 'Insulated Water Bottle', category: 'Sports', price: 34, original_price: null, images: ['https://picsum.photos/seed/spor-003-0/600/600'], rating: 4.6, review_count: 678, stock: 'in-stock', description: 'Double-wall vacuum insulated stainless steel bottle. 32oz.', tags: ['bottle', 'hydration', 'eco'], is_new: false, is_featured: false, created_at: '2025-09-15' },
  { name: 'Resistance Band Set', category: 'Sports', price: 29, original_price: null, images: ['https://picsum.photos/seed/spor-004-0/600/600'], rating: 4.3, review_count: 432, stock: 'in-stock', description: 'Set of 5 resistance bands with different tension levels.', tags: ['bands', 'home-gym', 'fitness'], is_new: false, is_featured: false, created_at: '2025-08-10' },
  { name: 'Cycling Helmet Aero', category: 'Sports', price: 149, original_price: null, images: ['https://picsum.photos/seed/spor-005-0/600/600'], rating: 4.5, review_count: 87, stock: 'in-stock', description: 'Aero road cycling helmet with MIPS protection system.', tags: ['cycling', 'helmet', 'aero'], is_new: true, is_featured: false, created_at: '2025-11-05' },
  { name: 'Organic Coffee Beans', category: 'Groceries', price: 24, original_price: 30, images: ['https://picsum.photos/seed/groc-001-0/600/600', 'https://picsum.photos/seed/groc-001-1/600/600'], rating: 4.9, review_count: 567, stock: 'in-stock', description: 'Single-origin organic Arabica beans from Ethiopia. Medium roast.', tags: ['coffee', 'organic', 'gourmet'], is_new: false, is_featured: true, created_at: '2025-12-02' },
  { name: 'Artisan Honey Jar', category: 'Groceries', price: 18, original_price: null, images: ['https://picsum.photos/seed/groc-002-0/600/600'], rating: 4.7, review_count: 234, stock: 'in-stock', description: 'Raw wildflower honey from small-batch apiaries. 12oz.', tags: ['honey', 'artisan', 'raw'], is_new: false, is_featured: false, created_at: '2025-10-01' },
  { name: 'Truffle Olive Oil', category: 'Groceries', price: 32, original_price: null, images: ['https://picsum.photos/seed/groc-003-0/600/600'], rating: 4.6, review_count: 145, stock: 'in-stock', description: 'Premium extra virgin olive oil infused with black truffle.', tags: ['oil', 'truffle', 'gourmet'], is_new: false, is_featured: false, created_at: '2025-09-25' },
  { name: 'Matcha Green Tea Powder', category: 'Groceries', price: 28, original_price: 35, images: ['https://picsum.photos/seed/groc-004-0/600/600'], rating: 4.5, review_count: 312, stock: 'in-stock', description: 'Ceremonial grade Japanese matcha from Uji. 100g tin.', tags: ['matcha', 'tea', 'japanese'], is_new: false, is_featured: false, created_at: '2025-08-05' },
  { name: 'Wooden Building Blocks', category: 'Toys & Games', price: 44, original_price: null, images: ['https://picsum.photos/seed/toys-001-0/600/600', 'https://picsum.photos/seed/toys-001-1/600/600'], rating: 4.8, review_count: 189, stock: 'in-stock', description: '100-piece natural wooden building block set. Non-toxic paints.', tags: ['wooden', 'educational', 'eco'], is_new: false, is_featured: true, created_at: '2025-11-18' },
  { name: 'Strategy Board Game', category: 'Toys & Games', price: 39, original_price: null, images: ['https://picsum.photos/seed/toys-002-0/600/600'], rating: 4.6, review_count: 267, stock: 'in-stock', description: 'Award-winning strategy game for 2-4 players. 45-minute playtime.', tags: ['board-game', 'strategy', 'family'], is_new: false, is_featured: false, created_at: '2025-10-10' },
  { name: 'Plush Panda Bear', category: 'Toys & Games', price: 32, original_price: null, images: ['https://picsum.photos/seed/toys-003-0/600/600'], rating: 4.9, review_count: 423, stock: 'in-stock', description: 'Ultra-soft panda plush made from recycled materials. 18 inches.', tags: ['plush', 'panda', 'eco'], is_new: true, is_featured: false, created_at: '2025-12-01' },
  { name: 'STEM Robot Kit', category: 'Toys & Games', price: 59, original_price: null, images: ['https://picsum.photos/seed/toys-004-0/600/600'], rating: 4.4, review_count: 134, stock: 'low-stock', description: 'Build your own programmable robot with this STEM kit.', tags: ['stem', 'robot', 'educational'], is_new: false, is_featured: false, created_at: '2025-09-05' },
];

async function seed() {
  console.log('Seeding database...\n');

  const { error: deleteCategoriesError } = await supabase.from('categories').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (deleteCategoriesError && deleteCategoriesError.code !== 'PGRST116') {
    console.error('Error clearing categories:', deleteCategoriesError.message);
  }

  const { data: insertedCategories, error: catError } = await supabase
    .from('categories')
    .insert(categories.map(c => ({
      name: c.name,
      slug: c.slug,
      description: c.description,
      image_url: c.image_url,
      product_count: 0,
    })))
    .select();

  if (catError) {
    console.error('Error inserting categories:', catError.message);
    process.exit(1);
  }

  console.log(`Inserted ${insertedCategories.length} categories`);

  const categoryMap = new Map<string, string>();
  for (const cat of insertedCategories) {
    categoryMap.set(cat.name, cat.id);
  }

  const { error: deleteProductsError } = await supabase.from('products').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (deleteProductsError && deleteProductsError.code !== 'PGRST116') {
    console.error('Error clearing products:', deleteProductsError.message);
  }

  const productRecords = products.map((p) => {
    const catId = categoryMap.get(p.category);
    if (!catId) {
      console.warn(`Category not found for product: ${p.name} (${p.category})`);
    }
    return {
      name: p.name,
      slug: p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
      description: p.description,
      price: p.price,
      original_price: p.original_price,
      category_id: catId || '',
      images: p.images,
      rating: p.rating,
      review_count: p.review_count,
      stock: p.stock,
      tags: p.tags,
      is_new: p.is_new,
      is_featured: p.is_featured,
      created_at: p.created_at,
    };
  });

  const { data: insertedProducts, error: prodError } = await supabase
    .from('products')
    .insert(productRecords)
    .select();

  if (prodError) {
    console.error('Error inserting products:', prodError.message);
    process.exit(1);
  }

  console.log(`Inserted ${insertedProducts.length} products\n`);

  for (const cat of insertedCategories) {
    const count = products.filter((p) => p.category === cat.name).length;
    await supabase
      .from('categories')
      .update({ product_count: count })
      .eq('id', cat.id);
  }

  console.log('Updated product counts for categories');
  console.log('\nSeed completed successfully!');
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
