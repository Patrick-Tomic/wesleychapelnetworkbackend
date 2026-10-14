process.env.NODE_ENV = 'test';
// Fixed values so a local .env (real admin password, auto-approve flags) can't change test behavior.
Object.assign(process.env, {
  ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'changeme123',
  AUTO_APPROVE_LISTINGS: 'false',
  AUTO_APPROVE_EVENTS: 'false',
  MODERATE_REVIEWS: 'false',
  MONGODB_DB: 'wesleychapel-test',
});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startMongo } = require('./mongo');

let app;
let mongo;
let adminToken;
let userToken;
let reviewerToken;

before(async () => {
  mongo = await startMongo();
  const db = require('../src/db');
  await db.connect();
  await require('../src/seed').seed();
  app = require('../src/app');
  adminToken = (await request(app).post('/api/auth/login').send({ email: 'admin@example.com', password: 'changeme123' })).body.token;
  userToken = (await request(app).post('/api/auth/register').send({ name: 'Biz Owner', email: 'biz@test.com', password: 'password123' })).body.token;
  reviewerToken = (await request(app).post('/api/auth/register').send({ name: 'Reviewer', email: 'rev@test.com', password: 'password123' })).body.token;
});

after(async () => {
  await require('../src/db').close();
  await mongo.stop();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });

test('health and plans', async () => {
  assert.equal((await request(app).get('/api/health')).body.status, 'ok');
  const plans = (await request(app).get('/api/plans')).body.data;
  assert.deepEqual(plans.map((p) => p.slug), ['facebook-advertising', 'preferred', 'standard', 'basic']);
});

test('categories include listing counts', async () => {
  const res = await request(app).get('/api/categories?type=listing');
  // Ordered like seed-data/categories.json, with counts and the frontend's intro text.
  assert.equal(res.body.data[0].slug, 'home-services');
  assert.equal(res.body.data[0].count, 20);
  assert.ok(res.body.data[0].description.length > 0);
});

test('listing search and filters', async () => {
  let res = await request(app).get('/api/listings?limit=100');
  assert.equal(res.body.meta.total, 37);
  assert.equal(res.body.data[0].featured, true, 'featured listings rank first');
  // q matches service tags too.
  res = await request(app).get('/api/listings?q=HVAC');
  assert.ok(res.body.data.some((l) => l.slug === 'flo-rite-air-conditioning-heating'));
  res = await request(app).get('/api/listings?category=automotive');
  assert.equal(res.body.meta.total, 3);
  res = await request(app).get('/api/listings?city=lutz');
  assert.ok(res.body.data.every((l) => l.city === 'Lutz'));
});

test('geo search', async () => {
  const cats = (await request(app).get('/api/categories?type=listing')).body.data;
  const res = await request(app).post('/api/listings').set(auth(adminToken)).send({
    plan: 'basic', title: 'Geo Test', phone: '555', latitude: 28.2397, longitude: -82.3279, category_ids: [cats[0].id],
  });
  await request(app).patch(`/api/admin/listings/${res.body.data.id}`).set(auth(adminToken)).send({ status: 'active' });
  const near = await request(app).get('/api/listings?lat=28.24&lng=-82.33&radius=1&sort=distance');
  assert.equal(near.body.data[0].slug, 'geo-test');
  assert.ok(near.body.data[0].distance_miles < 1);
  await request(app).delete(`/api/listings/${res.body.data.id}`).set(auth(adminToken));
});

test('imported listing keeps tags and image', async () => {
  const res = await request(app).get('/api/listings/suncoast-auto-glass');
  assert.deepEqual(res.body.data.tags, ['Auto Glass Services']);
  assert.equal(res.body.data.image_url, '/listings/suncoast-auto-glass.png');
  assert.equal(res.body.data.categories[0].slug, 'automotive');
});

test('basic plan hides and rejects gated fields', async () => {
  const cats = (await request(app).get('/api/categories?type=listing')).body.data;
  const auto = cats.find((c) => c.slug === 'automotive').id;
  const food = cats.find((c) => c.slug === 'food-drink').id;

  let res = await request(app).post('/api/listings').set(auth(userToken))
    .send({ plan: 'basic', title: 'My Shop', phone: '555', website: 'https://x.example', category_ids: [auto] });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.error.details.fields, ['website']);

  res = await request(app).post('/api/listings').set(auth(userToken))
    .send({ plan: 'basic', title: 'My Shop', phone: '555', category_ids: [auto, food] });
  assert.equal(res.status, 400, 'basic allows only 1 category');

  res = await request(app).post('/api/listings').set(auth(userToken))
    .send({ plan: 'basic', title: 'My Shop', phone: '555', city: 'Wesley Chapel', category_ids: [auto] });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'pending');
  const id = res.body.data.id;

  // Pending listings are hidden from the public.
  assert.equal((await request(app).get(`/api/listings/${id}`)).status, 404);

  // Standard still doesn't include a website...
  res = await request(app).patch(`/api/listings/${id}`).set(auth(userToken))
    .send({ plan: 'standard', website: 'https://myshop.example' });
  assert.equal(res.status, 400);
  // ...and caps the gallery at 2 images.
  res = await request(app).patch(`/api/listings/${id}`).set(auth(userToken))
    .send({ plan: 'standard', images: ['/a.jpg', '/b.jpg', '/c.jpg'] });
  assert.equal(res.status, 400);

  // Upgrade to preferred and add a website.
  res = await request(app).patch(`/api/listings/${id}`).set(auth(userToken))
    .send({ plan: 'preferred', website: 'https://myshop.example', category_ids: [auto, food] });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.plan.slug, 'preferred');
  assert.equal(res.body.data.categories.length, 2);

  // Admin approves it.
  res = await request(app).patch(`/api/admin/listings/${id}`).set(auth(adminToken)).send({ status: 'active' });
  assert.equal(res.body.data.status, 'active');
  res = await request(app).get('/api/listings/my-shop');
  assert.equal(res.body.data.website, 'https://myshop.example');

  // Another user cannot edit it.
  res = await request(app).patch(`/api/listings/${id}`).set(auth(reviewerToken)).send({ title: 'Hijack' });
  assert.equal(res.status, 403);

  // Downgrading to basic hides gated fields publicly; stats need the analytics feature.
  await request(app).patch(`/api/listings/${id}`).set(auth(userToken)).send({ plan: 'basic', website: null, category_ids: [auto] });
  res = await request(app).get('/api/listings/my-shop');
  assert.equal(res.body.data.website, undefined);
  assert.equal(res.body.data.views, undefined, 'views are only public on analytics plans');
  res = await request(app).get(`/api/listings/${id}/stats`).set(auth(userToken));
  assert.equal(res.status, 403);
});

test('reviews, favorites and messages', async () => {
  // Reviews are a Preferred feature; a Basic listing doesn't accept them.
  const basic = (await request(app).get('/api/listings/audi-wesley-chapel')).body.data;
  assert.equal(basic.reviews_enabled, false);
  assert.equal((await request(app).post('/api/listings/audi-wesley-chapel/reviews').set(auth(reviewerToken)).send({ rating: 5 })).status, 403);

  let res = await request(app).post('/api/listings/pulse-salon-spa/reviews').set(auth(reviewerToken)).send({ rating: 4, body: 'Lovely' });
  assert.equal(res.status, 201);
  res = await request(app).get('/api/listings/pulse-salon-spa');
  assert.deepEqual(res.body.data.rating, { average: 4, count: 1 });

  res = await request(app).put('/api/listings/pulse-salon-spa/favorite').set(auth(reviewerToken));
  assert.equal(res.body.data.is_favorite, true);
  res = await request(app).get('/api/me/favorites').set(auth(reviewerToken));
  assert.equal(res.body.data[0].slug, 'pulse-salon-spa');

  res = await request(app).post('/api/listings/pulse-salon-spa/messages').send({ name: 'Guest', email: 'g@test.com', body: 'Do you take walk-ins?' });
  assert.equal(res.status, 201);
  const owner = adminToken; // imported listings are site-managed
  res = await request(app).get('/api/listings/pulse-salon-spa/messages').set(auth(owner));
  assert.equal(res.body.meta.total, 1);
  res = await request(app).get('/api/listings/pulse-salon-spa/stats').set(auth(owner));
  assert.equal(res.body.data.favorites, 1);
});

test('events: user submissions need approval', async () => {
  let res = await request(app).get('/api/events?when=all');
  assert.equal(res.body.meta.total, 3);
  const fest = res.body.data.find((e) => e.slug === 'avalon-park-fall-fest-2026');
  assert.equal(fest.starts_at, '2026-10-17T14:00:00Z', '10 AM Eastern');
  assert.equal(fest.organizer, 'Avalon Park Wesley Chapel');
  assert.ok(fest.tags.includes('Food trucks'));
  const starts = new Date(Date.now() + 7 * 864e5).toISOString();
  res = await request(app).post('/api/events').set(auth(userToken)).send({ title: 'Yard Sale', starts_at: starts });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.status, 'pending');
  await request(app).patch(`/api/admin/events/${res.body.data.id}`).set(auth(adminToken)).send({ status: 'active' });
  res = await request(app).get('/api/events?when=all');
  assert.equal(res.body.meta.total, 4);
});

test('blog posts and home/search aggregates', async () => {
  let res = await request(app).get('/api/posts');
  assert.equal(res.body.data[0].slug, 'plan-a-weekend-around-wesley-chapel');
  res = await request(app).get('/api/posts/plan-a-weekend-around-wesley-chapel');
  assert.equal(res.body.data.body[0].type, 'p', 'structured body blocks');
  assert.equal(res.body.data.cta.href, '/events');
  assert.equal(res.body.data.category.name, 'Things to Do');
  res = await request(app).post('/api/posts').set(auth(userToken)).send({ title: 'Nope' });
  assert.equal(res.status, 403);
  res = await request(app).get('/api/home');
  assert.ok(res.body.data.featured_listings.length > 0);
  assert.ok(res.body.data.upcoming_events.length > 0);
  res = await request(app).get('/api/search?q=pulse');
  assert.equal(res.body.data.listings[0].slug, 'pulse-salon-spa');
});

test('auth errors', async () => {
  assert.equal((await request(app).get('/api/auth/me')).status, 401);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'admin@example.com', password: 'wrong' })).status, 401);
  assert.equal((await request(app).post('/api/auth/register').send({ name: 'X', email: 'biz@test.com', password: 'password123' })).status, 409);
});

test('image uploads', async () => {
  const sharp = require('sharp');
  const jpeg = await sharp({ create: { width: 3200, height: 1800, channels: 3, background: '#20388f' } }).jpeg().toBuffer();

  // Only admins can upload, and only images.
  let res = await request(app).post('/api/uploads').set(auth(userToken)).attach('file', jpeg, 'photo.jpg');
  assert.equal(res.status, 403);
  res = await request(app).post('/api/uploads').set(auth(adminToken))
    .attach('file', Buffer.from('not an image'), { filename: 'fake.jpg', contentType: 'image/jpeg' });
  assert.equal(res.status, 400);

  // Uploads are resized to fit 2000px and stored as WebP.
  res = await request(app).post('/api/uploads').set(auth(adminToken)).attach('file', jpeg, 'photo.jpg');
  assert.equal(res.status, 201);
  const { id, url, width, height } = res.body.data;
  assert.equal(url, `/uploads/${id}.webp`);
  assert.deepEqual([width, height], [2000, 1125]);

  // Anyone can view it, and it caches.
  res = await request(app).get(`/api/uploads/${id}.webp`);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'image/webp');
  assert.match(res.headers['cache-control'], /immutable/);
  assert.equal(res.body.subarray(8, 12).toString(), 'WEBP');

  // Listings, events and posts accept the uploaded path.
  const pulse = (await request(app).get('/api/listings/pulse-salon-spa')).body.data;
  res = await request(app).patch(`/api/listings/${pulse.id}`).set(auth(adminToken)).send({ image_url: url, images: [url] });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.image_url, url);
  res = await request(app).post('/api/events').set(auth(adminToken))
    .send({ title: 'Photo Walk', starts_at: new Date(Date.now() + 864e5).toISOString(), image_url: url });
  assert.equal(res.body.data.image_url, url);

  assert.equal((await request(app).get('/api/uploads').set(auth(adminToken))).body.meta.total, 1);
  assert.equal((await request(app).delete(`/api/uploads/${id}`).set(auth(adminToken))).status, 204);
  assert.equal((await request(app).get(`/api/uploads/${id}.webp`)).status, 404);
  assert.equal((await request(app).get('/api/uploads/not-an-id.webp')).status, 404);
});
