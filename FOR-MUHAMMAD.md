# Breadwright ⇄ Warehouse — what this is 🍞

Hey Muhammad — here's the plain-English rundown of what got built and where we are.

## The problem
Your cold-storage 3PL runs warehouse software (**Datex FootPrint WMS**) that doesn't have a modern
"plug in your Shopify" button. They told us their own API is coming in **2027**. We didn't want to
wait until 2027 to stop doing this by hand — so **we built the bridge ourselves.** This little
service *is* the API, today.

## What it does
It's an automatic translator sitting between your Shopify store and the warehouse. Two directions:

```
   SHOPIFY  ──────(a customer orders bread)──────▶  [ our service ]  ──▶  WAREHOUSE
                                                      turns it into the       (picks, packs,
                                                      file the warehouse        ships it)
                                                      understands, incl.
                                                      ice packs + box + inserts

   BREADWRIGHT ──(you bake a batch)──▶  [ our service ]  ──▶  WAREHOUSE
                                          tells them stock            (receives it
                                          is incoming                   into inventory)

   WAREHOUSE ──(ships it, gets tracking#)──▶  [ our service ]  ──▶  SHOPIFY
                                                writes tracking             (customer gets
                                                back to the order            their email)
```

No more manually re-typing orders into their system. A customer buys → the warehouse gets the
order automatically → the customer gets tracking automatically.

## Where we are right now ✅
- **It's built and running.** Live on Railway (our host), reachable and healthy.
- **It's in "safe mode" (dry-run).** It generates the exact warehouse files correctly, but doesn't
  send them yet — so we can test everything with zero risk of a bad order hitting the warehouse.
- **It's proven.** See the `examples/` folder — those are real files our service produced, matching
  the samples the 3PL sent us.

## What we need from you / Bill to flip it live 👉 `NEEDS-FROM-BILL.md`
Short list — mostly facts only the warehouse can confirm:
1. Two product codes we couldn't identify (`BW_BFP`, `BW_WB`) + how boxes/bundles map.
2. The exact packaging rule (how many ice packs, which box, which inserts per order).
3. Which SFTP folders to use + whether they send tracking back to us.
4. Rotate that SFTP password — it came over email in plain text, so it's exposed.

Once we have those, going live is basically flipping a switch.

## The bottom line
The hard part — building the whole translator and getting it deployed — **is done.** What's left is
a handful of answers from the warehouse, then we turn it on and it runs itself. When Datex ships
their real API in 2027, we swap one piece and keep everything else.

*(Technical details for whoever's curious: `README.md`. The open questions: `NEEDS-FROM-BILL.md`.)*
