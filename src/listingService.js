// Shared listing helpers: plan feature gating and response formatting.
const { col } = require('./db');
const { HttpError, sqlDate } = require('./utils');
const { formatPlan } = require('./routes/plans');

// Listing fields that require a plan feature of the same name. Fields not listed
// here (title, summary, address, city, ...) are available on every plan.
const GATED_FIELDS = {
  phone: 'phone',
  email: 'email',
  website: 'website',
  description: 'description',
  social_links: 'social_links',
  facebook_feed: 'facebook_feed',
  hours: 'hours',
  logo_url: 'logo',
  image_url: 'logo',
  images: 'images',
};

// Every listing document has these fields (null when unset), in API order.
const LISTING_FIELDS = ['owner_id', 'plan_id', 'billing_cycle', 'status', 'featured', 'title', 'slug', 'summary',
  'description', 'tags', 'phone', 'email', 'website', 'address', 'city', 'state', 'zip', 'latitude', 'longitude',
  'social_links', 'facebook_feed', 'hours', 'logo_url', 'image_url', 'images', 'views', 'expires_at', 'created_at',
  'updated_at'];

async function getPlan(id) {
  return formatPlan(await col('plans').findOne({ _id: id }));
}

const isEmpty = (v) => v == null || v === ''
  || (Array.isArray(v) && v.length === 0)
  || (typeof v === 'object' && Object.keys(v).length === 0);

// Returns the list of fields in `data` that the plan does not allow.
function disallowedFields(plan, data) {
  return Object.entries(GATED_FIELDS)
    .filter(([field, feature]) => !isEmpty(data[field]) && !plan.features.includes(feature))
    .map(([field]) => field);
}

// Returns an error message if `data` breaks a numeric plan limit, else null.
function limitError(plan, data) {
  if (Array.isArray(data.images) && data.images.length > plan.max_images) {
    return `The ${plan.name} plan allows at most ${plan.max_images} gallery images`;
  }
  return null;
}

// Loads what formatting needs for a batch of listings in a few queries.
async function listingContext(rows, viewer) {
  const ids = rows.map((r) => r._id);
  const catIds = [...new Set(rows.flatMap((r) => r.category_ids ?? []))];
  const [plans, cats, ratings, favs] = await Promise.all([
    col('plans').find().toArray(),
    col('categories').find({ _id: { $in: catIds } }).toArray(),
    col('reviews').aggregate([
      { $match: { listing_id: { $in: ids }, status: 'approved' } },
      { $group: { _id: '$listing_id', avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]).toArray(),
    viewer ? col('favorites').find({ user_id: viewer.id, listing_id: { $in: ids } }).toArray() : [],
  ]);
  return {
    viewer,
    plans: new Map(plans.map((p) => [p._id, formatPlan(p)])),
    cats: new Map(cats.map((c) => [c._id, { id: c._id, name: c.name, slug: c.slug }])),
    ratings: new Map(ratings.map((r) => [r._id, r])),
    favs: new Set(favs.map((f) => f.listing_id)),
  };
}

// Shapes a listing document for the API. Gated fields are hidden if the current plan no
// longer includes them (e.g. after a downgrade), unless the viewer is the owner/admin.
function formatListing(row, ctx, { full = true } = {}) {
  if (!row) return null;
  const { viewer } = ctx;
  const plan = ctx.plans.get(row.plan_id);
  const out = { id: row._id, ...Object.fromEntries(LISTING_FIELDS.map((f) => [f, row[f] ?? null])) };
  out.tags = row.tags ?? [];
  out.images = row.images ?? [];
  out.featured = !!row.featured;
  out.views = row.views ?? 0;
  out.created_at = sqlDate(row.created_at);
  out.updated_at = sqlDate(row.updated_at);
  const privileged = viewer && (viewer.role === 'admin' || viewer.id === row.owner_id);
  if (!privileged) {
    for (const [field, feature] of Object.entries(GATED_FIELDS)) {
      if (!plan.features.includes(feature)) delete out[field];
    }
    delete out.billing_cycle;
    delete out.expires_at;
    if (!plan.features.includes('analytics')) delete out.views;
  }
  out.plan = { id: plan.id, slug: plan.slug, name: plan.name };
  out.categories = (row.category_ids ?? [])
    .map((id) => ctx.cats.get(id)).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  out.reviews_enabled = plan.features.includes('reviews');
  const r = ctx.ratings.get(row._id);
  const rating = { average: r ? Math.round(r.avg * 100) / 100 : null, count: r ? r.count : 0 };
  out.rating = out.reviews_enabled || privileged ? rating : null;
  if (viewer) out.is_favorite = ctx.favs.has(row._id);
  if (!full) delete out.description;
  return out;
}

async function formatListings(rows, viewer, opts) {
  const ctx = await listingContext(rows, viewer);
  return rows.map((r) => formatListing(r, ctx, opts));
}

async function formatOne(row, viewer, opts) {
  return row ? (await formatListings([row], viewer, opts))[0] : null;
}

// Validates a listing's categories against the plan's cap and returns the cleaned id list.
async function checkCategories(plan, categoryIds) {
  const ids = [...new Set(categoryIds)];
  if (ids.length > plan.max_categories) {
    throw new HttpError(400, `The ${plan.name} plan allows at most ${plan.max_categories} categor${plan.max_categories === 1 ? 'y' : 'ies'}`);
  }
  if (ids.length) {
    const found = await col('categories').countDocuments({ type: 'listing', _id: { $in: ids } });
    if (found !== ids.length) throw new HttpError(400, 'One or more category_ids are invalid listing categories');
  }
  return ids;
}

// Great-circle distance in miles, for "near me" searches.
function distanceMi(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null)) return null;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

module.exports = {
  GATED_FIELDS, LISTING_FIELDS, getPlan, disallowedFields, limitError, formatListings, formatOne, checkCategories,
  distanceMi,
};
