const express = require('express');
const db = require('../../db/db');
const { uniqueId } = require('../idgen');

const router = express.Router();

function withRemaining(campaign) {
  const remaining_paisa = campaign.budget_paisa == null ? null : Math.max(0, campaign.budget_paisa - campaign.spent_paisa);
  return { ...campaign, remaining_paisa };
}

router.get('/', (req, res) => {
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC').all();
  res.json(campaigns.map(withRemaining));
});

router.post('/', (req, res) => {
  const { name, advertiser_name, rate_paisa, budget_paisa } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name_required' });

  const campaignId = uniqueId(db, 'campaigns', 'campaign_id', `C-${name}`);
  db.prepare(`
    INSERT INTO campaigns (campaign_id, name, advertiser_name, rate_paisa, budget_paisa)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    campaignId,
    name.trim(),
    (advertiser_name || '').trim() || null,
    Number.isFinite(Number(rate_paisa)) && Number(rate_paisa) > 0 ? Number(rate_paisa) : 25,
    budget_paisa === null || budget_paisa === undefined || budget_paisa === '' ? null : Number(budget_paisa)
  );

  res.status(201).json(withRemaining(db.prepare('SELECT * FROM campaigns WHERE campaign_id = ?').get(campaignId)));
});

// Partial update. No DELETE for v1 — retire a campaign via active=0 instead, so existing
// content_items.campaign_id references never dangle.
router.put('/:campaignId', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE campaign_id = ?').get(req.params.campaignId);
  if (!campaign) return res.status(404).json({ error: 'campaign_not_found' });

  const { name, advertiser_name, rate_paisa, budget_paisa, active } = req.body || {};
  const nextBudget = budget_paisa === undefined
    ? campaign.budget_paisa
    : (budget_paisa === null || budget_paisa === '' ? null : Number(budget_paisa));

  db.prepare(`
    UPDATE campaigns SET name = ?, advertiser_name = ?, rate_paisa = ?, budget_paisa = ?, active = ?
    WHERE campaign_id = ?
  `).run(
    name !== undefined ? name.trim() : campaign.name,
    advertiser_name !== undefined ? ((advertiser_name || '').trim() || null) : campaign.advertiser_name,
    rate_paisa !== undefined ? Number(rate_paisa) : campaign.rate_paisa,
    nextBudget,
    active !== undefined ? (active ? 1 : 0) : campaign.active,
    campaign.campaign_id
  );

  res.json(withRemaining(db.prepare('SELECT * FROM campaigns WHERE campaign_id = ?').get(campaign.campaign_id)));
});

module.exports = router;
