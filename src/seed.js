// Seeds plans, categories, an admin account and the directory content in seed-data/.
// Usage: npm run seed   (plans/categories are upserted; content is only loaded into an empty DB)
require('dotenv').config();
const path = require('path');
const bcrypt = require('bcryptjs');
const { connect, close, col, insert, nextId } = require('./db');
const { slugify } = require('./utils');
const { LISTING_FIELDS } = require('./listingService');

const load = (name) => require(path.join(__dirname, '..', 'seed-data', `${name}.json`));

const PREFERRED_FEATURES = ['phone', 'email', 'logo', 'images', 'description', 'website', 'hours', 'reviews',
  'social_links', 'facebook_feed', 'analytics'];

// Plan descriptions are the bullet points on the Advertise page, one per line.
const PLANS = [
  {
    slug: 'facebook-advertising', name: 'Facebook Advertising', price_monthly: 199, price_yearly: 1999,
    max_categories: 8, max_images: 20, rank: 100, is_listing_plan: true,
    features: [...PREFERRED_FEATURES, 'facebook_campaigns'],
    description: '16 ad placements a month in local Facebook groups\nFull listing included: 8 categories, 20-photo gallery\nInsights on how your ads perform',
  },
  {
    slug: 'preferred', name: 'Preferred', price_monthly: 49.99, price_yearly: 499, max_categories: 4, max_images: 6, rank: 30,
    is_listing_plan: true, features: PREFERRED_FEATURES,
    description: 'Everything in Standard\nWebsite link & hours\nRatings & reviews\nFull description & badges\nSocial pages & Facebook feed\nPhoto gallery (6 images)\n4 categories',
  },
  {
    slug: 'standard', name: 'Standard', price_monthly: 29.99, price_yearly: 299, max_categories: 2, max_images: 2, rank: 20,
    is_listing_plan: true, features: ['phone', 'email', 'logo', 'images', 'description'],
    description: 'Everything in Basic\nLogo, cover image & map\nShort description\nPhoto gallery (2 images)\n2 categories',
  },
  {
    slug: 'basic', name: 'Basic', price_monthly: 9.99, price_yearly: 99, max_categories: 1, max_images: 0, rank: 10,
    is_listing_plan: true, features: ['phone', 'email'],
    description: 'Your own listing page\nPhone & email\n1 category',
  },
];

const EVENT_CATEGORIES = ['Local Events', 'Festivals', 'Markets', 'Sports & Fitness'];
const BLOG_CATEGORIES = ['Things to Do', 'Local Guides', 'Business Spotlights'];

// Shown in the homepage "A few of your neighbors" section.
const FEATURED = ['titan-plumbing-and-electric', 'zios-new-york-bagel-deli', 'pulse-salon-spa',
  'larsens-pool-spa', 'your-green-team', 'flo-rite-air-conditioning-heating', 'outsmart-pest-management'];

const TZ = 'America/New_York';

// Converts a wall-clock time in TZ to a UTC Date.
function zonedTime(date, hour, minute) {
  const guess = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(guess).map((p) => [p.type, p.value]));
  const asZoned = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return new Date(guess.getTime() - (asZoned - guess.getTime()));
}

// "10 AM – 9 PM" on 2026-10-17 → [start, end] as UTC Dates.
function eventTimes(date, time) {
  const times = [...time.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/gi)].map(([, h, m, ap]) => {
    const hour = (Number(h) % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0);
    return zonedTime(date, hour, Number(m || 0));
  });
  return [times[0] ?? zonedTime(date, 0, 0), times[1] ?? null];
}

// Imported listings get the cheapest plan that covers the fields they use.
function planFor(b) {
  if (b.website) return 'preferred';
  if (b.image) return 'standard';
  return 'basic';
}

// Inserts or updates a document by a unique key, giving new documents an integer id.
async function upsert(name, key, fields) {
  const existing = await col(name).findOne(key);
  if (existing) await col(name).updateOne({ _id: existing._id }, { $set: fields });
  else await col(name).insertOne({ _id: await nextId(name), ...key, ...fields });
}

async function seed() {
  for (const { slug, ...p } of PLANS) await upsert('plans', { slug }, p);

  const cats = [
    ...load('categories').map((c, i) => ['listing', c.name, c.slug, c.intro, i]),
    ...EVENT_CATEGORIES.map((n, i) => ['event', n, slugify(n), null, i]),
    ...BLOG_CATEGORIES.map((n, i) => ['blog', n, slugify(n), null, i]),
  ];
  for (const [type, name, slug, description, position] of cats) {
    const existing = await col('categories').findOne({ type, slug });
    await upsert('categories', { type, slug }, { name, description, position, parent_id: existing?.parent_id ?? null });
  }

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'changeme123';
  let admin = await col('users').findOne({ email_lower: adminEmail.toLowerCase() });
  if (!admin) {
    admin = await insert('users', {
      name: 'Site Admin', email: adminEmail, email_lower: adminEmail.toLowerCase(), phone: null, location: null,
      password_hash: bcrypt.hashSync(adminPassword, 10), role: 'admin', reset_token: null, reset_expires: null,
      created_at: new Date(),
    });
  }

  if (await col('listings').countDocuments() > 0) return { content: false, adminEmail };

  const planId = async (slug) => (await col('plans').findOne({ slug }))._id;
  const catId = async (type, slug) => (await col('categories').findOne({ type, slug }))._id;
  const inYear = new Date(Date.now() + 365 * 864e5).toISOString();
  const now = new Date();

  // Imported listings are site-managed (owned by the admin) until a business claims them.
  const businesses = load('businesses');
  for (const b of businesses) {
    await insert('listings', {
      ...Object.fromEntries(LISTING_FIELDS.map((f) => [f, null])),
      owner_id: admin._id, plan_id: await planId(planFor(b)), billing_cycle: 'yearly', status: 'active',
      featured: FEATURED.includes(b.slug), title: b.name, slug: b.slug, tags: b.tags, phone: b.phone,
      website: b.website ?? null, address: b.address ?? null, city: b.city ?? null, state: 'FL',
      image_url: b.image ?? null, images: [], views: 0, expires_at: inYear, created_at: now, updated_at: now,
      category_ids: [await catId('listing', b.category)],
    });
  }

  const events = load('events');
  const eventCat = await catId('event', 'local-events');
  for (const e of events) {
    const [start, end] = eventTimes(e.date, e.time);
    await insert('events', {
      owner_id: admin._id, listing_id: null, category_id: eventCat, status: 'active', featured: false,
      title: e.title, slug: e.slug, summary: e.summary, description: null, starts_at: start, ends_at: end,
      venue: e.venue, organizer: e.organizer, tags: e.tags, address: e.address, city: e.city, state: 'FL', zip: null,
      website: e.url, contact_email: null, contact_phone: null, image_url: null, created_at: now, updated_at: now,
    });
  }

  const guides = load('guides');
  // Stagger same-day timestamps so "newest first" keeps the order of guides.json.
  for (const [i, g] of guides.entries()) {
    await insert('posts', {
      author_id: admin._id, category_id: await catId('blog', slugify(g.section)), status: 'published',
      title: g.title, slug: g.slug, excerpt: g.excerpt, body: g.body, cta: g.cta ?? null, image_url: null, views: 0,
      published_at: new Date(`${g.date}T12:${String(59 - i).padStart(2, '0')}:00Z`), created_at: now, updated_at: now,
    });
  }

  return { content: true, adminEmail, counts: [businesses.length, events.length, guides.length] };
}

module.exports = { seed };

if (require.main === module) {
  connect()
    .then(seed)
    .then((result) => {
      console.log('Seeded plans and categories.');
      console.log(`Admin account: ${result.adminEmail}`);
      if (result.content) {
        const [b, e, g] = result.counts;
        console.log(`Loaded ${b} listings, ${e} events and ${g} guides from seed-data/.`);
      }
    })
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(close);
}
