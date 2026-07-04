const express = require('express');
const crypto = require('crypto');
const db = require('../../db/db');

const router = express.Router();

const PENDING_EXPIRY_MS = 48 * 60 * 60 * 1000; // unclaimed pairing IDs older than this are hard-deleted
// A Hub re-registers every ~4s while it's actually alive and polling (see hub/src/sync/
// pairingAgent.js) — anything not refreshed within this window is either crashed, offline, or
// showing a different ID now, so it's hidden from the "waiting to be paired" list even though
// the row itself isn't deleted yet (an in-flight claim on a briefly-stale-but-real ID should
// still succeed).
const STALE_THRESHOLD_MS = 15 * 1000;

function pruneExpiredPending() {
  const cutoff = new Date(Date.now() - PENDING_EXPIRY_MS).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('DELETE FROM pending_pairings WHERE claimed_bus_id IS NULL AND created_at < ?').run(cutoff);
}

// Called by an unpaired Hub on boot, and then again every poll tick as a heartbeat (not just
// once) — so this row's last_seen_at only stays fresh while the Hub is actually still there.
// Deliberately unauthenticated: the ID itself carries no access, it's just a lookup key an admin
// has to actively claim.
router.post('/register', (req, res) => {
  const { device_pairing_id: id } = req.body || {};
  if (!id) return res.status(400).json({ error: 'device_pairing_id_required' });

  pruneExpiredPending();
  db.prepare(`
    INSERT INTO pending_pairings (device_pairing_id, last_seen_at) VALUES (?, datetime('now'))
    ON CONFLICT(device_pairing_id) DO UPDATE SET last_seen_at = datetime('now')
  `).run(id);
  res.json({ ok: true });
});

// Listed in Admin's "Pair a Bus" card so the admin can click a real, currently-broadcasting ID
// instead of retyping it off the bus's screen — misreads/typos are the likeliest cause of an
// unknown_pairing_id error on the claim below. Filtered to recently-heartbeated rows only, so a
// dead Hub's old ID doesn't linger here looking exactly as live as a real one.
router.get('/pending', (req, res) => {
  pruneExpiredPending();
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db
    .prepare('SELECT device_pairing_id, created_at FROM pending_pairings WHERE claimed_bus_id IS NULL AND last_seen_at >= ? ORDER BY created_at DESC')
    .all(cutoff);
  res.json(rows);
});

// Polled by the Hub until an admin claims it.
router.get('/status/:id', (req, res) => {
  const pending = db.prepare('SELECT * FROM pending_pairings WHERE device_pairing_id = ?').get(req.params.id);
  if (!pending) return res.status(404).json({ error: 'unknown_pairing_id' });

  if (pending.claimed_bus_id) {
    return res.json({ claimed: true, bus_id: pending.claimed_bus_id, api_key: pending.claimed_api_key });
  }
  res.json({ claimed: false });
});

// Admin-triggered from the dashboard: reads the pairing ID off the bus's own screen, picks
// which bus record it links to. Rotates that bus's api_key — the same recovery story as
// before (a wiped/reinstalled Hub gets a fresh pairing ID, admin re-claims it against the same
// bus, the old key on the lost disk stops working) just driven from Admin instead of the Hub.
router.post('/claim', (req, res) => {
  const { device_pairing_id: id, bus_id: busId } = req.body || {};
  if (!id || !busId) return res.status(400).json({ error: 'device_pairing_id_and_bus_id_required' });

  const pending = db.prepare('SELECT * FROM pending_pairings WHERE device_pairing_id = ?').get(id);
  if (!pending) return res.status(404).json({ error: 'unknown_pairing_id' });
  if (pending.claimed_bus_id) return res.status(409).json({ error: 'already_claimed' });

  const bus = db.prepare('SELECT * FROM buses WHERE bus_id = ?').get(busId);
  if (!bus) return res.status(404).json({ error: 'bus_not_found' });

  const apiKey = crypto.randomBytes(16).toString('hex');
  db.prepare("UPDATE buses SET api_key = ?, paired_at = datetime('now') WHERE bus_id = ?").run(apiKey, busId);
  db.prepare(`
    UPDATE pending_pairings SET claimed_bus_id = ?, claimed_api_key = ?, claimed_at = datetime('now')
    WHERE device_pairing_id = ?
  `).run(busId, apiKey, id);

  res.json({ ok: true });
});

module.exports = router;
