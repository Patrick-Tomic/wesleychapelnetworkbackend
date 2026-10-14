const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { HttpError } = require('./utils');

const app = express();

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true }));
app.use(express.json({ limit: '1mb' }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// Stricter limits on endpoints that are attractive to abuse.
const strict = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
if (process.env.NODE_ENV !== 'test') {
  app.use(['/api/auth/login', '/api/auth/register', '/api/auth/forgot-password', '/api/contact'], strict);
  app.post('/api/listings/:id/messages', strict);
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/listings', require('./routes/listings'));
app.use('/api/events', require('./routes/events'));
app.use('/api/posts', require('./routes/posts'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api', require('./routes/interactions'));
app.use('/api', require('./routes/site'));

app.use((_req, _res, next) => next(new HttpError(404, 'Not found')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') err = new HttpError(400, 'Invalid JSON body');
  if (err.code === 11000) err = new HttpError(409, 'Resource already exists'); // MongoDB duplicate key
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: { message: status >= 500 ? 'Internal server error' : err.message, ...(err.details && { details: err.details }) },
  });
});

module.exports = app;
