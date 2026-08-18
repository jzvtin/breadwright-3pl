# Breadwright Console — Reconciliation + Order Visualizer (design)

Date: 2026-08-18
Status: approved (A1 + B1), building

## Problem

Two operator consoles for the Breadwright 3PL bridge have diverged:

- **Railway node console** (`src/dashboard.html`, served at the Railway URL and, via the
  PHP proxy, at `api.breadwrightbox.com`). Current on product data
  (`Founder's Box = 7 loaves — Seeded Sourdough ×2`) and on the unique-test-order UX
  (shows order number, ship-to, 🔑 badge).
- **Box PHP console** (`deploy/breadwright-status.php`, live on the DreamHost/DO box that
  serves `api.breadwrightbox.com`). Stale product data (`Founder's Box = 6 loaves`), old
  test-order UX — but it is the ONLY surface with the **dry-ice calculator**
  (weather + transit aware, POSTs to `?action=dryice` → Railway `/peek/dryice`).

So each side is ahead of the other in a different place. The dry-ice *backend* already
lives on Railway; only its *UI* is missing from `dashboard.html`.

Separately, Muhammad (owner) wants to **self-serve a visual** of an order — the packed
box and the pick/pack sheet — without having to send it to Bill (the warehouse) to see it.

## Decisions

- **B1 — single source of truth.** `src/dashboard.html` (the Railway console) becomes the
  one canonical console. The dry-ice calculator UI is ported into it. The box stops being
  its own copy: a thin PHP wrapper serves the canonical console, injects `PEEK_KEY`
  server-side, and proxies `?action=` to Railway — so the two can never drift again.
- **A1 — stateless share links.** A shared box is encoded as base64 in the URL
  (`/view?o=<b64>`); the public render page recomputes the pack from that. No database, no
  storage, links never expire. Mirrors the existing `?cart=<b64>` pattern used elsewhere.
- **Deploy target (interim):** `dynaradigital.com/breadwright` (reachable now with the
  `dynara_deploy` key) instead of the DO box, whose SSH creds are not yet in hand. The
  canonical `dashboard.html` is unchanged by target; only the wrapper's host differs.

## Components

1. **Dry-ice calculator UI** (in `dashboard.html`) — port the panel from the box PHP:
   ZIP + ship date + service + address → POST `?action=dryice` → render ambient temp,
   calendar days in box, and the `N × 5 lb slab` recommendation. Backend already exists
   (`/peek/dryice`); this is front-end only.

2. **Visualizer** (in `dashboard.html`) — reuse the existing custom-order builder
   (`generateOrder`) and `pickListHTML` / `packCard`, but:
   - Add a **Preview** action that computes the pack WITHOUT dropping a file to `/Test`
     (new `?action=preview` = generate minus the SFTP write), so Muhammad can visualize
     freely without touching the warehouse.
   - Show the **packed-box card** (loaves + packaging + dry-ice) and the **pick/pack
     sheet** preview side by side (both already rendered by existing functions).
   - Keep fixtures + custom-order as the two inputs (no live Shopify pull).

3. **Share link** — a **Share this box** button base64-encodes the current order JSON into
   `/view?o=<b64>`. A new **public** route `/view` (Railway) renders the packed-box +
   pick sheet read-only, no password, no ops controls. The box wrapper passes `/view`
   through unauthenticated so links can read `api.breadwrightbox.com/view?o=…`
   (or the interim `dynaradigital.com/breadwright/view?o=…`).

4. **Box PHP wrapper** (`deploy/breadwright-status.php` → deployed copy) — password gate +
   `PEEK_KEY` injection + `?action=` proxy to Railway + `/view` pass-through. Serves the
   canonical `dashboard.html` fetched from Railway so it cannot drift.

## Data flow

- Build/pick a box → `?action=preview` (no SFTP) → pack JSON → render card + sheet.
- Share → base64(order JSON) → `/view?o=…` → server recomputes pack → same render, read-only.
- Real send (existing) → `?action=generate&send=1` → SFTP drop to `/Test` (unchanged).

## Error handling

- `/view` with a malformed/oversized `o=` param → friendly "couldn't read this box" page,
  never a stack trace; cap decoded size.
- Dry-ice calc failure → inline error in the panel (existing box PHP behavior), sync
  zone/season fallback already in `resolveDryIceConditions`.
- Preview never writes to SFTP, so a warehouse/SFTP outage cannot affect the visualizer.

## Testing

- `?action=preview` returns the same `pack` shape as `generate` minus file write (unit-check
  against a fixture order).
- `/view?o=<b64 of a known order>` renders the same pick sheet as the in-console preview.
- Malformed `o=` → error page, HTTP 200, no throw.
- Box wrapper: authed root serves canonical console; `/view` reachable WITHOUT password;
  `?action=dryice` proxies through and returns a slab count.

## Out of scope (YAGNI)

- Live Shopify order pull into the visualizer.
- Stored/revocable share snapshots (A2).
- Any storefront/theme changes.
