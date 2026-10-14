// Starts a throwaway MongoDB for tests and points MONGODB_URI at it.
//
// MongoDB 5+ needs a CPU with AVX. On machines without it this falls back to 4.4,
// which needs OpenSSL 1.1; if `.mongo-test-libs/` holds libssl.so.1.1 and
// libcrypto.so.1.1 it is added to the library path for the test server only.
const fs = require('fs');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

function hasAvx() {
  try { return /\bavx\b/.test(fs.readFileSync('/proc/cpuinfo', 'utf8')); } catch { return true; }
}

async function startMongo() {
  if (process.env.MONGODB_TEST_URI) {
    process.env.MONGODB_URI = process.env.MONGODB_TEST_URI;
    return { stop: async () => {} };
  }
  const libs = path.join(__dirname, '..', '.mongo-test-libs');
  if (fs.existsSync(libs)) process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  const server = await MongoMemoryServer.create(hasAvx() ? {} : { binary: { version: '4.4.29' } });
  process.env.MONGODB_URI = server.getUri('wesleychapel-test');
  return server;
}

module.exports = { startMongo };
