const { col } = require('./db');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

// Returns a slug unique within `collection` (optionally ignoring the document being updated).
async function uniqueSlug(collection, text, excludeId = null) {
  const base = slugify(text);
  let slug = base;
  let n = 2;
  const taken = async (s) => col(collection).findOne(
    excludeId == null ? { slug: s } : { slug: s, _id: { $ne: excludeId } }, { projection: { _id: 1 } },
  );
  while (await taken(slug)) slug = `${base}-${n++}`;
  return slug;
}

function pagination(query) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 20, 1), 100);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  return { limit, page, offset: (page - 1) * limit };
}

function paged(items, total, { page, limit }) {
  return { data: items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

// Escapes user input for a case-insensitive "contains" match (the old SQL LIKE '%q%').
function contains(q) {
  return { $regex: String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
}

// Exact, case-insensitive match (the old COLLATE NOCASE).
function equalsIgnoreCase(v) {
  return { $regex: `^${String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' };
}

// Parses a route id like "12" into a number, or null if it isn't one.
function intId(v) {
  return /^\d+$/.test(String(v)) ? Number(v) : null;
}

// Dates go out in the formats the SQLite version used: "YYYY-MM-DD HH:MM:SS" (UTC)
// for timestamps, and ISO 8601 with a Z (no milliseconds) for event times.
const sqlDate = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) : d ?? null);
const isoDate = (d) => (d ? `${new Date(d).toISOString().slice(0, 19)}Z` : d ?? null);

// Express 5 forwards rejected promises to the error handler; kept for readability.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = {
  HttpError, slugify, uniqueSlug, pagination, paged, contains, equalsIgnoreCase, intId, sqlDate, isoDate, ah,
};
