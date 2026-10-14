const express = require('express');
const { z } = require('zod');
const { col, insert } = require('../db');
const validate = require('../middleware/validate');
const { optionalAuth, requireAuth, isAdmin } = require('../middleware/auth');
const { HttpError, uniqueSlug, pagination, paged, contains, equalsIgnoreCase, intId, sqlDate, isoDate } = require('../utils');

const router = express.Router();

// Every event document has these fields (null when unset), in API order.
const EVENT_FIELDS = ['owner_id', 'listing_id', 'category_id', 'status', 'featured', 'title', 'slug', 'summary',
  'description', 'starts_at', 'ends_at', 'venue', 'organizer', 'tags', 'address', 'city', 'state', 'zip', 'website',
  'contact_email', 'contact_phone', 'image_url', 'created_at', 'updated_at'];

// Shapes events for the API, with their category and linked listing. Times are stored
// as Dates (UTC); the API returns ISO 8601 with a Z.
async function formatEvents(rows) {
  const catIds = [...new Set(rows.map((e) => e.category_id).filter((v) => v != null))];
  const listingIds = [...new Set(rows.map((e) => e.listing_id).filter((v) => v != null))];
  const [cats, listings] = await Promise.all([
    col('categories').find({ _id: { $in: catIds } }).toArray(),
    col('listings').find({ _id: { $in: listingIds } }, { projection: { title: 1, slug: 1 } }).toArray(),
  ]);
  const catMap = new Map(cats.map((c) => [c._id, c]));
  const listingMap = new Map(listings.map((l) => [l._id, l]));
  return rows.map((e) => {
    const c = catMap.get(e.category_id);
    const l = listingMap.get(e.listing_id);
    return {
      id: e._id,
      ...Object.fromEntries(EVENT_FIELDS.map((f) => [f, e[f] ?? null])),
      starts_at: isoDate(e.starts_at),
      ends_at: isoDate(e.ends_at),
      tags: e.tags ?? [],
      featured: !!e.featured,
      created_at: sqlDate(e.created_at),
      updated_at: sqlDate(e.updated_at),
      category: c ? { id: c._id, name: c.name, slug: c.slug } : null,
      listing: l ? { id: l._id, title: l.title, slug: l.slug } : null,
    };
  });
}

const formatEvent = async (e) => (e ? (await formatEvents([e]))[0] : null);

// Events that haven't ended yet: ends_at in the future, or no end and a future start.
const upcoming = (now = new Date()) => ({ $or: [{ ends_at: { $gte: now } }, { ends_at: null, starts_at: { $gte: now } }] });
const past = (now = new Date()) => ({ $or: [{ ends_at: { $lt: now } }, { ends_at: null, starts_at: { $lt: now } }] });

function dateParam(name, v) {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `${name} must be an ISO date`);
  return d;
}

/**
 * GET /api/events
 *   when      upcoming (default) | past | all
 *   from, to  ISO dates to bound starts_at
 *   category  event category slug
 *   q, city, featured, page, limit
 */
router.get('/', async (req, res) => {
  const { when = 'upcoming', from, to, category, q, city, featured } = req.query;
  const and = [{ status: 'active' }];
  if (when === 'upcoming') and.push(upcoming());
  if (when === 'past') and.push(past());
  if (from || to) {
    and.push({ starts_at: { ...(from && { $gte: dateParam('from', from) }), ...(to && { $lte: dateParam('to', to) }) } });
  }
  if (category) {
    const cat = await col('categories').findOne({ type: 'event', slug: category });
    and.push({ category_id: cat ? cat._id : -1 });
  }
  if (city) and.push({ city: equalsIgnoreCase(city) });
  if (featured === 'true') and.push({ featured: true });
  if (q) {
    const m = contains(q);
    and.push({ $or: [{ title: m }, { summary: m }, { description: m }, { venue: m }] });
  }
  const filter = { $and: and };
  const { limit, offset, page } = pagination(req.query);
  const sort = when === 'past' ? { starts_at: -1, _id: 1 } : { featured: -1, starts_at: 1, _id: 1 };
  const [total, rows] = await Promise.all([
    col('events').countDocuments(filter),
    col('events').find(filter).sort(sort).skip(offset).limit(limit).toArray(),
  ]);
  res.json(paged(await formatEvents(rows), total, { page, limit }));
});

router.get('/mine', requireAuth, async (req, res) => {
  const rows = await col('events').find({ owner_id: req.user.id }).sort({ starts_at: -1 }).toArray();
  res.json({ data: await formatEvents(rows) });
});

function findEvent(idOrSlug) {
  const id = intId(idOrSlug);
  return col('events').findOne(id != null ? { _id: id } : { slug: String(idOrSlug) });
}

const canManage = (user, e) => user && (isAdmin(user) || user.id === e.owner_id);

router.get('/:idOrSlug', optionalAuth, async (req, res) => {
  const event = await findEvent(req.params.idOrSlug);
  if (!event || (event.status !== 'active' && !canManage(req.user, event))) throw new HttpError(404, 'Event not found');
  res.json({ data: await formatEvent(event) });
});

const datetime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Must be an ISO date/time');
const eventSchema = z.object({
  title: z.string().trim().min(1).max(150),
  summary: z.string().trim().max(300).nullish(),
  description: z.string().max(10000).nullish(),
  starts_at: datetime,
  ends_at: datetime.nullish(),
  venue: z.string().trim().max(150).nullish(),
  organizer: z.string().trim().max(150).nullish(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).nullish(),
  address: z.string().trim().max(200).nullish(),
  city: z.string().trim().max(100).nullish(),
  state: z.string().trim().max(50).nullish(),
  zip: z.string().trim().max(15).nullish(),
  website: z.string().trim().url().nullish(),
  contact_email: z.string().trim().email().nullish(),
  contact_phone: z.string().trim().max(30).nullish(),
  // An uploaded image (/uploads/...) or a full URL.
  image_url: z.string().trim().max(500).refine((s) => s.startsWith('/') || URL.canParse(s), 'Must be a URL or a path starting with /').nullish(),
  category_id: z.number().int().nullish(),
  listing_id: z.number().int().nullish(),
});

const COLUMNS = Object.keys(eventSchema.shape);

// Request body → document fields, with times as Dates.
function toDoc(body) {
  const doc = Object.fromEntries(COLUMNS.filter((c) => c in body).map((c) => [c, body[c] ?? null]));
  if ('starts_at' in doc) doc.starts_at = doc.starts_at ? new Date(doc.starts_at) : null;
  if ('ends_at' in doc) doc.ends_at = doc.ends_at ? new Date(doc.ends_at) : null;
  return doc;
}

async function checkRefs(user, body) {
  if (body.category_id != null && !(await col('categories').findOne({ _id: body.category_id, type: 'event' }))) {
    throw new HttpError(400, 'category_id is not a valid event category');
  }
  if (body.listing_id != null) {
    const l = await col('listings').findOne({ _id: body.listing_id }, { projection: { owner_id: 1 } });
    if (!l) throw new HttpError(400, 'listing_id not found');
    if (l.owner_id !== user.id && !isAdmin(user)) throw new HttpError(403, 'You can only attach events to your own listings');
  }
  if (body.starts_at && body.ends_at && Date.parse(body.ends_at) < Date.parse(body.starts_at)) {
    throw new HttpError(400, 'ends_at must be after starts_at');
  }
}

router.post('/', requireAuth, validate(eventSchema), async (req, res) => {
  await checkRefs(req.user, req.body);
  const now = new Date();
  const event = await insert('events', {
    ...Object.fromEntries(EVENT_FIELDS.map((f) => [f, null])),
    ...toDoc(req.body),
    owner_id: req.user.id,
    // Admin-created events go live immediately; user submissions await approval.
    status: isAdmin(req.user) || process.env.AUTO_APPROVE_EVENTS === 'true' ? 'active' : 'pending',
    featured: false,
    slug: await uniqueSlug('events', req.body.title),
    tags: req.body.tags ?? [],
    created_at: now,
    updated_at: now,
  });
  res.status(201).json({ data: await formatEvent(event) });
});

router.patch('/:id', requireAuth, validate(eventSchema.partial()), async (req, res) => {
  const event = await findEvent(req.params.id);
  if (!event) throw new HttpError(404, 'Event not found');
  if (!canManage(req.user, event)) throw new HttpError(403, 'Not allowed');
  await checkRefs(req.user, { starts_at: isoDate(event.starts_at), ends_at: isoDate(event.ends_at), ...req.body });
  const set = { ...toDoc(req.body), updated_at: new Date() };
  if (req.body.title && req.body.title !== event.title) set.slug = await uniqueSlug('events', req.body.title, event._id);
  await col('events').updateOne({ _id: event._id }, { $set: set });
  res.json({ data: await formatEvent(await col('events').findOne({ _id: event._id })) });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const event = await findEvent(req.params.id);
  if (!event) throw new HttpError(404, 'Event not found');
  if (!canManage(req.user, event)) throw new HttpError(403, 'Not allowed');
  await col('events').deleteOne({ _id: event._id });
  res.status(204).end();
});

module.exports = router;
module.exports.formatEvents = formatEvents;
module.exports.upcoming = upcoming;
