// Aggregate endpoints for the homepage and the global search box.
const express = require('express');
const { col } = require('../db');
const { optionalAuth } = require('../middleware/auth');
const { HttpError, contains, sqlDate } = require('../utils');
const { formatListings } = require('../listingService');
const { upcoming } = require('./events');

const router = express.Router();

const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};

// GET /api/home — everything the homepage needs in one call.
router.get('/home', optionalAuth, async (req, res) => {
  const [active, plans, categories, events, posts] = await Promise.all([
    col('listings').find({ status: 'active' }).toArray(),
    col('plans').find().toArray(),
    col('categories').find({ type: 'listing' }).toArray(),
    col('events').find({ status: 'active', ...upcoming() }).sort({ featured: -1, starts_at: 1 }).limit(6).toArray(),
    col('posts').find({ status: 'published' }).sort({ published_at: -1 }).limit(4).toArray(),
  ]);
  // Featured first, then higher plans, random within each group.
  const rank = new Map(plans.map((p) => [p._id, p.rank]));
  const featured = shuffle(active)
    .sort((a, b) => (+!!b.featured - +!!a.featured) || ((rank.get(b.plan_id) ?? 0) - (rank.get(a.plan_id) ?? 0)))
    .slice(0, 8);
  const count = new Map();
  for (const l of active) for (const id of l.category_ids ?? []) count.set(id, (count.get(id) ?? 0) + 1);
  categories.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name));
  res.json({
    data: {
      featured_listings: await formatListings(featured, req.user, { full: false }),
      categories: categories.map((c) => ({ id: c._id, name: c.name, slug: c.slug, count: count.get(c._id) ?? 0 })),
      upcoming_events: events.map((e) => ({
        id: e._id, title: e.title, slug: e.slug, summary: e.summary ?? null, starts_at: sqlDate(e.starts_at),
        ends_at: sqlDate(e.ends_at), venue: e.venue ?? null, city: e.city ?? null, image_url: e.image_url ?? null,
      })),
      recent_posts: posts.map((p) => ({
        id: p._id, title: p.title, slug: p.slug, excerpt: p.excerpt ?? null, image_url: p.image_url ?? null,
        published_at: sqlDate(p.published_at),
      })),
    },
  });
});

// GET /api/search?q=plumber — quick search across listings, events and posts.
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) throw new HttpError(400, 'q must be at least 2 characters');
  const m = contains(q);
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
  const [listings, categories, events, posts] = await Promise.all([
    col('listings').find({ status: 'active', $or: [{ title: m }, { summary: m }, { description: m }] }).limit(limit).toArray(),
    col('categories').find({ type: 'listing', name: m }).limit(limit).toArray(),
    col('events').find({ status: 'active', $and: [upcoming(), { $or: [{ title: m }, { description: m }] }] })
      .sort({ starts_at: 1 }).limit(limit).toArray(),
    col('posts').find({ status: 'published', $or: [{ title: m }, { body: m }, { 'body.text': m }, { 'body.items': m }] })
      .sort({ published_at: -1 }).limit(limit).toArray(),
  ]);
  res.json({
    data: {
      listings: listings.map((l) => ({ id: l._id, title: l.title, slug: l.slug, summary: l.summary ?? null, city: l.city ?? null })),
      categories: categories.map((c) => ({ id: c._id, name: c.name, slug: c.slug })),
      events: events.map((e) => ({ id: e._id, title: e.title, slug: e.slug, starts_at: sqlDate(e.starts_at) })),
      posts: posts.map((p) => ({ id: p._id, title: p.title, slug: p.slug, excerpt: p.excerpt ?? null })),
    },
  });
});

module.exports = router;
