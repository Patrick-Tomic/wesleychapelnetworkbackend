// Blog posts (Business Spotlights, Local Guides, Things to Do, ...). Admins write; everyone reads.
const express = require('express');
const { z } = require('zod');
const { col, insert } = require('../db');
const validate = require('../middleware/validate');
const { optionalAuth, requireAdmin, isAdmin } = require('../middleware/auth');
const { HttpError, uniqueSlug, pagination, paged, contains, intId, sqlDate } = require('../utils');

const router = express.Router();

const POST_FIELDS = ['author_id', 'category_id', 'status', 'title', 'slug', 'excerpt', 'body', 'cta', 'image_url',
  'views', 'published_at', 'created_at', 'updated_at'];

// body is stored as-is: plain text or structured blocks
// ({type: "p"|"h"|"list"|"places", ...}) that the frontend renders.
async function formatPosts(rows, full = true) {
  const catIds = [...new Set(rows.map((p) => p.category_id).filter((v) => v != null))];
  const authorIds = [...new Set(rows.map((p) => p.author_id).filter((v) => v != null))];
  const [cats, authors] = await Promise.all([
    col('categories').find({ _id: { $in: catIds } }).toArray(),
    col('users').find({ _id: { $in: authorIds } }, { projection: { name: 1 } }).toArray(),
  ]);
  const catMap = new Map(cats.map((c) => [c._id, c]));
  const authorMap = new Map(authors.map((u) => [u._id, u]));
  return rows.map((p) => {
    const c = catMap.get(p.category_id);
    const a = authorMap.get(p.author_id);
    return {
      id: p._id,
      ...Object.fromEntries(POST_FIELDS.map((f) => [f, p[f] ?? null])),
      body: full ? (p.body ?? null) : undefined,
      views: p.views ?? 0,
      published_at: sqlDate(p.published_at),
      created_at: sqlDate(p.created_at),
      updated_at: sqlDate(p.updated_at),
      category: p.category_id != null ? { id: p.category_id, name: c?.name ?? null, slug: c?.slug ?? null } : null,
      author: p.author_id != null ? { id: p.author_id, name: a?.name ?? null } : null,
    };
  });
}

const formatPost = async (p) => (p ? (await formatPosts([p]))[0] : null);
// Newest first by publish date, falling back to creation date for drafts.
const NEWEST = [{ $addFields: { _sort: { $ifNull: ['$published_at', '$created_at'] } } }, { $sort: { _sort: -1, _id: -1 } }];

// GET /api/posts?category=local-guides&q=...&page=1   (admins may pass status=draft|all)
router.get('/', optionalAuth, async (req, res) => {
  const filter = {};
  const status = isAdmin(req.user) ? (req.query.status || 'published') : 'published';
  if (status !== 'all') filter.status = status;
  if (req.query.category) {
    const cat = await col('categories').findOne({ type: 'blog', slug: req.query.category });
    filter.category_id = cat ? cat._id : -1;
  }
  if (req.query.q) {
    const m = contains(req.query.q);
    // Block bodies are matched on any string inside them.
    filter.$or = [{ title: m }, { excerpt: m }, { body: m }, { 'body.text': m }, { 'body.items': m },
      { 'body.items.name': m }, { 'body.items.text': m }];
  }
  const { limit, offset, page } = pagination(req.query);
  const [total, rows] = await Promise.all([
    col('posts').countDocuments(filter),
    col('posts').aggregate([{ $match: filter }, ...NEWEST, { $skip: offset }, { $limit: limit }, { $project: { _sort: 0 } }]).toArray(),
  ]);
  res.json(paged(await formatPosts(rows, false), total, { page, limit }));
});

router.get('/popular', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 20);
  const rows = await col('posts').find({ status: 'published' }).sort({ views: -1, _id: 1 }).limit(limit).toArray();
  res.json({ data: await formatPosts(rows, false) });
});

function findPost(idOrSlug) {
  const id = intId(idOrSlug);
  return col('posts').findOne(id != null ? { _id: id } : { slug: String(idOrSlug) });
}

router.get('/:idOrSlug', optionalAuth, async (req, res) => {
  const post = await findPost(req.params.idOrSlug);
  if (!post || (post.status !== 'published' && !isAdmin(req.user))) throw new HttpError(404, 'Post not found');
  // Admins opening a post to edit it don't count as readers.
  if (post.status === 'published' && !isAdmin(req.user)) await col('posts').updateOne({ _id: post._id }, { $inc: { views: 1 } });
  res.json({ data: await formatPost(post) });
});

const postSchema = z.object({
  title: z.string().trim().min(1).max(200),
  excerpt: z.string().trim().max(500).nullish(),
  body: z.union([z.string().max(100000), z.array(z.record(z.string(), z.unknown())).max(500)]).nullish(),
  cta: z.object({ label: z.string().trim().min(1).max(100), href: z.string().trim().min(1).max(500) }).nullish(),
  // An uploaded image (/uploads/...) or a full URL.
  image_url: z.string().trim().max(500).refine((s) => s.startsWith('/') || URL.canParse(s), 'Must be a URL or a path starting with /').nullish(),
  category_id: z.number().int().nullish(),
  status: z.enum(['draft', 'published']).default('draft'),
});

async function checkCategory(id) {
  if (id != null && !(await col('categories').findOne({ _id: id, type: 'blog' }))) {
    throw new HttpError(400, 'category_id is not a valid blog category');
  }
}

router.post('/', requireAdmin, validate(postSchema), async (req, res) => {
  const p = req.body;
  await checkCategory(p.category_id);
  const now = new Date();
  const post = await insert('posts', {
    author_id: req.user.id,
    category_id: p.category_id ?? null,
    status: p.status,
    title: p.title,
    slug: await uniqueSlug('posts', p.title),
    excerpt: p.excerpt ?? null,
    body: p.body ?? null,
    cta: p.cta ?? null,
    image_url: p.image_url ?? null,
    views: 0,
    published_at: p.status === 'published' ? now : null,
    created_at: now,
    updated_at: now,
  });
  res.status(201).json({ data: await formatPost(post) });
});

router.patch('/:id', requireAdmin, validate(postSchema.partial().extend({ status: z.enum(['draft', 'published']).optional() })), async (req, res) => {
  const post = await findPost(req.params.id);
  if (!post) throw new HttpError(404, 'Post not found');
  await checkCategory(req.body.category_id);
  const fields = ['category_id', 'status', 'title', 'excerpt', 'body', 'cta', 'image_url'];
  const set = Object.fromEntries(fields.filter((f) => f in req.body).map((f) => [f, req.body[f] ?? null]));
  if (req.body.title && req.body.title !== post.title) set.slug = await uniqueSlug('posts', req.body.title, post._id);
  // Publishing keeps the original publish date if the post was published before.
  if ((set.status ?? post.status) === 'published' && !post.published_at) set.published_at = new Date();
  set.updated_at = new Date();
  await col('posts').updateOne({ _id: post._id }, { $set: set });
  res.json({ data: await formatPost(await col('posts').findOne({ _id: post._id })) });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = intId(req.params.id);
  const result = id != null ? await col('posts').deleteOne({ _id: id }) : { deletedCount: 0 };
  if (!result.deletedCount) throw new HttpError(404, 'Post not found');
  res.status(204).end();
});

module.exports = router;
