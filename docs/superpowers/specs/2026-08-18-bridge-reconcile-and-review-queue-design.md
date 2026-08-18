# Breadwright 3PL — SKU reconciliation + review-then-confirm queue

Date: 2026-08-18
Status: approved design, pre-implementation

## Problem

Two things are wrong / missing on the Breadwright ↔ Ice Cube (Datex FootPrint WMS)
bridge:

1. **Data correctness.** `config/materials.js` and the XML builder are stale
   relative to the canonical SKU map (`breadwright_sku_map.json`, 2026-08-18) and
   the reference order `BW_1003_datex_order.xml`. Material codes are mixed-case,
   only the Founder's Box explodes, several packaging/insert codes that the
   reference order emits to Datex are currently held out, and the bridge reads
   Shopify `quantity` (which ignores order edits) instead of `current_quantity`.

2. **No human gate.** Orders currently reach Ice Cube via an auto-dropping webhook
   or nightly batch. Breadwright wants: order comes in → staged on
   `api.breadwrightbox.com` → a human reviews the generated XML + pack list →
   clicks Confirm → *only then* the file drops to Ice Cube. "Don't send bad data
   to them."

## Canonical sources of truth

- `breadwright_sku_map.json` (2026-08-18) — bread codes, box explode recipes,
  per-order injected packaging, computed inserts, add-on/Datex-code gaps.
- `BW_1003_datex_order.xml` (2026-08-18) — the exact envelope + line set a real
  order (#1003, Founder's Box, add-ons removed by edit) must produce.

Where the map/XML disagree with older ad-hoc notes in `materials.js` (the 08-13
"freezer paper removed / infosheet ShipStation-only" decisions), **the 08-18
canonical wins** (owner decision, 2026-08-18).

## Decisions (owner, 2026-08-18)

- **Datex line set:** trust today's XML. Emit `BW_BFP` (1 per bread unit),
  `BW_INFOSHEET` (every order), and `BW_WB` (first order only) as Datex order
  lines. Reverses the 08-13 hold-outs.
- **OwnerReference:** keep the fixed tag `BWICCS` for now. (May revisit — the
  08-18 sample used the numeric Shopify order id; flagged, not adopted.)
- **Workflow:** pull-on-demand + confirm. No webhook, no new persistent store.
- **Blocking warnings:** hard-block. Confirm & Send is disabled until the order
  is clean.
- **Build-A-Box with missing/unparseable loaf properties:** block that order.

---

## Project A — Data correctness

### A1. Casing → UPPER_SNAKE
Normalize every material code the bridge emits to UPPER_SNAKE, because Datex holds
three of them in mixed case and the map mandates one canonical casing:
- `BW_SeedSD` → `BW_SEEDSD`
- `BW_CranPec` → `BW_CRANPEC`
- `BW_PFran` → `BW_PFRAN`
- `BW_Infosheet` → `BW_INFOSHEET`

Touch: `LOAVES`, `CASE_PACK`, `FOUNDERS_BOX`, `PACKAGING`, `SHIPSTATION_EXTRAS`,
`FIRST_ORDER_INSERTS`. Any downstream string compares that assumed old casing.

### A2. All box explode recipes
Add every box from the map's `box_explode`, keyed so the resolver matches on
Shopify SKU/handle. Fixed-recipe boxes carry their `lines`; Build-A-Box variants
are property-driven.

| Box SKU | Recipe source | bread_units |
|---|---|---|
| `BW-BOX-01` Founder's | fixed | 7 |
| `BW_CLASSICS` | fixed | 6 |
| `BW_SDLOVER` Sourdough Lover's | fixed | 6 |
| `BW_SANDWICH` | fixed | 6 |
| `BW_INFLBOX` Influencer | fixed | 6 |
| `BW_ENTERTAINER` | fixed | 6 | **BLOCKED** — contains `BW_PGBUTTER` (no Datex code) |
| `BW_BAB6` Build-A-Box 6 | line-item properties | 6 |
| `BW_BAB8` Build-A-Box 8 | line-item properties | 8 |

- Correct the stale "6 loaf units" comment on Founder's Box → **7** (matches
  `bread_units` and the reference XML `BW_BFP` amount of 7).
- **Entertainer** resolves to a **blocking warning**, never order lines, until the
  butter has a Datex code + stock.

### A3. Build-A-Box (property-driven)
`BW_BAB6` / `BW_BAB8` have no fixed `lines`. The customer's chosen loaves arrive
as Shopify **line-item properties**. The resolver reads those properties, maps
each chosen loaf name to its `BW_*` code, and emits one order line per loaf.
If the properties are missing, unparseable, or the loaf count ≠ the box's
`bread_units`, the order is **blocked** with a warning (owner decision) — never
guessed, never shipped short.

### A4. Datex line set per order (matches BW_1003)
For each order, `buildOrderNode` emits, in this order:
1. **Bread** — exploded box recipes + any standalone loaf lines, using
   `current_quantity` (see A6). Qty-0 lines are skipped.
2. **Injected every order** (`inject_every_order`): `BW_BOX14` ×1, `BW_GCF1` ×1,
   `BW_GCF2` ×1, `BW_GELPK` ×2.
3. **Injected computed** (`inject_computed`):
   - `BW_BFP` × (total bread units on the order).
   - `BW_WB` ×1 **iff** the order is the customer's first (`isFirstOrder`).
4. **Insert**: `BW_INFOSHEET` ×1.
5. **Never emitted to Datex:** `BW_DRYICE` (pack sheet only, capped 2×5 lb),
   any add-on whose `datex_code` is null.

This moves `BW_INFOSHEET`, `BW_BFP`, and `BW_WB` from the ShipStation-only /
held-out buckets back into the Datex order lines. `config/materials.js` structures
change accordingly: an `INJECT_EVERY_ORDER` list, an `INJECT_COMPUTED` block, and
first-order wiring already available via `order.isFirstOrder`.

### A5. Reject / hold rules (blocking warnings)
An order carries a **blocking** warning (Confirm disabled) when any of:
- A line resolves to no Datex code (unknown SKU).
- A line's mapped code has `datex_code: null` — the add-ons `BW-EVOO`,
  `BW_PGBUTTER`.
- The order contains the `BW_ENTERTAINER` box.
- A Build-A-Box's loaves can't be resolved (A3).

Non-blocking warnings (informational, send still allowed): unknown dry-ice zone,
air-shipment dry-ice declaration reminder, etc.

### A6. Read `current_quantity`, not `quantity`
`src/shopify.js normalizeOrder` maps each line item's `current_quantity`
(Shopify REST reflects order edits here; removed add-ons read 0). Fall back to
`quantity` only when `current_quantity` is absent. Lines with resolved qty 0 are
dropped before building. This is exactly why #1003's removed EVOO + butter must
not appear.

### A7. Unchanged
- Envelope: `<Orders>` root, `OrderClass BW`, `UserCode ALLEY`, warehouse
  `Ice Cube Cold Storage`, `ProjectLookupCode BREADWRIGHT`, the 7 `UserDefinedFields`.
- `OwnerReference` = `BWICCS` (fixed).
- Dry-ice computation (`config/dryice.js`) and carrier/service-level logic.

---

## Project B — Review-then-confirm queue

Reuses existing primitives: `fetchOrdersForBatch`, `normalizeOrder`,
`buildCustomerOrder`, `tagOrderSent`, the SFTP drop, and the PHP proxy pattern.

### B1. `GET /peek/pending` (Railway, key-gated)
- Calls `fetchOrdersForBatch({ windowHours, sentTag: '3pl-sent' })` → paid,
  unshipped, not-yet-sent orders.
- For each: `normalizeOrder` → `buildCustomerOrder` → returns
  `{ number, customer, city, state, xml, pack, warnings, blocking: bool }`.
  `blocking` is true if any A5 condition fired.
- Read-only. Never touches SFTP.

### B2. `POST /peek/confirm-send?number=NNNN` (Railway, key-gated)
- `fetchOrderRawByNumber` → `normalizeOrder` → `buildCustomerOrder`.
- **Server re-checks `blocking`**; if blocking, returns 409 and does NOT drop
  (defense in depth — never trust the client's disabled button).
- SFTP-drops the file to the outbound dir, then `tagOrderSent(orderId)`.
  Idempotent: the Shopify tag is the single source of "already sent", so a
  double-click or a Railway restart cannot double-drop.
- Honors `DRY_RUN`: in dry-run, writes to `out/` and still tags (configurable),
  so staging behaves like prod without touching Ice Cube.

### B3. Console — Review Queue tab (`src/dashboard.html` + PHP `index.php`)
- New "Review Queue" tab. On open, calls the proxy `?action=pending`.
- Renders one card per order: number, customer, destination, warning badges.
  Blocking orders get a red badge and their **Confirm & Send** button disabled,
  with the blocking reason shown.
- Expanding a card shows the generated XML + human pack list.
- **Confirm & Send** → proxy `?action=confirm-send&number=NNNN` → on success the
  card flips to "Sent ✓" and drops out of the list on refresh (now tagged).
- Nothing on this screen ever auto-sends.

### B4. PHP proxy additions (`index.php` on DreamHost)
Add two same-origin, auth-gated actions mirroring the existing pattern:
- `action=pending` → `GET /peek/pending?key=PEEK_KEY`
- `action=confirm-send` → `POST /peek/confirm-send?key=PEEK_KEY&number=…`
The live `index.php` runs ahead of `deploy/breadwright-status.php` — pull the live
file, add the actions, push back via SFTP (atomic: upload to `.tmp`, then rename).

---

## Deploy

1. Land Project A + B code changes in the repo, commit.
2. `git push` → Railway auto-redeploys the API.
3. Sync `deploy/breadwright-status.php` from the live `index.php`, add the two
   proxy actions, push the merged file back to DreamHost
   (`api.breadwrightbox.com/index.php`) via SFTP.
4. Verify: open console → Review Queue lists today's orders; a clean order sends
   (dry-run first), a butter/Entertainer order is hard-blocked.

## Testing

- **Golden file:** regenerate #1003 from its normalized order and assert byte-for-
  byte (modulo dates) equality with `BW_1003_datex_order.xml` — 13 lines, correct
  codes, `BW_BFP` = 7, no EVOO/butter, no box code, no dry-ice line.
- **Casing:** every emitted `MaterialLookupCode` is UPPER_SNAKE.
- **current_quantity:** an order with an edited-out add-on (currentQuantity 0)
  omits that line.
- **Blocking:** Entertainer box, an EVOO/butter line, and a Build-A-Box with no
  properties each produce `blocking: true` and a 409 from confirm-send.
- **Idempotency:** confirm-send twice on one order drops once (second is a no-op
  because the tag is present).
- **Each remaining fixed box** explodes to its map recipe with the correct
  bread-unit count.

## BLOCKER — Shopify Admin token (2026-08-18)

Railway's `SHOPIFY_ADMIN_TOKEN` is invalid (live probe of `/packslip/order?order=1003`
returns `401 [API] Invalid API key or access token`); local `.env` holds only a
`PASTE_…` placeholder. Consequences:

- **Project B cannot run** until a valid token (scopes `read_orders` +
  `write_orders`) is set in Railway env (and locally for dev). The pull queue,
  confirm-send tagging, and ship-confirm all depend on it.
- **Build-a-Box parsing (A3) cannot be verified** — we can't fetch a real
  Build-a-Box order's line-item properties without the token. Implement a
  best-effort parser now against the loaf-name map; verify + adjust against the
  first real order once the token is in.

Action (Justin, Shopify admin): Settings → Apps → Develop apps → create app →
Admin API scopes `read_orders` + `write_orders` → Install → reveal `shpat_…` →
set `SHOPIFY_ADMIN_TOKEN` in Railway + local `.env`.

Project A (SKU/XML reconciliation) is **independent of this blocker** and proceeds
now; it is validated against the `BW_1003_datex_order.xml` fixture, no network.

## Out of scope

- Registering a Shopify push webhook (pull model chosen; route already exists if
  wanted later).
- Adopting the numeric-Shopify-id OwnerReference (flagged, deferred).
- Enabling Entertainer box / add-ons (blocked on Datex codes + stock at Ice Cube).
- Storefront/theme changes.
