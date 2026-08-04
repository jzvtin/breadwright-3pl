# Founders Box Presale — Design Spec

**Date:** 2026-08-04
**Store:** `breadwright-3.myshopify.com` (breadwrightbox.com)
**Launch / first ship date:** **2026-08-15**
**Scope:** Storefront + Shopify admin only. The Datex 3PL bridge is a separate
concern and is untouched by this work.

## Goal
Put the existing **Founders Box** product on presale: customers can buy it
**now and are charged in full today**; orders are **held and shipped starting
Aug 15, 2026**. No paid pre-order app — achieved with native Shopify inventory
settings plus theme cues.

## Decisions (locked)
- **Mechanic:** charge now, ship Aug 15+ (standard Shopify pre-order).
- **Scope:** the single existing **Founders Box** product only. Rest of catalog
  unaffected.
- **Countdown:** yes — a live "launches in Xd Xh Xm" timer to Aug 15 on the
  product page.
- **Connection:** custom-app **Admin API token** (`write_products`,
  `read_products`, `write_themes`, `read_themes`, `write_inventory`,
  `read_inventory`), stored in the gitignored `.env` as `SHOPIFY_ADMIN_TOKEN`.
- **Theme safety:** all theme edits land on a **duplicated, unpublished** copy
  of the live theme first; preview link to owner; owner publishes.

## Architecture / components

### 1. Connection (prerequisite)
Owner mints a custom-app Admin API token in Shopify admin and pastes it. It goes
into `.env` (`SHOPIFY_ADMIN_TOKEN`). Verified by listing products via Admin
GraphQL (`2024-10`). Blocks everything below until present.

### 2. Product configuration (Admin API, GraphQL `2024-10`)
Target: the existing "Founders Box" product (located by title/handle).
- Set the variant `inventoryPolicy = CONTINUE` — allows purchase at 0 inventory
  (this is what makes "sell now" work without stock).
- Add product tag `preorder` — the single switch the theme keys off of.
- Set metafield `custom.ship_date = "2026-08-15"` (date) so the ship date is
  data-driven, not hardcoded in Liquid. Theme reads it; countdown targets it.
- Ensure product `status = ACTIVE` and published to the Online Store channel.

### 3. Theme cues — `snippets/founders-preorder.liquid`
A self-contained snippet, rendered from `templates/product.liquid`, that no-ops
unless `product.tags contains 'preorder'`. When active it renders:
- **PRE-ORDER badge** on the product page (and, via a tag check, the collection
  card).
- **Add-to-cart button label** → `Pre-order — ships week of Aug 15`.
- **Ship note** under the button: *"Founders Boxes ship starting Aug 15, 2026 —
  you're charged today to lock your spot."*
- **Countdown timer** to the `custom.ship_date` metafield (fallback constant
  `2026-08-15T00:00:00` if the metafield is missing). Vanilla JS, no library;
  renders `Launches in Xd Xh Xm Xs`; on reach-zero it hides itself and shows
  *"Now shipping."*

Ship date and copy come from the metafield/snippet — no other template files are
touched beyond the one render call in `product.liquid`.

### 4. Ops / fulfillment
- Orders are **charged now, fulfillment held** until Aug 15. Owner does not
  fulfill Founders Box orders before the launch date.
- The 3PL bridge is in `DRY_RUN=1` and does not live-send, so presale orders do
  not reach the warehouse early. No change to the bridge.

## Data flow
```
Owner mints token ─▶ .env SHOPIFY_ADMIN_TOKEN
        │
        ▼
Admin API: find Founders Box ─▶ set inventoryPolicy=CONTINUE, tag 'preorder',
                                 metafield custom.ship_date=2026-08-15
        │
        ▼
Duplicate live theme (unpublished) ─▶ add snippets/founders-preorder.liquid
   + one render call in templates/product.liquid ─▶ push via Admin themes/assets
        │
        ▼
Preview link ─▶ owner reviews ─▶ owner publishes
        │
        ▼
Storefront: Founders Box shows badge + "Pre-order" button + ship note + countdown
```

## Error handling / edge cases
- **No token / bad token:** verification step fails loudly; no product or theme
  writes attempted.
- **Product not found by title:** stop and report candidates rather than
  guess-editing the wrong product.
- **Metafield missing at render:** countdown falls back to the hardcoded
  `2026-08-15` constant so the storefront never shows a broken timer.
- **Countdown past launch:** timer hides itself, shows "Now shipping."
- **Live theme safety:** never edit the published theme directly; work on a
  duplicate and hand off the preview for publish.

## Turn-off plan (post-launch)
Remove the `preorder` tag from the Founders Box → badge, button label, note, and
countdown all revert automatically (snippet no-ops). Optionally set
`inventoryPolicy` back to `DENY` and reconcile real inventory.

## Open inputs (non-blocking; gathered at implementation)
- Confirm the exact product title/handle once connected (expected "Founders
  Box").
- Confirm whether the collection-card badge is wanted, or product-page only.

## Out of scope
- Any change to the Datex 3PL bridge.
- Deposit/partial-payment flows (rejected — full charge now).
- Store-wide presale (only the Founders Box).
- Email waitlist / notify-me (rejected — real charged pre-orders).
