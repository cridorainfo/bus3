const db = require('../db/db');

const FREQUENCY_CAP_MINUTES = Number(process.env.HUB_FREQUENCY_CAP_MINUTES || 20);

// campaign_quotas is real schema (spec 9.2) but the Pacing Engine that fills it in doesn't exist
// until Phase 3 — so every campaign is treated as having quota remaining. Swap this out for a
// real lookup against campaign_quotas(date=today) once Phase 3 lands, no caller changes needed.
function hasQuotaRemaining(_campaignId) {
  return true;
}

// Section 10's ordering: eligibility -> quota -> frequency cap -> weighted pick -> fallback.
// Screen ads only (ad_video/ad_banner) — announcement segments are handled separately by
// playbackEngine's composeAnnouncement, since those are mandatory, not rotated.
function selectScreenAd({ routeId, tier }) {
  const candidates = db
    .prepare(`
      SELECT * FROM content_items
      WHERE type IN ('ad_video', 'ad_banner')
        AND (route_id IS NULL OR route_id = ?)
        AND (tier IS NULL OR tier = ?)
    `)
    .all(routeId, tier);

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
    .prepare("SELECT content_id FROM play_logs WHERE content_id IN (SELECT content_id FROM content_items WHERE type IN ('ad_video','ad_banner')) ORDER BY played_at DESC LIMIT 1")
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
    .prepare("SELECT * FROM content_items WHERE type IN ('ad_video','ad_banner') AND campaign_id IS NULL LIMIT 1")
    .get();
  return psa || null;
}

module.exports = { selectScreenAd, hasQuotaRemaining };
