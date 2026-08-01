# CLAUDE.md — project context & handoff

Auto-loaded by Claude Code when working in this repo. If you're a fresh Claude
session picking this up: read this file first, then `FOR-MUHAMMAD.md` (overview),
`NEEDS-FROM-BILL.md` (open questions), and `README.md` (how to run).

## What this is
A bridge between **Breadwright's Shopify** (`breadwright-3.myshopify.com` /
breadwrightbox.com — artisan bread) and their **3PL's Datex FootPrint WMS** at the
**Ice Cube Cold Storage** warehouse. The 3PL has no API until **2027**, so this
service IS the interim API: it exchanges **XML files over SFTP** (namespace
`http://www.datexcorp.com/OrderSchema.xsd`).

Three flows:
1. **Outbound** — Shopify order → *Customer Order Shipment* XML (root `<Orders>`,
   OrderClass `BW`), auto-injecting packaging (ice/box/inserts) → SFTP.
2. **Inbound** — a bake batch → *Inbound Shipment* ASN/PO XML (bare `<Order>`,
   OrderClass `PO`) → SFTP.
3. **Return feed** (skeleton) — poll SFTP for WMS ship-confirmations → write
   tracking into Shopify via Admin API.

## Current status (as of last session, 2026-08-01)
- ✅ Built and structurally **verified** against the 3PL's 3 sample XMLs.
- ✅ **Deployed to Railway**, live + healthy in **dry-run mode**.
- ⏳ Blocked on business answers only the 3PL can give — see `NEEDS-FROM-BILL.md`.
- Not yet live-sending: `DRY_RUN=1` (generates XML, does NOT touch SFTP).

## Key facts / where things live
- **GitHub:** https://github.com/jzvtin/breadwright-3pl (public)
- **Railway:** project `breadwright-3pl` (Justin K's workspace).
  Service URL: **https://breadwright-3pl-production.up.railway.app**
  - `GET /health` → `{ok, dryRun}`
  - `POST /webhooks/shopify/orders` → the Shopify webhook target
- **Contacts:** Bill Turgeon (RSI/Datex, warehouse side) · Muhammad
  (muhammad@breadwrightbox.com, owner).
- **The crux file:** `config/materials.js` — every unknown (SKU map, packaging
  rule, constants) lives here, each tagged `CONFIRM`. Answers from Bill = one-line
  edits here, nothing else.

## Env vars (set in Railway; see .env.example)
Set: `DRY_RUN=1`, `DATEX_SFTP_HOST/PORT/USER`, `SHOPIFY_STORE`, SFTP dir guesses.
**Still placeholder (`PASTE_...`) — fill when answers arrive:**
- `DATEX_SFTP_PASSWORD` — the ROTATED sftp password (old one was leaked in plaintext).
- `SHOPIFY_WEBHOOK_SECRET` — from Shopify Settings→Notifications→Webhooks.
- `SHOPIFY_ADMIN_TOKEN` — from a Shopify custom app (for tracking write-back).

## Commands
```bash
npm run dryrun:order      # Shopify order -> out/*.xml (no network)
npm run dryrun:inbound    # bake batch    -> out/*.xml
npm start                 # webhook server
npm run poll              # return-feed poller (skeleton)
railway up --detach       # redeploy (also auto-deploys on git push if GitHub-linked)
```

## Go-live checklist (when the 3PL replies)
1. Update `config/materials.js` from Bill's answers (codes, packaging, UserCode,
   ShipTo, lots), push → Railway redeploys.
2. Create Shopify webhook (`orders/create`, JSON) → the `/webhooks/shopify/orders`
   URL above → paste its signing secret into `SHOPIFY_WEBHOOK_SECRET`.
3. Add `SHOPIFY_ADMIN_TOKEN` + finish `src/poller.js` once the return-file schema
   is confirmed.
4. Set `DATEX_SFTP_PASSWORD` (rotated), confirm SFTP folders.
5. Flip `DRY_RUN=0`. Watch Railway logs on the first real order.

## Notes / gotchas
- Outbound root is `<Orders>` wrapping `<Order>`; inbound is a bare `<Order>`. Easy
  to get wrong — the WMS rejects the file if the envelope is off.
- The two 3PL samples DISAGREE on packaging codes (`ICE5_AC/BOX1_RC/GCF1/GCF2`
  vs `BW_BOX14/BW_GCF1/...`). Don't guess — that's an open question.
- Unknown Shopify products WARN (never silently drop) — see resolveMaterial().
- This service does NOT touch the Shopify storefront/theme. Separate concern.
