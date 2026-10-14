const express = require('express');
const { z } = require('zod');
const { col, insert } = require('../db');
const validate = require('../middleware/validate');
const { optionalAuth, requireAuth, isAdmin } = require('../middleware/auth');
const { HttpError, uniqueSlug, pagination, paged, contains, equalsIgnoreCase, intId, sqlDate } = require('../utils');
const {
  LISTING_FIELDS, getPlan, disallowedFields, limitError, formatListings, formatOne, checkCategories, distanceMi,
} = require('../listingService');
const { deleteListing } = require('../cascade');
const { formatPlan } = require('./plans');

const router = express.Router();

const byId = (a, b) => a._id - b._id;
const time = (d) => (d ? new Date(d).getTime() : 0);
const nullsLast = (a, b) => (a == null) - (b == null);

const SORTS = {
  // Default: featured first, then higher plans, then newest.
  relevance: (a, b) => (+b.featured - +a.featured) || (b.rank - a.rank) || (time(b.created_at) - time(a.created_at)) || byId(a, b),
  newest: (a, b) => (time(b.created_at) - time(a.created_at)) || byId(b, a),
  name: (a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || byId(a, b),
  rating: (a, b) => nullsLast(a.rating_avg, b.rating_avg) || ((b.rating_avg ?? 0) - (a.rating_avg ?? 0))
    || (b.rating_count - a.rating_count) || byId(a, b),
  popular: (a, b) => ((b.views ?? 0) - (a.views ?? 0)) || byId(a, b),
  distance: (a, b) => nullsLast(a.distance, b.distance) || ((a.distance ?? 0) - (b.distance ?? 0)) || byId(a, b),
};

/**
 * GET /api/listings
 *   q          text search (title, summary, description, city, tags)
 *   category   category slug (includes child categories)
 *   city, zip  exact match (city is case-insensitive)
 *   featured   "true" to only return featured
 *   lat,lng,radius  location search in miles (default radius 25)
 *   min_rating 1-5
 *   sort       relevance | newest | name | rating | popular | distance
 *   page, limit
 */
router.get('/', optionalAuth, async (req, res) => {
  const { q, category, city, zip, featured, lat, lng, radius, min_rating } = req.query;
  const filter = { status: 'active' };

  if (q) {
    const m = contains(q);
    filter.$or = [{ title: m }, { summary: m }, { description: m }, { city: m }, { tags: m }];
  }
  if (category) {
    const cat = await col('categories').findOne({ type: 'listing', slug: category });
    const children = cat ? await col('categories').find({ parent_id: cat._id }).toArray() : [];
    filter.category_ids = { $in: cat ? [cat._id, ...children.map((c) => c._id)] : [] };
  }
  if (city) filter.city = equalsIgnoreCase(city);
  if (zip) filter.zip = String(zip);
  if (featured === 'true') filter.featured = true;

  const rows = await col('listings').find(filter).toArray();
  const ids = rows.map((r) => r._id);
  const [plans, ratings] = await Promise.all([
    col('plans').find().toArray(),
    col('reviews').aggregate([
      { $match: { listing_id: { $in: ids }, status: 'approved' } },
      { $group: { _id: '$listing_id', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]).toArray(),
  ]);
  const rank = new Map(plans.map((p) => [p._id, p.rank]));
  const rating = new Map(ratings.map((r) => [r._id, r]));

  const hasGeo = lat != null && lng != null && !Number.isNaN(+lat) && !Number.isNaN(+lng);
  let items = rows.map((r) => ({
    ...r,
    rank: rank.get(r.plan_id) ?? 0,
    rating_avg: rating.get(r._id)?.avg ?? null,
    rating_count: rating.get(r._id)?.count ?? 0,
    distance: hasGeo ? distanceMi(+lat, +lng, r.latitude, r.longitude) : null,
  }));
  if (hasGeo) items = items.filter((r) => r.distance != null && r.distance <= (+radius || 25));
  if (min_rating) items = items.filter((r) => r.rating_avg != null && r.rating_avg >= +min_rating);

  let sort = SORTS[req.query.sort] ? req.query.sort : 'relevance';
  if (sort === 'distance' && !hasGeo) sort = 'relevance';
  items.sort(SORTS[sort]);

  const { limit, offset, page } = pagination(req.query);
  const pageRows = items.slice(offset, offset + limit);
  const out = await formatListings(pageRows, req.user, { full: false });
  if (hasGeo) {
    out.forEach((o, i) => {
      const d = pageRows[i].distance;
      o.distance_miles = d == null ? null : Math.round(d * 10) / 10;
    });
  }
  res.json(paged(out, items.length, { page, limit }));
});

// GET /api/listings/mine — listings owned by the current user, any status.
router.get('/mine', requireAuth, async (req, res) => {
  const rows = await col('listings').find({ owner_id: req.user.id }).sort({ created_at: -1, _id: -1 }).toArray();
  res.json({ data: await formatListings(rows, req.user) });
});

function findListing(idOrSlug) {
  const id = intId(idOrSlug);
  return col('listings').findOne(id != null ? { _id: id } : { slug: String(idOrSlug) });
}

function canManage(user, listing) {
  return user && (isAdmin(user) || user.id === listing.owner_id);
}

// Events that haven't ended yet: ends_at in the future, or no end and a future start.
const upcoming = (now = new Date()) => ({
  $or: [{ ends_at: { $gte: now } }, { ends_at: null, starts_at: { $gte: now } }],
});

// GET /api/listings/:idOrSlug — public detail page. Non-active listings are visible only to owner/admin.
router.get('/:idOrSlug', optionalAuth, async (req, res) => {
  const listing = await findListing(req.params.idOrSlug);
  if (!listing || (listing.status !== 'active' && !canManage(req.user, listing))) {
    throw new HttpError(404, 'Listing not found');
  }
  if (!canManage(req.user, listing)) {
    await col('listings').updateOne({ _id: listing._id }, { $inc: { views: 1 } });
    listing.views = (listing.views ?? 0) + 1;
  }
  const events = await col('events')
    .find({ listing_id: listing._id, status: 'active', ...upcoming() })
    .sort({ starts_at: 1 }).limit(10).toArray();
  res.json({
    data: {
      ...(await formatOne(listing, req.user)),
      upcoming_events: events.map((e) => ({
        id: e._id, title: e.title, slug: e.slug, starts_at: sqlDate(e.starts_at), ends_at: sqlDate(e.ends_at),
        venue: e.venue ?? null, image_url: e.image_url ?? null,
      })),
    },
  });
});

const url = z.string().trim().url().max(500);
// Images may be absolute URLs or site-relative paths like "/listings/photo.jpg".
const imageRef = z.string().trim().max(500)
  .refine((s) => s.startsWith('/') || URL.canParse(s), 'Must be a URL or a path starting with /');
const listingSchema = z.object({
  plan: z.string().trim().min(1).default('basic'),          // plan slug
  billing_cycle: z.enum(['monthly', 'yearly']).default('monthly'),
  title: z.string().trim().min(1).max(150),
  summary: z.string().trim().max(300).nullish(),
  description: z.string().max(10000).nullish(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email().nullish(),
  website: url.nullish(),
  address: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(100).nullish(),
  state: z.string().trim().max(50).nullish(),
  zip: z.string().trim().max(15).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  social_links: z.record(z.string(), url).nullish(),
  facebook_feed: url.nullish(),
  hours: z.record(z.string(), z.string().max(100)).nullish(),
  logo_url: imageRef.nullish(),
  image_url: imageRef.nullish(),
  images: z.array(imageRef).max(20).nullish(),
  category_ids: z.array(z.number().int()).default([]),
});

const COLUMNS = ['title', 'summary', 'description', 'tags', 'phone', 'email', 'website', 'address', 'city', 'state', 'zip',
  'latitude', 'longitude', 'social_links', 'facebook_feed', 'hours', 'logo_url', 'image_url', 'images'];

const toDoc = (data) => Object.fromEntries(COLUMNS.filter((c) => c in data).map((c) => [c, data[c] ?? null]));

async function resolvePlan(slug) {
  const plan = await col('plans').findOne({ slug, is_listing_plan: true });
  if (!plan) throw new HttpError(400, `Unknown listing plan "${slug}"`);
  return formatPlan(plan);
}

function assertAllowed(plan, data) {
  const bad = disallowedFields(plan, data);
  if (bad.length) {
    throw new HttpError(400, `The ${plan.name} plan does not include: ${bad.join(', ')}. Upgrade your plan to use these fields.`, { fields: bad });
  }
  const limit = limitError(plan, data);
  if (limit) throw new HttpError(400, limit);
}

// POST /api/listings — create a listing (status "pending" until approved, unless AUTO_APPROVE_LISTINGS=true).
router.post('/', requireAuth, validate(listingSchema), async (req, res) => {
  const plan = await resolvePlan(req.body.plan);
  assertAllowed(plan, req.body);
  const categoryIds = await checkCategories(plan, req.body.category_ids);
  const expires = new Date();
  expires.setMonth(expires.getMonth() + (req.body.billing_cycle === 'yearly' ? 12 : 1));
  const now = new Date();

  const listing = await insert('listings', {
    ...Object.fromEntries(LISTING_FIELDS.map((f) => [f, null])),
    ...toDoc(req.body),
    owner_id: req.user.id,
    plan_id: plan.id,
    billing_cycle: req.body.billing_cycle,
    status: process.env.AUTO_APPROVE_LISTINGS === 'true' ? 'active' : 'pending',
    featured: false,
    slug: await uniqueSlug('listings', req.body.title),
    views: 0,
    expires_at: expires.toISOString(),
    created_at: now,
    updated_at: now,
    category_ids: categoryIds,
  });
  // TODO: hook up a payment provider (e.g. Stripe Checkout) here and activate on payment webhook.
  res.status(201).json({ data: await formatOne(listing, req.user) });
});

// PATCH /api/listings/:id — owner or admin. Changing "plan" re-validates all fields/categories.
router.patch('/:id', requireAuth, validate(listingSchema.partial().extend({
  plan: z.string().trim().min(1).optional(),
  billing_cycle: z.enum(['monthly', 'yearly']).optional(),
  category_ids: z.array(z.number().int()).optional(),
})), async (req, res) => {
  const listing = await findListing(req.params.id);
  if (!listing) throw new HttpError(404, 'Listing not found');
  if (!canManage(req.user, listing)) throw new HttpError(403, 'You do not own this listing');

  const plan = req.body.plan ? await resolvePlan(req.body.plan) : await getPlan(listing.plan_id);
  // Validate the merged result so a downgrade can't keep now-disallowed fields.
  assertAllowed(plan, { ...listing, ...req.body });
  const categoryIds = await checkCategories(plan, req.body.category_ids ?? listing.category_ids ?? []);

  const set = { ...toDoc(req.body), plan_id: plan.id, category_ids: categoryIds, updated_at: new Date() };
  if (req.body.title && req.body.title !== listing.title) set.slug = await uniqueSlug('listings', req.body.title, listing._id);
  if (req.body.billing_cycle) set.billing_cycle = req.body.billing_cycle;
  await col('listings').updateOne({ _id: listing._id }, { $set: set });

  res.json({ data: await formatOne(await col('listings').findOne({ _id: listing._id }), req.user) });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const listing = await findListing(req.params.id);
  if (!listing) throw new HttpError(404, 'Listing not found');
  if (!canManage(req.user, listing)) throw new HttpError(403, 'You do not own this listing');
  await deleteListing(listing._id);
  res.status(204).end();
});

// GET /api/listings/:id/stats — analytics for owners whose plan includes it.
router.get('/:id/stats', requireAuth, async (req, res) => {
  const listing = await findListing(req.params.id);
  if (!listing) throw new HttpError(404, 'Listing not found');
  if (!canManage(req.user, listing)) throw new HttpError(403, 'You do not own this listing');
  const plan = await getPlan(listing.plan_id);
  if (!plan.features.includes('analytics') && !isAdmin(req.user)) {
    throw new HttpError(403, `Analytics are not included in the ${plan.name} plan`);
  }
  const id = listing._id;
  const [favorites, messages, unread, reviews] = await Promise.all([
    col('favorites').countDocuments({ listing_id: id }),
    col('messages').countDocuments({ listing_id: id }),
    col('messages').countDocuments({ listing_id: id, is_read: 0 }),
    col('reviews').aggregate([
      { $match: { listing_id: id, status: 'approved' } },
      { $group: { _id: null, n: { $sum: 1 }, avg: { $avg: '$rating' } } },
    ]).toArray(),
  ]);
  res.json({
    data: {
      views: listing.views ?? 0,
      favorites,
      messages,
      unread_messages: unread,
      reviews: { n: reviews[0]?.n ?? 0, avg: reviews[0] ? Math.round(reviews[0].avg * 100) / 100 : null },
    },
  });
});

module.exports = router;
module.exports.findListing = findListing;
module.exports.canManage = canManage;
module.exports.upcoming = upcoming;
