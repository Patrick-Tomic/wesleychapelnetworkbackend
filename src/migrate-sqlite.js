// One-time import of the old SQLite database into MongoDB, keeping every id,
// password hash and timestamp.
//
// Usage: npm run migrate:sqlite [-- path/to/app.db] [-- --replace]
//   Defaults to data/app.db. Refuses to run if MongoDB already has data,
//   unless --replace is passed, which DELETES the existing MongoDB data first.
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { connect, close, col, bumpCounter } = require('./db');

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const file = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'data', 'app.db'));

const COLLECTIONS = ['users', 'plans', 'categories', 'listings', 'reviews', 'favorites', 'events', 'posts', 'messages'];

const json = (v, fallback = null) => {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
};
// SQLite stored UTC as "YYYY-MM-DD HH:MM:SS" (or ISO); both become Dates.
const date = (v) => (v ? new Date(/[TZ]/.test(v) ? v : `${v.replace(' ', 'T')}Z`) : null);

async function main() {
  if (!fs.existsSync(file)) throw new Error(`SQLite database not found: ${file}`);
  const Database = require('better-sqlite3');
  const sqlite = new Database(file, { readonly: true });
  const all = (sql) => sqlite.prepare(sql).all();

  await connect();
  const existing = (await Promise.all(COLLECTIONS.map((c) => col(c).countDocuments()))).reduce((a, b) => a + b, 0);
  if (existing && !replace) {
    throw new Error(`MongoDB already has ${existing} documents. Re-run with --replace to delete them and import, or point MONGODB_URI at an empty database.`);
  }
  if (replace) await Promise.all([...COLLECTIONS, 'counters'].map((c) => col(c).deleteMany({})));

  const listingCats = new Map();
  for (const { listing_id, category_id } of all('SELECT * FROM listing_categories')) {
    listingCats.set(listing_id, [...(listingCats.get(listing_id) ?? []), category_id]);
  }

  const docs = {
    users: all('SELECT * FROM users').map(({ id, ...u }) => ({
      _id: id, ...u, email_lower: u.email.toLowerCase(), created_at: date(u.created_at),
    })),
    plans: all('SELECT * FROM plans').map(({ id, ...p }) => ({
      _id: id, ...p, features: json(p.features, []), is_listing_plan: !!p.is_listing_plan,
    })),
    categories: all('SELECT * FROM categories').map(({ id, ...c }) => ({ _id: id, ...c })),
    listings: all('SELECT * FROM listings').map(({ id, ...l }) => ({
      _id: id, ...l, featured: !!l.featured, tags: json(l.tags, []), social_links: json(l.social_links),
      hours: json(l.hours), images: json(l.images, []), created_at: date(l.created_at), updated_at: date(l.updated_at),
      category_ids: listingCats.get(id) ?? [],
    })),
    reviews: all('SELECT * FROM reviews').map(({ id, ...r }) => ({ _id: id, ...r, created_at: date(r.created_at) })),
    favorites: all('SELECT * FROM favorites').map((f) => ({ ...f, created_at: date(f.created_at) })),
    events: all('SELECT * FROM events').map(({ id, ...e }) => ({
      _id: id, ...e, featured: !!e.featured, tags: json(e.tags, []), starts_at: date(e.starts_at),
      ends_at: date(e.ends_at), created_at: date(e.created_at), updated_at: date(e.updated_at),
    })),
    posts: all('SELECT * FROM posts').map(({ id, ...p }) => ({
      _id: id, ...p, body: json(p.body, p.body), cta: json(p.cta), published_at: date(p.published_at),
      created_at: date(p.created_at), updated_at: date(p.updated_at),
    })),
    messages: all('SELECT * FROM messages').map(({ id, ...m }) => ({ _id: id, ...m, created_at: date(m.created_at) })),
  };

  for (const [name, rows] of Object.entries(docs)) {
    if (rows.length) await col(name).insertMany(rows);
    const max = rows.reduce((m, r) => (typeof r._id === 'number' && r._id > m ? r._id : m), 0);
    if (max) await bumpCounter(name, max);
    console.log(`${name}: ${rows.length}`);
  }
  sqlite.close();
  console.log(`Imported ${file} into MongoDB.`);
}

main()
  .catch((err) => { console.error(err.message); process.exitCode = 1; })
  .finally(close);
