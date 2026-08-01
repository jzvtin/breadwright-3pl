# Breadwright ⇄ Datex FootPrint WMS integration

Moves order/inventory data between Breadwright's Shopify store and the 3PL's
**Datex FootPrint WMS** (warehouse: *Ice Cube Cold Storage*) as **XML over SFTP**.

Three flows:
1. **Outbound** — Shopify order → *Customer Order Shipment* XML → SFTP (3PL picks/packs/ships). Auto-injects ice packs + box + inserts.
2. **Inbound** — a production batch → *Inbound Shipment* (ASN/PO) XML → SFTP.
3. **Return feed** — poll SFTP for the WMS's ship-confirmation files → write tracking into Shopify. *(skeleton — needs the return schema from the 3PL, see `NEEDS-FROM-BILL.md`)*

## Status
Structure is **done and verified** against all three sample XMLs. What's left is
business facts only the 3PL can confirm — see **`NEEDS-FROM-BILL.md`**. Every one
of those is a one-line edit in `config/materials.js` or `.env`; no code changes.

## Try it now (no SFTP, no network)
```bash
npm run dryrun:order      # Shopify order  -> out/BW_13532_dryrun.xml
npm run dryrun:inbound    # bake batch     -> out/INB-00001_dryrun.xml
```
Feed your own data: `node src/cli/dryrun-order.js path/to/shopify-order.json`.
Unknown products print a `⚠️ WARNING` instead of silently dropping.

## Run the live service
```bash
npm install
cp .env.example .env      # fill in secrets; keep DRY_RUN=1 to start
npm start                 # webhook server on :$PORT
```
- `GET /health`
- `POST /webhooks/shopify/orders` — point Shopify's `orders/create` (or `orders/paid`) webhook here.

Flip `DRY_RUN=0` only after the 3PL confirms folders + codes.

## Deploy on Railway
1. New project → deploy this repo (or `railway up`).
2. Set the variables from `.env.example` (secrets go here, **never** in git).
3. Copy the service's public URL → create the Shopify webhook to `…/webhooks/shopify/orders`.
4. For the return feed, add a Railway **cron** running `npm run poll` (e.g. every 10 min) — once the return schema is confirmed.

## Layout
```
config/materials.js   ← the crux: SKU map, packaging rule, constants (all CONFIRM flags here)
src/xml/              ← buildOrder (outbound), buildInbound (ASN), util, address
src/shopify.js        ← HMAC verify, order normalize, fulfillment write-back
src/sftp.js           ← put/list/get (dry-run aware)
src/server.js         ← Railway webhook worker (idempotent)
src/poller.js         ← return-feed poller (skeleton)
src/cli/              ← dry-run generators
NEEDS-FROM-BILL.md    ← the open questions blocking go-live
```

## Security
The SFTP password was shared in plaintext and **must be rotated**. All secrets live
in env / Railway variables — nothing hardcoded. Consider SSH key auth if Datex supports it.
```
