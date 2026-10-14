const express = require('express');
const { z } = require('zod');
const { col, insert } = require('../db');
const validate = require('../middleware/validate');
const { requireAdmin } = require('../middleware/auth');
const { HttpError, intId } = require('../utils');

const router = express.Router();

const FIELDS = ['slug', 'name', 'description', 'price_monthly', 'price_yearly', 'max_categories', 'features',
  'max_images', 'rank', 'is_listing_plan'];

const format = (p) => p && {
  id: p._id,
  ...Object.fromEntries(FIELDS.map((f) => [f, p[f] ?? null])),
  features: p.features ?? [],
  is_listing_plan: !!p.is_listing_plan,
};

router.get('/', async (_req, res) => {
  const plans = await col('plans').find().sort({ rank: -1 }).toArray();
  res.json({ data: plans.map(format) });
});

router.get('/:slug', async (req, res) => {
  const plan = await col('plans').findOne({ slug: req.params.slug });
  if (!plan) throw new HttpError(404, 'Plan not found');
  res.json({ data: format(plan) });
});

const planSchema = z.object({
  slug: z.string().trim().min(1).max(50),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).nullable().optional(),
  price_monthly: z.number().nonnegative(),
  price_yearly: z.number().nonnegative(),
  max_categories: z.number().int().min(0).max(50),
  max_images: z.number().int().min(0).max(100).default(0),
  features: z.array(z.string()).default([]),
  rank: z.number().int().default(0),
  is_listing_plan: z.boolean().default(true),
});

router.post('/', requireAdmin, validate(planSchema), async (req, res) => {
  const plan = await insert('plans', { ...req.body, description: req.body.description ?? null });
  res.status(201).json({ data: format(plan) });
});

router.patch('/:id', requireAdmin, validate(planSchema.partial()), async (req, res) => {
  const id = intId(req.params.id);
  const plan = id != null && await col('plans').findOne({ _id: id });
  if (!plan) throw new HttpError(404, 'Plan not found');
  await col('plans').updateOne({ _id: id }, { $set: req.body });
  res.json({ data: format(await col('plans').findOne({ _id: id })) });
});

module.exports = router;
module.exports.formatPlan = format;
