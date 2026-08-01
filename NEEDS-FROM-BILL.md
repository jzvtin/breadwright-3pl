# What we still need from the 3PL (Bill Turgeon / RSI / Datex) before go-live

The code is built and generating correct-shape XML. These are the **business facts
only the 3PL can confirm.** Each maps to a one-line change in `config/materials.js`
(or `.env`) — no code changes needed once we have answers.

## 1. Finish the product → material-code map  ⭐ biggest blocker
Confirmed: Country Sourdough `BW_CSD`, Seeded Sourdough `BW_SeedSD`,
Cranberry Pecan `BW_CranPec`, Multigrain Pullman `BW_MGP`,
Demi Baguette 2-Pack `BW_DB2PK`, Pane Francese `BW_PFran`.

Still need:
- **`BW_BFP`** — which Shopify product is this?
- **`BW_WB`** — which Shopify product is this?
- **Founder's Box / Build-a-Box / bundles** — does a box ship as ONE kit code, or
  does it explode into its component loaves on the order? If kit, what's the code?

## 2. Packaging codes are inconsistent across the two samples — pick the real ones
- Customer-order sample used: `ICE5_AC`, `BOX1_RC`, `GCF1`, `GCF2`
- Inbound sample used: `BW_BOX14`, `BW_GCF1`, `BW_GCF2`, `BW_Infosheet`

Confirm the **definitive** codes, plus:
- **Ice packs:** how many per box? Does it change by season or box size?
- **Box:** one box code, or does it depend on order size?
- **Info sheet:** does it go in every order? (It was NOT in the outbound sample.)

## 3. Which UserCode do WE stamp on files we generate?
Samples used `ALLEY` (outbound) and `JP+` (inbound). Confirm the account we should use.

## 4. SFTP folder layout + filenames
- Which folder do we drop **outbound orders / inbound ASNs** into?
- Which folder does the WMS drop **return files** into?
- Any required **filename convention**? (We currently use `BW_<order>_<id>.xml`.)

## 5. The return feed (tracking back to Shopify)
- Does the WMS drop a **ship-confirmation file** with the tracking number? What's its
  schema? (The outbound sample carried a UPS tracking number in `<VendorReference>` —
  is the return file the same envelope echoed back with that filled in?)
- Any **inventory snapshot** file (on-hand levels) we should sync to Shopify?
- How often are they dropped?

## 6. Inbound (ASN) details
- For inbound stock, the correct **ShipTo** — should it be the warehouse itself?
  (Samples put a person's residential address there, which looks like test data.)
- Are **lot / bake-date** numbers required on inbound lines? (One sample had a `<Lot>`
  block, the other didn't. Matters for first-expired-first-out picking of perishable bread.)

## 7. Which Shopify orders route to this 3PL?
All orders? Only certain products? (Just the à-la-carte loaves, or boxes too?)

## 8. Security
Rotate the SFTP password — it was shared in plaintext over email and is now exposed.
Ask if Datex supports **SSH key auth** instead of a password (cleaner + safer).
