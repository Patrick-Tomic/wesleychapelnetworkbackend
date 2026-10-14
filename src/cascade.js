// Deletes that cascade to related documents. These mirror the ON DELETE rules the
// SQLite schema had, since MongoDB has no foreign keys.
const { col } = require('./db');

async function deleteListings(filter) {
  const ids = (await col('listings').find(filter, { projection: { _id: 1 } }).toArray()).map((l) => l._id);
  if (!ids.length) return 0;
  await Promise.all([
    col('reviews').deleteMany({ listing_id: { $in: ids } }),
    col('favorites').deleteMany({ listing_id: { $in: ids } }),
    col('messages').deleteMany({ listing_id: { $in: ids } }),
    col('events').updateMany({ listing_id: { $in: ids } }, { $set: { listing_id: null } }),
  ]);
  return (await col('listings').deleteMany({ _id: { $in: ids } })).deletedCount;
}

const deleteListing = (id) => deleteListings({ _id: id });

async function deleteUser(id) {
  await deleteListings({ owner_id: id });
  await Promise.all([
    col('reviews').deleteMany({ user_id: id }),
    col('favorites').deleteMany({ user_id: id }),
    col('events').updateMany({ owner_id: id }, { $set: { owner_id: null } }),
    col('posts').updateMany({ author_id: id }, { $set: { author_id: null } }),
    col('messages').updateMany({ user_id: id }, { $set: { user_id: null } }),
  ]);
  return (await col('users').deleteOne({ _id: id })).deletedCount;
}

async function deleteCategory(id) {
  const res = await col('categories').deleteOne({ _id: id });
  if (!res.deletedCount) return 0;
  await Promise.all([
    col('listings').updateMany({ category_ids: id }, { $pull: { category_ids: id } }),
    col('categories').updateMany({ parent_id: id }, { $set: { parent_id: null } }),
    col('events').updateMany({ category_id: id }, { $set: { category_id: null } }),
    col('posts').updateMany({ category_id: id }, { $set: { category_id: null } }),
  ]);
  return 1;
}

module.exports = { deleteListing, deleteUser, deleteCategory };
