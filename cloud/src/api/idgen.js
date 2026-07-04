// Small human-readable ID helpers (slug + counter) instead of raw UUIDs for buses/routes, so
// the Admin UI and Hub logs show something legible (e.g. `KL07AX1234`, `R-KOCHI-THRISSUR`).

function slugify(input) {
  return String(input)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueId(db, table, pkColumn, base) {
  const slug = slugify(base) || 'ITEM';
  let candidate = slug;
  let i = 1;
  const exists = (id) => !!db.prepare(`SELECT 1 FROM ${table} WHERE ${pkColumn} = ?`).get(id);
  while (exists(candidate)) {
    i += 1;
    candidate = `${slug}-${i}`;
  }
  return candidate;
}

module.exports = { slugify, uniqueId };
