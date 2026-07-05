const express = require('express');
const db = require('../../db/db');

const router = express.Router();

// Read-only reporting over play_logs — every play (announcement, banner, fullscreen ad) is
// already logged with full granularity by the Hub and synced up via syncAgent.js's reportUp(),
// so counts here are a straight aggregation, no new tracking infrastructure needed.
router.get('/play-counts', (req, res) => {
  const byType = db
    .prepare(`
      SELECT c.type AS type, COUNT(*) AS play_count, SUM(pl.billable) AS billable_count
      FROM play_logs pl JOIN content_items c ON c.content_id = pl.content_id
      GROUP BY c.type
      ORDER BY play_count DESC
    `)
    .all();

  const byContent = db
    .prepare(`
      SELECT pl.content_id AS content_id, c.type AS type, c.original_filename AS original_filename,
             c.campaign_id AS campaign_id, COUNT(*) AS play_count, SUM(pl.billable) AS billable_count
      FROM play_logs pl JOIN content_items c ON c.content_id = pl.content_id
      GROUP BY pl.content_id
      ORDER BY play_count DESC
    `)
    .all();

  res.json({ by_type: byType, by_content: byContent });
});

module.exports = router;
