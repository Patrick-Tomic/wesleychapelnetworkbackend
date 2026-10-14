// MongoDB connection and collection helpers.
//
// Documents use small integer `_id`s (from the `counters` collection) instead of
// ObjectIds, so the API keeps returning numeric `id`s and existing clients and
// URLs like /api/listings/12 keep working.
const { MongoClient } = require('mongodb');

let client = null;
let db = null;

// Database name from MONGODB_DB, else the path in the URI, else "wesleychapel".
function dbNameFrom(uri) {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/);
  return process.env.MONGODB_DB || (m && decodeURIComponent(m[1])) || 'wesleychapel';
}

async function connect(uri = process.env.MONGODB_URI) {
  if (db) return db;
  if (!uri) throw new Error('MONGODB_URI is not set. Add your MongoDB connection string to .env.');
  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbNameFrom(uri));
  await ensureIndexes();
  return db;
}

async function close() {
  if (client) await client.close();
  client = null;
  db = null;
}

function getDb() {
  if (!db) throw new Error('Database not connected. Call connect() first.');
  return db;
}

function col(name) {
  if (!db) throw new Error('Database not connected. Call connect() first.');
  return db.collection(name);
}

async function ensureIndexes() {
  await Promise.all([
    col('users').createIndex({ email_lower: 1 }, { unique: true }),
    col('plans').createIndex({ slug: 1 }, { unique: true }),
    col('categories').createIndex({ type: 1, slug: 1 }, { unique: true }),
    col('listings').createIndex({ slug: 1 }, { unique: true }),
    col('listings').createIndex({ status: 1 }),
    col('listings').createIndex({ owner_id: 1 }),
    col('listings').createIndex({ category_ids: 1 }),
    col('reviews').createIndex({ listing_id: 1, user_id: 1 }, { unique: true }),
    col('favorites').createIndex({ user_id: 1, listing_id: 1 }, { unique: true }),
    col('events').createIndex({ slug: 1 }, { unique: true }),
    col('events').createIndex({ starts_at: 1 }),
    col('posts').createIndex({ slug: 1 }, { unique: true }),
    col('messages').createIndex({ listing_id: 1 }),
  ]);
}

// Next integer id for a collection.
async function nextId(name) {
  const res = await col('counters').findOneAndUpdate(
    { _id: name }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' },
  );
  return res.seq;
}

// Makes sure the counter is at least `id` (used when importing rows with fixed ids).
async function bumpCounter(name, id) {
  await col('counters').updateOne({ _id: name }, { $max: { seq: id } }, { upsert: true });
}

// Inserts a document with the next integer id and returns it.
async function insert(name, doc) {
  const full = { _id: await nextId(name), ...doc };
  await col(name).insertOne(full);
  return full;
}

// `{ _id, ...rest }` → `{ id, ...rest }` for API responses.
function withId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

module.exports = { connect, close, getDb, col, nextId, bumpCounter, insert, withId };
