const { HttpError } = require('../utils');

// validate(schema) parses req.body with a zod schema and replaces it with the result.
const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source] ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    return next(new HttpError(400, 'Validation failed', details));
  }
  req[source === 'body' ? 'body' : 'validated'] = result.data;
  next();
};

module.exports = validate;
