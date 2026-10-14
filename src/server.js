require('dotenv').config();
const app = require('./app');
const { connect, col } = require('./db');

const PORT = process.env.PORT || 4000;

// Mark paid listings past their expiry date as expired. A real deployment would
// renew these from payment-provider webhooks instead.
async function expireListings() {
  const res = await col('listings').updateMany(
    { status: 'active', expires_at: { $ne: null, $lt: new Date().toISOString() } },
    { $set: { status: 'expired' } },
  );
  if (res.modifiedCount) console.log(`Expired ${res.modifiedCount} listing(s)`);
}

connect()
  .then(async () => {
    await expireListings();
    setInterval(() => expireListings().catch(console.error), 60 * 60 * 1000).unref();
    app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error(`Could not connect to MongoDB: ${err.message}`);
    process.exit(1);
  });
