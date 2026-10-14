# Local Directory API

REST backend for a community business directory: listings, categories, paid listing plans, events, blog, reviews, saved listings, contact messages and admin moderation.

Stack: Node 20+, Express 5, MongoDB (official driver), JWT auth, zod validation.

## Setup

```bash
npm install
cp .env.example .env      # set MONGODB_URI, JWT_SECRET and ADMIN_PASSWORD
npm run seed              # plans, categories, admin user, and the directory content in seed-data/
npm run dev               # http://localhost:4000
npm test                  # runs against a throwaway in-memory MongoDB
```

`MONGODB_URI` is your MongoDB connection string, for example from MongoDB Atlas. The database
name comes from the URI path, or from `MONGODB_DB`, and defaults to `wesleychapel`.

### Moving from the old SQLite database

The API used to store data in SQLite at `data/app.db`. To copy that data into MongoDB, keeping
every id, password hash and timestamp:

```bash
npm run migrate:sqlite                 # reads data/app.db
npm run migrate:sqlite -- other.db     # or a specific file
```

It refuses to run if MongoDB already has data. Pass `-- --replace` to **delete** the MongoDB data
first and import again. Run either the migration or `npm run seed` on a new database, not both.

### Data model notes

- Documents use integer `_id`s from a `counters` collection, so the API keeps returning numeric
  `id`s. Listing categories are stored on the listing as `category_ids`.
- MongoDB has no foreign keys, so deletes that used to cascade are done in `src/cascade.js`.
- Listing search, sorting and paging run in Node over the matching documents. That's fine for
  thousands of listings; past that, move sorting into an aggregation pipeline.

### Running tests without AVX

MongoDB 5+ needs a CPU with AVX. Without it, the tests use MongoDB 4.4, which needs OpenSSL 1.1.
Put `libssl.so.1.1` and `libcrypto.so.1.1` in `.mongo-test-libs/` (gitignored); the test helper
adds them to the library path for the test server only. Or set `MONGODB_TEST_URI` to a disposable
database to skip the in-memory server.

## How listing plans work

Each plan has a `features` list, a `max_categories` cap and a `max_images` cap. These match the plans described on the frontend's advertise page:

| Plan | Monthly / Yearly | Categories | Photos | Unlocks |
|---|---|---|---|---|
| Basic | $9.99 / $99 | 1 | 0 | phone, email |
| Standard | $29.99 / $299 | 2 | 2 | + logo/cover image, description |
| Preferred | $49.99 / $499 | 4 | 6 | + website, hours, reviews, social links, Facebook feed, analytics |
| Facebook Advertising | $199 / $1,999 | 8 | 20 | everything in Preferred, plus Facebook group ads |

- The API rejects a create or update that sets a field the plan doesn't include. It returns `400` with `details.fields`.
- If an owner downgrades, public responses hide fields the new plan doesn't include.
- New listings start as `pending`. An admin approves them, or you can set `AUTO_APPROVE_LISTINGS=true`.
- `expires_at` is set from the billing cycle. A job marks listings past that date as `expired` at startup and then every hour.

## Frontend

The Next.js site in `../local-network` reads from this API on the server, through `src/lib/api.ts`. It expects the API at `http://localhost:4000/api`, or at the `API_URL` environment variable if set. Keep the API running for `next dev` and `next build`.

## Endpoints

Auth: send `Authorization: Bearer <token>`. 🔒 = needs a logged-in user, 👑 = admin only.

**Auth**: `/api/auth`
- `POST /register` `{name, email, password, phone?, location?}`
- `POST /login`
- `GET /me` 🔒
- `PATCH /me` 🔒
- `DELETE /me` 🔒: deletes the account and its data
- `POST /forgot-password`
- `POST /reset-password` `{token, password}`

**Plans**
- `GET /api/plans`
- `GET /api/plans/:slug`
- `POST /api/plans` 👑
- `PATCH /api/plans/:id` 👑

**Categories**
- `GET /api/categories?type=listing|event|blog`: includes item counts
- `GET /api/categories/:type/:slug`
- `POST /api/categories` 👑
- `PATCH /api/categories/:id` 👑
- `DELETE /api/categories/:id` 👑

**Listings**
- `GET /api/listings`: query params `q`, `category`, `city`, `zip`, `featured`, `lat`, `lng`, `radius` (miles), `min_rating`, `sort` (`relevance|newest|name|rating|popular|distance`), `page`, `limit`
- `GET /api/listings/mine` 🔒
- `GET /api/listings/:idOrSlug`: includes upcoming events and counts a view
- `POST /api/listings` 🔒 `{plan, billing_cycle, title, ..., category_ids}`
- `PATCH /api/listings/:id` 🔒 owner
- `DELETE /api/listings/:id` 🔒 owner
- `GET /api/listings/:id/stats` 🔒 owner, Preferred plan only

**Reviews, favorites, messages**
- `GET /api/listings/:id/reviews`
- `POST /api/listings/:id/reviews` 🔒 `{rating, title?, body?}`: one per user, and posting again updates it
- `DELETE /api/reviews/:id` 🔒
- `PUT /api/listings/:id/favorite` 🔒
- `DELETE /api/listings/:id/favorite` 🔒
- `GET /api/me/favorites` 🔒
- `POST /api/listings/:id/messages`: contact the business, guests allowed
- `GET /api/listings/:id/messages` 🔒 owner inbox
- `PATCH /api/messages/:id/read` 🔒
- `POST /api/contact`: site "Contact Us" form

**Events**
- `GET /api/events`: query params `when=upcoming|past|all`, `from`, `to`, `category`, `q`, `city`, `featured`
- `GET /api/events/mine` 🔒
- `GET /api/events/:idOrSlug`
- `POST /api/events` 🔒: user submissions start as `pending`
- `PATCH /api/events/:id` 🔒
- `DELETE /api/events/:id` 🔒

**Blog**
- `GET /api/posts?category=&q=`
- `GET /api/posts/popular`
- `GET /api/posts/:idOrSlug`
- `POST /api/posts` 👑
- `PATCH /api/posts/:id` 👑
- `DELETE /api/posts/:id` 👑

**Site**
- `GET /api/home`: featured listings, categories, upcoming events and recent posts in one call
- `GET /api/search?q=`: searches listings, categories, events and posts

**Admin** 👑: `/api/admin`
- `GET /stats`
- `GET /listings?status=`
- `PATCH /listings/:id` `{status, featured, expires_at}`
- `GET /events`
- `PATCH /events/:id`
- `GET /reviews?status=pending`
- `PATCH /reviews/:id`
- `GET /users`
- `PATCH /users/:id` `{role}`
- `DELETE /users/:id`
- `GET /messages`

Errors always have the shape `{ "error": { "message": "...", "details"?: ... } }`.

## Not built yet (marked `TODO` in code)

- **Payments**: listings activate when an admin approves them. Add Stripe Checkout and a webhook in `POST /api/listings` to activate and renew listings on payment.
- **Email**: password-reset tokens are printed to the console in development, and contact messages are stored but no one is notified.
- **Google/Facebook login**: add an OAuth flow, such as passport or a hosted auth provider, that issues the same JWT.
- **Image uploads**: listings take image URLs. Add uploads to S3 or Cloudinary and save the returned URLs.
# wesleychapelnetworkbackend
