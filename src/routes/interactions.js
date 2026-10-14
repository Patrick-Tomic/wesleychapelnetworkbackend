// Reviews, favorites ("saved listings") and messages (contact a business / contact us).
const express = require('express');
const { z } = require('zod');
const { col, insert } = require('../db');
const validate = require('../middleware/validate');
const { optionalAuth, requireAuth, isAdmin } = require('../middleware/auth');
const { HttpError, pagination, paged, intId, sqlDate } = require('../utils');
const { findListing, canManage } = require('./listings');
const { formatListings, getPlan } = require('../listingService');

const router = express.Router();

const formatReview = (r) => r && {
  id: r._id, listing_id: r.listing_id, user_id: r.user_id, rating: r.rating, title: r.title ?? null,
  body: r.body ?? null, status: r.status, created_at: sqlDate(r.created_at),
};

const formatMessage = (m) => m && {
  id: m._id, listing_id: m.listing_id ?? null, user_id: m.user_id ?? null, name: m.name, email: m.email,
  phone: m.phone ?? null, subject: m.subject ?? null, body: m.body, is_read: m.is_read ?? 0,
  created_at: sqlDate(m.created_at),
};

async function activeListing(idOrSlug) {
  const listing = await findListing(idOrSlug);
  if (!listing || listing.status !== 'active') throw new HttpError(404, 'Listing not found');
  return listing;
}

// ---- Reviews ----

router.get('/listings/:id/reviews', async (req, res) => {
  const listing = await activeListing(req.params.id);
  const { limit, offset, page } = pagination(req.query);
  const filter = { listing_id: listing._id, status: 'approved' };
  const [total, rows] = await Promise.all([
    col('reviews').countDocuments(filter),
    col('reviews').find(filter).sort({ created_at: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
  ]);
  const users = await col('users').find({ _id: { $in: rows.map((r) => r.user_id) } }, { projection: { name: 1 } }).toArray();
  const name = new Map(users.map((u) => [u._id, u.name]));
  res.json(paged(rows.map((r) => ({
    id: r._id, rating: r.rating, title: r.title ?? null, body: r.body ?? null, created_at: sqlDate(r.created_at),
    user_id: r.user_id, user_name: name.get(r.user_id) ?? null,
  })), total, { page, limit }));
});

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(150).nullish(),
  body: z.string().trim().max(5000).nullish(),
});

// One review per user per listing; posting again updates it.
router.post('/listings/:id/reviews', requireAuth, validate(reviewSchema), async (req, res) => {
  const listing = await activeListing(req.params.id);
  if (listing.owner_id === req.user.id) throw new HttpError(403, 'You cannot review your own listing');
  if (!(await getPlan(listing.plan_id)).features.includes('reviews')) throw new HttpError(403, 'This listing does not accept reviews');
  const fields = {
    rating: req.body.rating, title: req.body.title ?? null, body: req.body.body ?? null,
    status: process.env.MODERATE_REVIEWS === 'true' ? 'pending' : 'approved', created_at: new Date(),
  };
  const key = { listing_id: listing._id, user_id: req.user.id };
  const existing = await col('reviews').findOne(key);
  if (existing) await col('reviews').updateOne({ _id: existing._id }, { $set: fields });
  else await insert('reviews', { ...key, ...fields });
  res.status(201).json({ data: formatReview(await col('reviews').findOne(key)) });
});

router.delete('/reviews/:id', requireAuth, async (req, res) => {
  const id = intId(req.params.id);
  const review = id != null && await col('reviews').findOne({ _id: id });
  if (!review) throw new HttpError(404, 'Review not found');
  if (review.user_id !== req.user.id && !isAdmin(req.user)) throw new HttpError(403, 'Not allowed');
  await col('reviews').deleteOne({ _id: id });
  res.status(204).end();
});

// ---- Favorites ----

router.get('/me/favorites', requireAuth, async (req, res) => {
  const favs = await col('favorites').find({ user_id: req.user.id }).sort({ created_at: -1 }).toArray();
  const listings = await col('listings').find({ _id: { $in: favs.map((f) => f.listing_id) }, status: 'active' }).toArray();
  const byId = new Map(listings.map((l) => [l._id, l]));
  const rows = favs.map((f) => byId.get(f.listing_id)).filter(Boolean);
  res.json({ data: await formatListings(rows, req.user, { full: false }) });
});

router.put('/listings/:id/favorite', requireAuth, async (req, res) => {
  const listing = await activeListing(req.params.id);
  await col('favorites').updateOne(
    { user_id: req.user.id, listing_id: listing._id },
    { $setOnInsert: { created_at: new Date() } },
    { upsert: true },
  );
  res.json({ data: { listing_id: listing._id, is_favorite: true } });
});

router.delete('/listings/:id/favorite', requireAuth, async (req, res) => {
  const listing = await findListing(req.params.id);
  if (!listing) throw new HttpError(404, 'Listing not found');
  await col('favorites').deleteOne({ user_id: req.user.id, listing_id: listing._id });
  res.json({ data: { listing_id: listing._id, is_favorite: false } });
});

// ---- Messages ----

const messageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email(),
  phone: z.string().trim().max(30).nullish(),
  subject: z.string().trim().max(200).nullish(),
  body: z.string().trim().min(1).max(5000),
});

function insertMessage(listingId, user, m) {
  // TODO: email notification to the business owner / site admin.
  return insert('messages', {
    listing_id: listingId, user_id: user?.id ?? null, name: m.name, email: m.email, phone: m.phone ?? null,
    subject: m.subject ?? null, body: m.body, is_read: 0, created_at: new Date(),
  });
}

// Contact a business. Works for guests; logged-in users are linked to the message.
router.post('/listings/:id/messages', optionalAuth, validate(messageSchema), async (req, res) => {
  const listing = await activeListing(req.params.id);
  await insertMessage(listing._id, req.user, req.body);
  res.status(201).json({ message: 'Your message has been sent to the business.' });
});

// Owner inbox for one listing.
router.get('/listings/:id/messages', requireAuth, async (req, res) => {
  const listing = await findListing(req.params.id);
  if (!listing) throw new HttpError(404, 'Listing not found');
  if (!canManage(req.user, listing)) throw new HttpError(403, 'You do not own this listing');
  const { limit, offset, page } = pagination(req.query);
  const filter = { listing_id: listing._id };
  const [total, rows] = await Promise.all([
    col('messages').countDocuments(filter),
    col('messages').find(filter).sort({ created_at: -1, _id: -1 }).skip(offset).limit(limit).toArray(),
  ]);
  res.json(paged(rows.map(formatMessage), total, { page, limit }));
});

router.patch('/messages/:id/read', requireAuth, async (req, res) => {
  const id = intId(req.params.id);
  const msg = id != null && await col('messages').findOne({ _id: id });
  if (!msg) throw new HttpError(404, 'Message not found');
  const listing = msg.listing_id != null && await col('listings').findOne({ _id: msg.listing_id });
  const allowed = isAdmin(req.user) || (listing && canManage(req.user, listing));
  if (!allowed) throw new HttpError(403, 'Not allowed');
  await col('messages').updateOne({ _id: id }, { $set: { is_read: 1 } });
  res.json({ data: { ...formatMessage(msg), is_read: 1 } });
});

// Site-wide "Contact Us" form.
router.post('/contact', optionalAuth, validate(messageSchema), async (req, res) => {
  await insertMessage(null, req.user, req.body);
  res.status(201).json({ message: 'Thanks for reaching out. We will get back to you soon.' });
});

module.exports = router;
module.exports.formatReview = formatReview;
module.exports.formatMessage = formatMessage;
