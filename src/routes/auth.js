const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { col, insert } = require('../db');
const validate = require('../middleware/validate');
const { signToken, publicUser, requireAuth } = require('../middleware/auth');
const { HttpError } = require('../utils');
const { deleteUser } = require('../cascade');

const router = express.Router();

const byEmail = (email) => col('users').findOne({ email_lower: email.toLowerCase() });

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email(),
  password: z.string().min(8).max(200),
  phone: z.string().trim().max(30).optional(),
  location: z.string().trim().max(100).optional(),
});

router.post('/register', validate(registerSchema), async (req, res) => {
  const { name, email, password, phone, location } = req.body;
  if (await byEmail(email)) throw new HttpError(409, 'Email is already registered');
  const user = await insert('users', {
    name, email, email_lower: email.toLowerCase(), phone: phone ?? null, location: location ?? null,
    password_hash: await bcrypt.hash(password, 10), role: 'user', reset_token: null, reset_expires: null,
    created_at: new Date(),
  });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

const loginSchema = z.object({ email: z.string().trim().email(), password: z.string().min(1) });

router.post('/login', validate(loginSchema), async (req, res) => {
  const user = await byEmail(req.body.email);
  if (!user || !(await bcrypt.compare(req.body.password, user.password_hash))) {
    throw new HttpError(401, 'Invalid email or password');
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

const updateMeSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  location: z.string().trim().max(100).nullable().optional(),
  password: z.string().min(8).max(200).optional(),
  current_password: z.string().optional(),
});

router.patch('/me', requireAuth, validate(updateMeSchema), async (req, res) => {
  const row = await col('users').findOne({ _id: req.user.id });
  const { name, phone, location, password, current_password } = req.body;
  const set = {};
  if (name !== undefined) set.name = name;
  if (phone !== undefined) set.phone = phone;
  if (location !== undefined) set.location = location;
  if (password) {
    if (!current_password || !(await bcrypt.compare(current_password, row.password_hash))) {
      throw new HttpError(400, 'current_password is incorrect');
    }
    set.password_hash = await bcrypt.hash(password, 10);
  }
  await col('users').updateOne({ _id: row._id }, { $set: set });
  res.json({ user: publicUser(await col('users').findOne({ _id: row._id })) });
});

// Account/data deletion request — deletes the user and their listings, reviews and favorites.
router.delete('/me', requireAuth, async (req, res) => {
  await deleteUser(req.user.id);
  res.status(204).end();
});

router.post('/forgot-password', validate(z.object({ email: z.string().trim().email() })), async (req, res) => {
  const user = await byEmail(req.body.email);
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await col('users').updateOne({ _id: user._id },
      { $set: { reset_token: tokenHash, reset_expires: Date.now() + 60 * 60 * 1000 } });
    // TODO: send via email provider. Logged in development so the flow can be tested.
    if (process.env.NODE_ENV !== 'production') console.log(`[dev] password reset token for ${req.body.email}: ${token}`);
  }
  // Same response either way so emails can't be enumerated.
  res.json({ message: 'If that email is registered, a reset link has been sent.' });
});

const resetSchema = z.object({ token: z.string().min(1), password: z.string().min(8).max(200) });

router.post('/reset-password', validate(resetSchema), async (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(req.body.token).digest('hex');
  const user = await col('users').findOne({ reset_token: tokenHash, reset_expires: { $gt: Date.now() } });
  if (!user) throw new HttpError(400, 'Reset token is invalid or expired');
  await col('users').updateOne({ _id: user._id }, {
    $set: { password_hash: await bcrypt.hash(req.body.password, 10), reset_token: null, reset_expires: null },
  });
  res.json({ message: 'Password updated' });
});

module.exports = router;
