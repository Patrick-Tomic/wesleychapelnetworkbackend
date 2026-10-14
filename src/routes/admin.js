// Admin moderation: approve listings/events/reviews, feature content, manage users, read site messages.
const express = require('express');
const { z } = require('zod');
const { col } = require('../db');
const validate = require('../middleware/validate');
const { requireAdmin } = require('../middleware/auth');
const { HttpError, pagination, paged, contains, intId, sqlDate } = require('../utils');
const { formatListings, formatOne } = require('../listingService');
const { formatEvents, upcoming } = require('./events');
const { formatMessage, formatReview } = require('./interactions');
const { deleteUser } = require('../cascade');

const router = express.Router();
router.use(requireAdmin);

router.get('/stats', async (_req, res) => {
  const count = (name, filter = {}) => col(name).countDocuments(filter);
  const [users, active, pending, upcomingEvents, pendingEvents, reviewsPending, unread, plans, byPlan] = await Promise.all([
    count('users'),
    count('listings', { status: 'active' }),
    count('listings', { status: 'pending' }),
    count('events', { status: 'active', starts_at: { $gte: new Date() } }),
    count('events', { status: 'pending' }),
    count('reviews', { status: 'pending' }),
    count('messages', { listing_id: null, is_read: 0 }),
    col('plans').find().sort({ rank: -1 }).toArray(),
    col('listings').aggregate([{ $match: { status: 'active' } }, { $group: { _id: '$plan_id', n: { $sum: 1 } } }]).toArray(),
  ]);
  const n = new Map(byPlan.map((r) => [r._id, r.n]));
  res.json({
    data: {
      users,
      listings: { active, pending },
      events: { upcoming: upcomingEvents, pending: pendingEvents },
      reviews_pending: reviewsPending,
      unread_contact_messages: unread,
      listings_by_plan: plans.map((p) => ({ slug: p.slug, name: p.name, count: n.get(p._id) ?? 0 })),
    },
  });
});

// GET /api/admin/listings?status=pending&q=
router.get('/listings', async (req, res) => {
  const { limit, offset, page } = pagination(req.query);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.q) filter.title = contains(req.query.q);
  const [total, rows] = await Promise.all([
    col('listings').countDocuments(filter),
    col('listings').find(filter).sort({ created_at: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
  ]);
  res.json(paged(await formatListings(rows, req.user), total, { page, limit }));
});

const listingAdminSchema = z.object({
  status: z.enum(['pending', 'active', 'suspended', 'expired']).optional(),
  featured: z.boolean().optional(),
  expires_at: z.string().nullable().optional(),
});

router.patch('/listings/:id', validate(listingAdminSchema), async (req, res) => {
  const id = intId(req.params.id);
  const listing = id != null && await col('listings').findOne({ _id: id });
  if (!listing) throw new HttpError(404, 'Listing not found');
  await col('listings').updateOne({ _id: id }, { $set: { ...req.body, updated_at: new Date() } });
  res.json({ data: await formatOne(await col('listings').findOne({ _id: id }), req.user) });
});

// GET /api/admin/events?status=pending&when=upcoming|past — every event, any status.
router.get('/events', async (req, res) => {
  const { limit, offset, page } = pagination(req.query);
  const and = [];
  if (req.query.status) and.push({ status: req.query.status });
  if (req.query.when === 'upcoming') and.push(upcoming());
  if (req.query.q) and.push({ title: contains(req.query.q) });
  const filter = and.length ? { $and: and } : {};
  const [total, rows] = await Promise.all([
    col('events').countDocuments(filter),
    col('events').find(filter).sort({ starts_at: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
  ]);
  res.json(paged(await formatEvents(rows), total, { page, limit }));
});

router.patch('/events/:id', validate(z.object({
  status: z.enum(['pending', 'active', 'cancelled']).optional(),
  featured: z.boolean().optional(),
})), async (req, res) => {
  const id = intId(req.params.id);
  const event = id != null && await col('events').findOne({ _id: id });
  if (!event) throw new HttpError(404, 'Event not found');
  await col('events').updateOne({ _id: id }, { $set: { ...req.body, updated_at: new Date() } });
  res.json({ data: (await formatEvents([await col('events').findOne({ _id: id })]))[0] });
});

router.get('/reviews', async (req, res) => {
  const status = req.query.status || 'pending';
  const rows = await col('reviews').find({ status }).sort({ created_at: -1 }).limit(200).toArray();
  const [listings, users] = await Promise.all([
    col('listings').find({ _id: { $in: rows.map((r) => r.listing_id) } }, { projection: { title: 1 } }).toArray(),
    col('users').find({ _id: { $in: rows.map((r) => r.user_id) } }, { projection: { name: 1 } }).toArray(),
  ]);
  const title = new Map(listings.map((l) => [l._id, l.title]));
  const name = new Map(users.map((u) => [u._id, u.name]));
  res.json({
    data: rows.map((r) => ({ ...formatReview(r), listing_title: title.get(r.listing_id), user_name: name.get(r.user_id) })),
  });
});

router.patch('/reviews/:id', validate(z.object({ status: z.enum(['pending', 'approved', 'rejected']) })), async (req, res) => {
  const id = intId(req.params.id);
  const result = id != null ? await col('reviews').updateOne({ _id: id }, { $set: { status: req.body.status } }) : null;
  if (!result?.matchedCount) throw new HttpError(404, 'Review not found');
  res.json({ data: formatReview(await col('reviews').findOne({ _id: id })) });
});

router.get('/users', async (req, res) => {
  const { limit, offset, page } = pagination(req.query);
  const filter = req.query.q ? { $or: [{ name: contains(req.query.q) }, { email: contains(req.query.q) }] } : {};
  const [total, rows] = await Promise.all([
    col('users').countDocuments(filter),
    col('users').find(filter).sort({ created_at: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
  ]);
  const owned = await col('listings').aggregate([
    { $match: { owner_id: { $in: rows.map((u) => u._id) } } },
    { $group: { _id: '$owner_id', n: { $sum: 1 } } },
  ]).toArray();
  const n = new Map(owned.map((r) => [r._id, r.n]));
  res.json(paged(rows.map((u) => ({
    id: u._id, name: u.name, email: u.email, phone: u.phone ?? null, location: u.location ?? null, role: u.role,
    created_at: sqlDate(u.created_at), listing_count: n.get(u._id) ?? 0,
  })), total, { page, limit }));
});

router.patch('/users/:id', validate(z.object({ role: z.enum(['user', 'admin']) })), async (req, res) => {
  const id = intId(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'You cannot change your own role');
  const result = id != null ? await col('users').updateOne({ _id: id }, { $set: { role: req.body.role } }) : null;
  if (!result?.matchedCount) throw new HttpError(404, 'User not found');
  const u = await col('users').findOne({ _id: id });
  res.json({ data: { id: u._id, name: u.name, email: u.email, role: u.role } });
});

router.delete('/users/:id', async (req, res) => {
  const id = intId(req.params.id);
  if (id === req.user.id) throw new HttpError(400, 'Use DELETE /api/auth/me to delete your own account');
  if (id == null || !(await deleteUser(id))) throw new HttpError(404, 'User not found');
  res.status(204).end();
});

// Site "Contact Us" inbox.
router.get('/messages', async (req, res) => {
  const { limit, offset, page } = pagination(req.query);
  const filter = { listing_id: null };
  if (req.query.unread === 'true') filter.is_read = 0;
  const [total, rows] = await Promise.all([
    col('messages').countDocuments(filter),
    col('messages').find(filter).sort({ created_at: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
  ]);
  res.json(paged(rows.map(formatMessage), total, { page, limit }));
});

module.exports = router;
