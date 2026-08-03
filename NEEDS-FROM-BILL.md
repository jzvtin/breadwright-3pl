# What we still need from the 3PL (Bill Turgeon / RSI / Datex) before go-live

The code is built and generating correct-shape XML. These are the **business facts
only the 3PL can confirm.** Each maps to a one-line change in `config/materials.js`
(or `.env`) — no code changes needed once we have answers.

> **Update 2026-08-03:** Muhammad sent a packet (SKU & weight table, Zone 2–4 ZIP
> list, warehouse packing SOP, Breadwright to-do list, and the Wildgrain daily-
> processing SOP). It resolved several items below — see ✅ RESOLVED. Source docs
> are versioned in `docs/` and `config/zone-zips.csv`.

---

## ✅ RESOLVED by the 2026-08-03 packet

- **Full material code map + weights** — see `config/materials.js` (`LOAVES`,
  `CASE_PACK`). Six sellable loaves confirmed.
- **`BW_BFP` and `BW_WB` are NOT products** — BW_BFP = Brown Freezer Paper,
  BW_WB = First-order Welcome Booklet. Moved to `PACKAGING` / `FIRST_ORDER_INSERTS`.
- **Definitive packaging codes** = the `BW_*` set (`BW_BOX14`, `BW_GCF1`, `BW_GCF2`,
  `BW_BFP`, `BW_DRYICE`, `BW_GELPK`, `BW_Infosheet`). The old `ICE5_AC/BOX1_RC/GCF1/GCF2`
  sample codes were placeholders. **Correction:** GCF1/GCF2 are the two INSULATION
  panel sides of the cooler, not gift-card flyers.
- **Welcome booklet = first order only** (needs a first-order signal to wire up).
- **Carrier = UPS; tracking goes in the `VendorReference` field** (per the
  Breadwright to-do list). Confirms how the return feed should echo tracking back.
- **Order Class = BW** (already in config; re-confirmed).

---

## Still open

### 1. Kits / bundles  ⭐ biggest remaining product blocker
Founder's Box / Build-a-Box / bundles — does a box ship as ONE kit code, or does it
explode into its component loaves on the order? If a kit, what's the code?

### 2. Packaging QUANTITIES per box (codes are settled; counts are not)
- **Dry ice (`BW_DRYICE`):** how many 5lb blocks by shipping **zone**? The packing
  SOP says dry ice is added "according to the shipping label requirements," and we
  now have the Zone 2–4 ZIP list — we just need the **zone → lbs (or blocks)** table.
- **Gel packs (`BW_GELPK`):** how many per box? Used with or instead of dry ice?
- **Insulation (`BW_GCF1`/`BW_GCF2`):** how many panels per box (1 each = one cooler)?
- **Freezer paper (`BW_BFP`):** per loaf, or per box?
- **Info sheet (`BW_Infosheet`):** in every order? (It was NOT in the outbound sample.)

### 3. Which UserCode do WE stamp on files we generate?
Samples used `ALLEY` (outbound) and `JP+` (inbound). Confirm the account to use.

### 4. SFTP folder layout + filenames — mostly DISCOVERED 2026-08-03
Logged in (creds work) and mapped the server (Azure Blob SFTP, case-sensitive):
- `/Test` → has `Archive` (imported OK, renamed `.usedxml`) + `Error` (rejected). Used
  for test drops. **We dropped `BW_13532_TEST.xml` here 2026-08-03; no error.**
- `/Datex` → `Import` (prod orders in), `Export` (return/tracking files out),
  `BartenderXML` (label printing).
Still CONFIRM with Bill:
  - Prod outbound = `/Datex/Import` and return feed = `/Datex/Export`? (inferred, not stated)
  - Does the test-import watcher on `/Test` run on a schedule? (Archive's newest file is
    Aug 2024 — it may be idle, so our test file may sit until someone runs the import.)
  - **Filename convention:** old test files were `314952_327051_20240830_115504.usedxml`
    (numeric owner/project/order + timestamp). Do they require that shape, or is our
    `BW_<order>_<id>.xml` fine?

### 5. The return feed (tracking back to Shopify)
- Does the WMS drop a **ship-confirmation file** with the UPS tracking number? What's
  its schema — is it the outbound envelope echoed back with `<VendorReference>` filled?
- Any **inventory snapshot** file (on-hand levels) we should sync to Shopify?
- How often are they dropped?

### 6. Inbound (ASN) details
- Correct **ShipTo** for inbound stock — the warehouse itself? (Samples used a
  residential address that looked like test data.)
- Are **lot / bake-date** numbers required on inbound lines? (One sample had a `<Lot>`
  block, the other didn't. Matters for FEFO picking of perishable bread.)

### 7. Order selection / routing
Both sides have the same open question (Breadwright to-do list asks it too):
"**How to select orders to process — by days to arrive? 1 / 2 / 3 / 4+?**" This ties
to the zone list (transit time). Also: do ALL Shopify orders route here, or only
certain products?

### 8. Security
Rotate the SFTP password — it was shared in plaintext over email and is exposed.
Ask if Datex supports **SSH key auth** instead of a password (cleaner + safer).

---

## ⚠️ Possible new scope — label / pack-list endpoint (from the Wildgrain SOP)
The 3PL's stated model is "**reporting similar to Wildgrain**." In that flow the
warehouse **pulls label PDFs from an endpoint** (`api.wildgrain.com/icecube/today`)
and generates pack lists / UPS labels from selected orders — the Breadwright to-do
list asks exactly this ("how to get Pack List / UPS Shipping Label based on selected
orders"). That is **beyond** the current XML-over-SFTP bridge. Confirm whether
Breadwright is expected to build an equivalent label/pack-list endpoint, and who owns it.
