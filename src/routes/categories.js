const express = require('express');
const { z } = require('zod');
const { col, insert } = require('../db');
const validate = require('../middleware/validate');
const { requireAdmin } = require('../middleware/auth');
const { HttpError, slugify, intId } = require('../utils');
const { deleteCategory } = require('../cascade');

const router = express.Router();

const TYPES = ['listing', 'event', 'blog'];

const format = (c) => c && {
  id: c._id, type: c.type, name: c.name, slug: c.slug, description: c.description ?? null,
  parent_id: c.parent_id ?? null, position: c.position ?? 0,
};

// Number of published items in each category, depending on the category type.
async function counts(type, ids) {
  const [collection, match] = {
    listing: ['listings', { status: 'active' }],
    event: ['events', { status: 'active' }],
    blog: ['posts', { status: 'published' }],
  }[type];
  const field = type === 'listing' ? 'category_ids' : 'category_id';
  const rows = await col(collection).aggregate([
    { $match: { ...match, [field]: { $in: ids } } },
    ...(type === 'listing' ? [{ $unwind: '$category_ids' }, { $match: { category_ids: { $in: ids } } }] : []),
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
  ]).toArray();
  return new Map(rows.map((r) => [r._id, r.n]));
}

const sortCategories = (a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name);

// GET /api/categories?type=listing
router.get('/', async (req, res) => {
  const type = req.query.type || 'listing';
  if (!TYPES.includes(type)) throw new HttpError(400, `type must be one of ${TYPES.join(', ')}`);
  const rows = (await col('categories').find({ type }).toArray()).sort(sortCategories);
  const n = await counts(type, rows.map((c) => c._id));
  res.json({ data: rows.map((c) => ({ ...format(c), count: n.get(c._id) ?? 0 })) });
});

router.get('/:type/:slug', async (req, res) => {
  const { type, slug } = req.params;
  if (!TYPES.includes(type)) throw new HttpError(404, 'Category not found');
  const row = await col('categories').findOne({ type, slug });
  if (!row) throw new HttpError(404, 'Category not found');
  const n = await counts(type, [row._id]);
  const children = await col('categories').find({ parent_id: row._id }).sort({ name: 1 }).toArray();
  res.json({ data: { ...format(row), count: n.get(row._id) ?? 0, children: children.map(format) } });
});

const schema = z.object({
  type: z.enum(TYPES),
  name: z.string().trim().min(1).max(100),
  slug: z.string().trim().max(100).optional(),
  description: z.string().max(1000).nullable().optional(),
  parent_id: z.number().int().nullable().optional(),
  position: z.number().int().optional(),
});

router.post('/', requireAdmin, validate(schema), async (req, res) => {
  const c = req.body;
  const slug = c.slug ? slugify(c.slug) : slugify(c.name);
  if (await col('categories').findOne({ type: c.type, slug })) {
    throw new HttpError(409, 'Category slug already exists for this type');
  }
  const cat = await insert('categories', {
    type: c.type, name: c.name, slug, description: c.description ?? null, parent_id: c.parent_id ?? null,
    position: c.position ?? 0,
  });
  res.status(201).json({ data: format(cat) });
});

router.patch('/:id', requireAdmin, validate(schema.partial()), async (req, res) => {
  const id = intId(req.params.id);
  const cat = id != null && await col('categories').findOne({ _id: id });
  if (!cat) throw new HttpError(404, 'Category not found');
  const set = { ...req.body };
  if (req.body.slug) set.slug = slugify(req.body.slug);
  await col('categories').updateOne({ _id: id }, { $set: set });
  res.json({ data: format(await col('categories').findOne({ _id: id })) });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const id = intId(req.params.id);
  if (id == null || !(await deleteCategory(id))) throw new HttpError(404, 'Category not found');
  res.status(204).end();
});

module.exports = router;
