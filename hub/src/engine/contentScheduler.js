const db = require('../db/db');
const { getBusId, getDeviceConfig } = require('../config/deviceConfig');

const FREQUENCY_CAP_MINUTES = Number(process.env.HUB_FREQUENCY_CAP_MINUTES || 20);

function busTier() {
  const cfg = getDeviceConfig();
  return (cfg && cfg.tier) || 'rural';
}

// Phase 3 Pacing Engine, simplified: the cloud computes each campaign's remaining budget into a
// rounded-down daily quota per bus and ships it down in sync_state (see hubSyncServer.js's
// buildSyncState); this just reads what's already local — no live cloud round-trip needed.
function hasQuotaRemaining(campaignId) {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE campaign_id = ?').get(campaignId);
  // Unknown campaign (not synced down yet) — fail open rather than blacking out content over a
  // sync-timing gap; a genuinely-inactive/deleted campaign never reaches here since the cloud
  // already excludes its content_items from sync_state entirely.
  if (!campaign) return true;
  if (campaign.budget_paisa == null) return true; // unlimited/free

  const quota = db.prepare("SELECT * FROM campaign_quotas WHERE campaign_id = ? AND date = date('now')").get(campaignId);
  // A budgeted campaign with no quota row yet for today (e.g. just created, sync still in
  // flight) fails closed — never risk overspend during that lag window.
  if (!quota) return false;
  return quota.plays_used < quota.plays_allotted;
}

// Section 10's ordering: eligibility -> quota -> frequency cap -> weighted pick -> fallback.
// Screen ads only (ad_video/ad_banner/ad_image) — announcement segments are handled separately by
// playbackEngine's composeAnnouncement, since those are mandatory, not rotated.
function selectScreenAd({ routeId, tier, busId }) {
  const resolvedBusId = busId || getBusId();
  const resolvedTier = tier || busTier();
  const candidates = db
    .prepare(`
      SELECT * FROM content_items
      WHERE type IN ('ad_video', 'ad_banner', 'ad_image')
        AND (route_id IS NULL OR route_id = ?)
        AND (tier IS NULL OR tier = ?)
        AND (target_bus_id IS NULL OR target_bus_id = ?)
    `)
    .all(routeId, resolvedTier, resolvedBusId);

  const eligible = candidates.filter((c) => !c.campaign_id || hasQuotaRemaining(c.campaign_id));
  if (eligible.length === 0) return selectFallback();

  const cutoff = new Date(Date.now() - FREQUENCY_CAP_MINUTES * 60 * 1000).toISOString();
  const notRecentlyPlayed = eligible.filter((c) => {
    const lastPlay = db
      .prepare('SELECT played_at FROM play_logs WHERE content_id = ? ORDER BY played_at DESC LIMIT 1')
      .get(c.content_id);
    return !lastPlay || lastPlay.played_at < cutoff;
  });

  const pool = notRecentlyPlayed.length > 0 ? notRecentlyPlayed : eligible;

  // Never repeat the same content_id twice in a row if any alternative exists.
  const lastPlayed = db
    .prepare("SELECT content_id FROM play_logs WHERE content_id IN (SELECT content_id FROM content_items WHERE type IN ('ad_video','ad_banner','ad_image')) ORDER BY played_at DESC LIMIT 1")
    .get();
  const finalPool =
    pool.length > 1 && lastPlayed ? pool.filter((c) => c.content_id !== lastPlayed.content_id) : pool;

  return weightedPick(finalPool.length > 0 ? finalPool : pool);
}

// Weighted round-robin: house/PSA content (no campaign_id) gets a lower fixed weight than
// paying campaign content, so sponsors are favored but never starve the fallback slot entirely.
function weightedPick(pool) {
  if (pool.length === 0) return null;
  const weighted = [];
  for (const item of pool) {
    const weight = item.campaign_id ? 3 : 1;
    for (let i = 0; i < weight; i++) weighted.push(item);
  }
  return weighted[Math.floor(Math.random() * weighted.length)];
}

// Never dead air, never a frozen screen (spec Section 10, step 5).
function selectFallback() {
  const psa = db
    .prepare("SELECT * FROM content_items WHERE type IN ('ad_video','ad_banner','ad_image') AND campaign_id IS NULL LIMIT 1")
    .get();
  return psa || null;
}

module.exports = { selectScreenAd, hasQuotaRemaining };
