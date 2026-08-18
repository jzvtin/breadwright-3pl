# CLAUDE.md — project context & handoff

Auto-loaded by Claude Code when working in this repo. If you're a fresh Claude
session picking this up: read this file first, then `FOR-MUHAMMAD.md` (overview),
`NEEDS-FROM-BILL.md` (open questions), and `README.md` (how to run).

## ⚠️ Surfaces (corrected 2026-08-18)
- **Operator console = the PHP dashboard, LIVE at https://api.breadwrightbox.com**
  hosted on **DreamHost shared hosting** (NOT a DigitalOcean box — that earlier note
  was wrong). Edit the live file over **SFTP**: host `iad1-shared-b7-36.dreamhost.com`,
  user `dh_u9nmsm`, port 22, docroot `./api.breadwrightbox.com/index.php`. Password
  is in the PO Drive 🔐 Logins doc, never here (this repo is public). It moved here
  FROM the old dynaradigital.com/breadwright (that old URL is dead). The PHP is a
  thin proxy: it forwards `?action=` calls to the Railway API and injects PEEK_KEY
  server-side. **The LIVE index.php runs AHEAD of `deploy/breadwright-status.php`
  — pull the live file, edit, atomic-swap back (upload `.new`, back up, rename).**
- **API backend = the Railway node app** (`breadwright-3pl-production.up.railway.app`).
  All logic lives here: /peek, /peek/send-test (now unique #+address per drop),
  /peek/generate, pack lists, batch. The PHP console gets every backend fix for
  free because it proxies here.
- The Railway app ALSO now serves its own built-in console at `/` (src/dashboard.js,
  password `Bready`) as a self-contained backup — reachable at the Railway URL.
- NOTE: `api.breadwright.com` (no "box") is NOT ours — breadwright.com is
  unregistered. Do not use it.

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

## Update 2026-08-18 — canonical SKU reconcile + review queue
- **Source of truth for materials** is now `fixtures/breadwright_sku_map.json` +
  `fixtures/BW_1003_datex_order.xml` (the map lives on a Shopify product metafield
  too). `config/materials.js` was rewritten to match; `test/golden-1003.js` locks
  it (regenerates #1003 and asserts the line set). Key rules now in force: codes are
  canonical UPPER_SNAKE; all 8 boxes explode; `BW_INFOSHEET` + `BW_BFP` (1/bread
  unit) + `BW_WB` (first order) ARE Datex lines (reversed the 08-13 hold-outs);
  `BW_DRYICE` never is; read `current_quantity` (order edits); Entertainer box +
  null-Datex-code add-ons (EVOO/butter) hard-block. OwnerReference kept `BWICCS`.
- **Review-then-confirm queue is LIVE** (nothing auto-sends): `GET /peek/pending`
  lists today's paid/unshipped/un-`3pl-sent` orders with XML + pack list + a
  `blocking` list; `POST /peek/confirm-send?number=N` re-checks blocking (409 if
  blocked), SFTP-drops, tags `3pl-sent` (idempotent). Console shows a **Review
  queue** section at the top of api.breadwrightbox.com.
- **⛔ BLOCKER:** `SHOPIFY_ADMIN_TOKEN` is INVALID on Railway (Shopify 401) and a
  placeholder in local `.env`. The whole pull queue is inert until a valid custom-app
  token (`read_orders`+`write_orders`) is set in Railway. It also blocks verifying
  Build-a-Box parsing against a real order.
- **Railway does NOT auto-deploy from GitHub** — after `git push`, run
  `railway up --detach` (CLI is linked to project `breadwright-3pl`).

## Current status (as of last session, 2026-08-01)
- ✅ Built and structurally **verified** against the 3PL's 3 sample XMLs.
- ✅ **Deployed to Railway**, live + healthy in **dry-run mode**.
- ⏳ Blocked on business answers only the 3PL can give — see `NEEDS-FROM-BILL.md`.
- Not yet live-sending: `DRY_RUN=1` (generates XML, does NOT touch SFTP).

## Key facts / where things live
- **GitHub:** https://github.com/jzvtin/breadwright-3pl (public)
- **Railway:** project `breadwright-3pl` (Justin K's workspace).
  - **Public API domain: https://api.breadwright.com** (canonical — use this
    everywhere: Shopify webhook target, health checks, `POST /batch/run`).
  - Underlying Railway URL: https://breadwright-3pl-production.up.railway.app
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
npm run dryrun:order      # single Shopify order -> out/*.xml (no network)
npm run dryrun:batch      # END-OF-DAY BATCH of orders -> out/BW_BATCH_*.xml (no network)
npm run batch             # LIVE nightly batch: pull today's paid orders -> SFTP + tag sent
npm run dryrun:inbound    # bake batch    -> out/*.xml
npm start                 # webhook server (also exposes POST /batch/run?key=PEEK_KEY)
npm run poll              # return-feed poller (skeleton)
railway up --detach       # redeploy (also auto-deploys on git push if GitHub-linked)
```

## End-of-day batch (the "batch orders at midnight to Ice Cube" flow)
- `src/batch.js` pulls PAID + unshipped + not-yet-`3pl-sent` orders (Shopify Admin
  REST, `src/shopify.js fetchOrdersForBatch`), builds ONE Datex file whose `<Orders>`
  root wraps every day's `<Order>` (`buildBatch` in `src/xml/buildOrder.js`), SFTP-drops
  it (or out/ in dry-run), then tags each order `3pl-sent` (persistent idempotency —
  survives Railway restarts, unlike the on-disk `.sent` markers).
- **Scheduling (Justin, in Railway):** add a 2nd service from this repo with
  startCommand `npm run batch` and Cron Schedule `0 4 * * *` (= 00:00 EDT; use `0 5 * * *`
  in winter/EST). Or point any external cron at `POST /batch/run?key=<PEEK_KEY>`.
- **CONFIRM w/ Bill:** does the import accept many `<Order>` in one file? If they want
  one file per order, set env `BATCH_MODE=per-order` (drops individually, same run).
- **Scopes needed on the custom app:** `read_orders` (pull) + `write_orders` (tag sent).

## Go-live checklist (when the 3PL replies)
1. Update `config/materials.js` from Bill's answers (codes, packaging, UserCode,
   ShipTo, lots), push → Railway redeploys.
2. For the NIGHTLY BATCH (preferred over per-order webhook): create a Shopify custom
   app with `read_orders`+`write_orders`, set `SHOPIFY_STORE` + `SHOPIFY_ADMIN_TOKEN`,
   add a Railway cron service running `npm run batch` at `0 4 * * *`. (Per-order webhook
   is still available — create an `orders/create` webhook → `SHOPIFY_WEBHOOK_SECRET`.)
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
