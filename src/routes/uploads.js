// Image uploads for listings, events and blog posts, stored in MongoDB (GridFS bucket "uploads").
// Admins upload; anyone can view. Every image is re-encoded, so what's stored is always a
// clean WebP no larger than MAX_SIDE pixels, with camera metadata (including GPS) stripped.
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { GridFSBucket, ObjectId } = require('mongodb');
const { getDb, col } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { HttpError, pagination, paged } = require('../utils');

const router = express.Router();

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 2000;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, TYPES.includes(file.mimetype)),
});

const bucket = () => new GridFSBucket(getDb(), { bucketName: 'uploads' });
const urlFor = (id) => `/uploads/${id}.webp`;

const format = (f) => ({
  id: String(f._id),
  url: urlFor(f._id),
  width: f.metadata?.width ?? null,
  height: f.metadata?.height ?? null,
  size: f.length,
  name: f.metadata?.original_name ?? null,
  created_at: f.uploadDate,
});

// Accepts "<id>" or "<id>.webp".
function parseId(param) {
  const id = String(param).replace(/\.webp$/, '');
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : null;
}

// POST /api/uploads  (multipart, field "file") — admin only.
router.post('/', requireAdmin, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'Images can be up to 10 MB'));
    if (err) return next(new HttpError(400, err.message));
    next();
  });
}, async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a JPEG, PNG, WebP, GIF, AVIF or HEIC image');
  let out;
  try {
    out = await sharp(req.file.buffer, { limitInputPixels: 100_000_000 })
      .rotate() // honor the camera's orientation before metadata is dropped
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new HttpError(400, "That file couldn't be read as an image");
  }
  const id = new ObjectId();
  await new Promise((resolve, reject) => {
    bucket()
      .openUploadStreamWithId(id, `${id}.webp`, {
        metadata: {
          contentType: 'image/webp',
          width: out.info.width,
          height: out.info.height,
          original_name: req.file.originalname?.slice(0, 200) ?? null,
          uploaded_by: req.user.id,
        },
      })
      .on('error', reject)
      .on('finish', resolve)
      .end(out.data);
  });
  const file = await col('uploads.files').findOne({ _id: id });
  res.status(201).json({ data: format(file) });
});

// GET /api/uploads — recent uploads, newest first (admin media library).
router.get('/', requireAdmin, async (req, res) => {
  const { limit, offset, page } = pagination(req.query);
  const [total, rows] = await Promise.all([
    col('uploads.files').countDocuments(),
    col('uploads.files').find().sort({ uploadDate: -1 }).skip(offset).limit(limit).toArray(),
  ]);
  res.json(paged(rows.map(format), total, { page, limit }));
});

// GET /api/uploads/:id.webp — public. Files never change, so they cache forever.
router.get('/:file', async (req, res) => {
  const id = parseId(req.params.file);
  const file = id && await col('uploads.files').findOne({ _id: id });
  if (!file) throw new HttpError(404, 'Image not found');
  res.set({
    'Content-Type': file.metadata?.contentType ?? 'image/webp',
    'Content-Length': String(file.length),
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: `"${id}"`,
    // Let the website (another origin) display these images.
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  if (req.headers['if-none-match'] === `"${id}"`) return res.status(304).end();
  bucket().openDownloadStream(id).on('error', () => res.destroy()).pipe(res);
});

router.delete('/:file', requireAdmin, async (req, res) => {
  const id = parseId(req.params.file);
  if (!id || !(await col('uploads.files').findOne({ _id: id }))) throw new HttpError(404, 'Image not found');
  await bucket().delete(id);
  res.status(204).end();
});

module.exports = router;
