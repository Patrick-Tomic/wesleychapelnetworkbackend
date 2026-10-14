const jwt = require('jsonwebtoken');
const { col } = require('../db');
const { HttpError, sqlDate } = require('../utils');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

function signToken(user) {
  return jwt.sign({ sub: user._id ?? user.id, role: user.role }, SECRET, { expiresIn: EXPIRES_IN });
}

// The user shape attached to req.user and returned by /api/auth/me.
const publicUser = (u) => u && {
  id: u._id, name: u.name, email: u.email, phone: u.phone ?? null,
  location: u.location ?? null, role: u.role, created_at: sqlDate(u.created_at),
};

async function loadUser(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    return null;
  }
  return publicUser(await col('users').findOne({ _id: payload.sub })) || null;
}

// Attaches req.user when a valid token is present, but never rejects.
async function optionalAuth(req, _res, next) {
  req.user = await loadUser(req);
  next();
}

async function requireAuth(req, _res, next) {
  req.user = await loadUser(req);
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  next();
}

async function requireAdmin(req, _res, next) {
  req.user = await loadUser(req);
  if (!req.user) return next(new HttpError(401, 'Authentication required'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Admin access required'));
  next();
}

const isAdmin = (user) => user && user.role === 'admin';

module.exports = { signToken, publicUser, optionalAuth, requireAuth, requireAdmin, isAdmin };
