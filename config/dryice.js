/**
 * config/dryice.js
 * ---------------------------------------------------------------------------
 * Dry-ice quantity model + per-order PACK LIST instruction.
 *
 * Bill (2026-08-04) wants each order to tell the packers exactly how much dry
 * ice to grab. The amount has to scale with three things:
 *   1. how long the box is in transit  (ship distance -> zone -> transit days,
 *      AND weekend/holiday sits — a Fri ship to a 2-day zone = 4 days in box)
 *   2. how hot it is                    (destination weather high, floored at
 *      truck/handling heat)
 *   3. how good the insulation is       (the packaging constant C)
 *
 * PHYSICS (sublimation ~ linear in the temperature gap; Newton cooling):
 *     lbs_per_day = C * (T_ambient - T_dryice)          T_dryice = -109.3 F
 *     consumed    = lbs_per_day * days_in_box
 *     reserve     = enough to survive a +1-day delivery slip (never arrive empty)
 *     total_lbs   = consumed + reserve
 *     blocks      = ceil(total_lbs / 5)
 *
 * C is the packaging's heat-transfer constant (lbs/day/F). 1" Green Cell Foam +
 * cardboard is roughly the "insulated liner" class (~0.02-0.04). We run the
 * PESSIMISTIC end until a real calibration shipment gives the true number:
 *     C = lbs_lost / (days_in_box * (T_ambient - T_dryice))
 * Drop the measured value into C_DEFAULT; nothing else changes.
 *
 * TWO ENTRY POINTS:
 *   - computeDryIce(opts)            SYNC. Pure math. Offline-safe (dry-run CLIs
 *                                    use this with the season/zone fallbacks).
 *   - resolveDryIceConditions(opts)  ASYNC. Does the live weather + calendar-aware
 *                                    transit lookups, then hands the numbers to
 *                                    computeDryIce. Used by the server per order.
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');

// --- Physical + business constants (CONFIRM / calibrate) -------------------
const T_DRYICE = -109.3; // F, sublimation temp of dry ice (fixed)
const BLOCK_LB = 5; //       one dry-ice block = 5 lb
const MARGIN = 0.2; //       legacy flat safety (superseded by RESERVE below; kept for back-compat)

// Heat-transfer constant for 1" Green Cell Foam + cardboard. Pessimistic end of
// the insulated-liner band until a real calibration shipment measures it — we'd
// rather waste a few lb than arrive melted. CALIBRATE ME (weigh before/after one
// real route): C = lbs_lost / (days_in_box * (ambient - (-109.3))).
const C_DEFAULT = 0.02; // ~0.02 (great) … 0.04 (poor). ~4 lb/day @ 90F ambient,
//                         inside the industry "5-10 lb per 24h" cooler rule of
//                         thumb (lower/safer end). THIS IS THE ONE CALIBRATION
//                         KNOB — a single temp-logged shipment replaces the guess.

// A 14x14x14 box can only physically hold so much dry ice alongside the bread.
// Past this we can't just add more — the route needs expedited service, a 2"
// foam upgrade, or a split. computeDryIce caps here and raises a warning.
const MAX_BLOCKS_PER_BOX = 8; // 40 lb — generous ceiling; tune with packers

// Reserve so the box never arrives with zero dry ice (delivery can slip a day).
const RESERVE_DAYS = 1; //     size in an extra day's worth of sublimation
const RESERVE_MIN_LB = 2; //   ...but never less than this

// Ambient never assumed cooler than this in transit — trucks, tarmacs and sort
// hubs run hot even in winter. Destination weather high is used when hotter.
const TRUCK_FLOOR_F = 80;

// Extra box dwell after the carrier's delivery estimate (porch time / slip). Days.
const PORCH_BUFFER_DAYS = 0.5;

// Ship origin — the Breadwright fulfillment warehouse. Zones in zone-zips.csv +
// ZONE_TRANSIT_DAYS are all measured FROM here. Used for the writeup label.
const ORIGIN_LABEL = 'Fall River, MA';

// Breadwright ships Tue + Wed mainly so a box never sits in a warehouse over the
// weekend. Blank ship date defaults to the next preferred ship day; picking a
// Thu-Mon raises a note. getUTCDay: Sun0 Mon1 Tue2 Wed3 Thu4 Fri5 Sat6.
const PREFERRED_SHIP_DOWS = [2, 3]; // Tue, Wed
const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Breadwright ships EVERY order UPS Next Day Air (overnight) — delivery is the
// next business day regardless of zone, so transit time is ~1 day everywhere.
// Zone is kept only for context/weather, NOT for transit time. (Legacy Ground
// zone table left for reference in case a cheaper service is ever offered.)
const TRANSIT_BUSINESS_DAYS = 1; // UPS Next Day Air (default service)
const ZONE_TRANSIT_DAYS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5 }; // UPS GROUND transit by zone

// Selectable shipping services. `days` = business days in transit; null = use the
// Ground zone table. Every order defaults to overnight, but the calculator lets
// you compare (a slower service needs a lot more dry ice).
//
// `maxBlocks` = REGULATORY dry-ice ceiling for that service (UN1845). Air moves
// have a hard per-package dry-ice limit — a 5 lb block on any Air service, two
// blocks (10 lb) on the 2-Day lane specifically. Surface/Ground services carry
// no regulatory cap (only the physical box limit MAX_BLOCKS_PER_BOX applies).
// null = no regulatory cap.
const SERVICE_LEVELS = {
  overnight: { days: 1, label: 'UPS Next Day Air (overnight)', maxBlocks: 1 }, // 5 lb — air
  '2day': { days: 2, label: 'UPS 2nd Day Air', maxBlocks: 2 }, //                10 lb — 2-day air
  '3day': { days: 3, label: 'UPS 3 Day Select', maxBlocks: null }, //           ground/surface
  ground: { days: null, label: 'UPS Ground (by zone)', maxBlocks: null }, //     ground/surface
};
const DEFAULT_SERVICE = 'overnight';

// --- Carrier + shipping MODE by destination (Justin 2026-08-14) --------------
// 1- and 2-day GROUND shipments go UPS. Any destination we CANNOT reach within
// two ground-transit days ships the cheapest AIR option via Yahuda's platform
// "Priority Shippers". AIR is hard-capped at 1 slab (5 lb) of dry ice and MUST
// be declared (check the dry-ice button on Priority Shippers); GROUND needs no
// declaration and carries no regulatory dry-ice cap.
const AIR_MAX_BLOCKS = 1; //            5 lb / 1 slab — hard cap on ALL air shipments
const GROUND_MAX_TRANSIT_DAYS = 2; //   reachable within 2 ground days => UPS Ground
// zone -> UPS Ground transit days, incl. zone 1 (very local, same/next day).
function groundTransitDays(zone) {
  if (zone == null) return null;
  if (zone <= 1) return 1;
  return ZONE_TRANSIT_DAYS[zone] != null ? ZONE_TRANSIT_DAYS[zone] : null;
}
// Decide carrier + mode for a destination. Unknown zone => AIR (conservative:
// we can't confirm 2-day ground, so declare dry ice and keep it cold).
function resolveShipMode(zip, zoneArg) {
  const zone = zoneArg != null ? zoneArg : zoneForZip(zip);
  const gd = groundTransitDays(zone);
  const ground = gd != null && gd <= GROUND_MAX_TRANSIT_DAYS;
  return ground
    ? { mode: 'ground', carrier: 'UPS Ground', declareDryIce: false, groundTransitDays: gd, zone, maxBlocks: null }
    : { mode: 'air', carrier: 'Priority Shippers', declareDryIce: true, groundTransitDays: gd, zone, maxBlocks: AIR_MAX_BLOCKS };
}

// AUTHORITATIVE service decision from the DESTINATION (Justin 2026-08-28). The tag
// is derived from the ZIP/zone, NOT the Shopify method — "nothing over 2 days":
//   ground reaches in <=2 days  -> 2_DAY, UPS Ground (ShipStation), 0 dry ice
//   ground too slow, not far West -> 2_AIR, 2nd Day Air (Priority Shippers), 1 slab
//   ground too slow, far West (zip 8xx/9xx: AZ/CA/NV/WA/OR/UT/CO/NM/ID) -> 1_AIR,
//                                  Next Day Air (Priority Shippers), 1 slab
// Air is hard-capped at 1 slab; ground near Fall River needs none (gel packs only).
function serviceForZip(zip) {
  const m = resolveShipMode(zip);
  if (m.mode === 'ground') {
    return { tier: '2_DAY', vref: '2_DAY', mode: 'ground', source: 'shipstation', service: 'UPS Ground', slabs: 0, zone: m.zone };
  }
  const digits = String(zip || '').replace(/\D/g, '');
  const farWest = /^[89]/.test(digits);
  return farWest
    ? { tier: '1_AIR', vref: '1_AIR', mode: 'air', source: 'priority_shippers', service: 'UPS Next Day Air', slabs: 1, zone: m.zone }
    : { tier: '2_AIR', vref: '2_AIR', mode: 'air', source: 'priority_shippers', service: 'UPS 2nd Day Air', slabs: 1, zone: m.zone };
}

// UPS days with NO pickup/delivery (2026). Add/trim as needed — one-line edits.
const UPS_HOLIDAYS_2026 = new Set([
  '2026-01-01', // New Year's Day
  '2026-05-25', // Memorial Day
  '2026-07-03', // Independence Day (observed; Jul 4 is a Saturday)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas
]);

// Fallback ambient when weather can't be fetched. Summer is the stress case. F.
const AMBIENT_BY_SEASON = { summer: 90, shoulder: 68, winter: 48 };
const DEFAULT_SEASON = 'summer';

// Derive a season from a YYYY-MM-DD ship date so the no-weather fallback isn't
// stuck on summer. Jun-Sep = summer, Dec-Feb = winter, else shoulder.
function seasonForDate(dateStr) {
  const m = dateStr ? Number(String(dateStr).slice(5, 7)) : null;
  if (!m) return DEFAULT_SEASON;
  if (m >= 6 && m <= 9) return 'summer';
  if (m === 12 || m <= 2) return 'winter';
  return 'shoulder';
}

// Gel packs + freezer paper rules.
const GEL_PACKS_BASE = 2; //        baseline per box
const GEL_PACKS_ZONE4_EXTRA = 1; // +1 for the longest routes
const FREEZER_PAPER_PER_LOAF = 1; // one sheet per loaf layer

// --- Zip -> zone lookup (lazy-loaded, cached) ------------------------------
let _zoneByZip = null;
function zoneForZip(zip) {
  if (!_zoneByZip) {
    _zoneByZip = new Map();
    try {
      const csv = fs.readFileSync(path.join(__dirname, 'zone-zips.csv'), 'utf8').replace(/^﻿/, '');
      for (const line of csv.split(/\r?\n/).slice(1)) {
        const cols = line.split(',');
        if (cols.length >= 4 && cols[0]) _zoneByZip.set(cols[0].trim(), Number(cols[3]));
      }
    } catch (e) {
      /* CSV missing -> fall back to default zone below */
    }
  }
  const z = _zoneByZip.get(String(zip || '').trim().slice(0, 5));
  return z || null;
}

// --- Date helpers (UPS calendar-aware transit) -----------------------------
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
function isBusinessDay(d) {
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  return dow !== 0 && dow !== 6 && !UPS_HOLIDAYS_2026.has(ymd(d));
}
function addDays(d, n) {
  const c = new Date(d.getTime());
  c.setUTCDate(c.getUTCDate() + n);
  return c;
}
/** Next business day on/after d (bread doesn't get picked up on a weekend). */
function nextBusinessDay(d) {
  let c = new Date(d.getTime());
  while (!isBusinessDay(c)) c = addDays(c, 1);
  return c;
}
/** Next preferred ship day (Tue/Wed) on/after d, also skipping holidays. */
function nextShipDay(d) {
  let c = new Date(d.getTime());
  for (let i = 0; i < 14; i++) {
    if (PREFERRED_SHIP_DOWS.includes(c.getUTCDay()) && isBusinessDay(c)) return c;
    c = addDays(c, 1);
  }
  return nextBusinessDay(d); // fallback (shouldn't happen)
}
/** Delivery date = shipDate + n UPS business days (weekends/holidays skipped). */
function addBusinessDays(start, n) {
  let c = nextBusinessDay(start);
  let left = n;
  while (left > 0) {
    c = addDays(c, 1);
    if (isBusinessDay(c)) left -= 1;
  }
  return c;
}
function calendarDaysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Calendar days the box actually spends in transit, given a ship date and the
 * zone's UPS business-day transit. This is where a Thu/Fri ship balloons: the
 * box sublimates over the weekend even though UPS isn't moving it.
 * @returns { daysInBox, shipDate, deliveryDate, businessDays, note }
 */
function businessTransit({ zone, shipDate, service }) {
  // Explicit date is respected as-is (but must still be a valid pickup day);
  // blank defaults to Breadwright's next preferred Tue/Wed ship day.
  const start = shipDate
    ? nextBusinessDay(new Date(shipDate + 'T12:00:00Z'))
    : nextShipDay(new Date());
  const dow = start.getUTCDay();
  const preferred = PREFERRED_SHIP_DOWS.includes(dow);
  const svc = SERVICE_LEVELS[service] || SERVICE_LEVELS[DEFAULT_SERVICE];
  const businessDays = svc.days != null ? svc.days : ZONE_TRANSIT_DAYS[zone] || 3;
  const delivery = addBusinessDays(start, businessDays);
  const calDays = calendarDaysBetween(start, delivery);
  const daysInBox = Math.max(1, calDays + PORCH_BUFFER_DAYS);
  const weekendSit = calDays - businessDays;
  const arriveWord = businessDays === 1 ? 'delivers next business day' : `delivers ~${businessDays} business days later`;
  const note =
    `ships ${DOW_NAMES[dow]} ${ymd(start)} -> ${arriveWord} ~${ymd(delivery)} (${svc.label}` +
    (weekendSit > 0 ? `, +${weekendSit}d weekend/holiday sit` : '') +
    `) = ${daysInBox}d in box`;
  const shipDayNote = preferred
    ? null
    : `Heads up: ${DOW_NAMES[dow]} isn't a preferred ship day — Breadwright ships Tue/Wed to avoid weekend warehouse sits.${
        weekendSit > 0 ? ` This one picks up ${weekendSit} extra day(s) of dry-ice burn.` : ''
      }`;
  return { daysInBox, shipDate: ymd(start), deliveryDate: ymd(delivery), businessDays, weekendSit, preferred, shipDayNote, note, service: service || DEFAULT_SERVICE, serviceLabel: svc.label };
}

// --- Weather (Open-Meteo — free, no API key) -------------------------------
const _cache = new Map(); // key -> { at, val }
const CACHE_MS = 6 * 60 * 60 * 1000; // 6h; a batch of orders shares one lookup
function _cacheGet(k) {
  const e = _cache.get(k);
  return e && Date.now() - e.at < CACHE_MS ? e.val : null;
}
function _cacheSet(k, val) {
  _cache.set(k, { at: Date.now(), val });
  return val;
}

/** ZIP -> {lat, lon} via Zippopotam (free, no key). null on failure. */
async function geocodeZip(zip) {
  const z = String(zip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  const ck = 'geo:' + z;
  const hit = _cacheGet(ck);
  if (hit !== null) return hit;
  try {
    const r = await fetch(`https://api.zippopotam.us/us/${z}`);
    if (!r.ok) return _cacheSet(ck, null);
    const j = await r.json();
    const p = j.places && j.places[0];
    if (!p) return _cacheSet(ck, null);
    return _cacheSet(ck, { lat: Number(p.latitude), lon: Number(p.longitude) });
  } catch (e) {
    return _cacheSet(ck, null);
  }
}

/**
 * Highest daily high (F) the box will see between ship and delivery, per the
 * Open-Meteo forecast. Falls back to the season table when the window is beyond
 * the 16-day forecast horizon or the API is unreachable. Always floored at
 * TRUCK_FLOOR_F. @returns { ambientF, source }
 */
async function fetchAmbientHigh({ zip, startDate, endDate, season }) {
  const seasonF = AMBIENT_BY_SEASON[season || DEFAULT_SEASON] || AMBIENT_BY_SEASON.summer;
  const geo = await geocodeZip(zip);
  if (!geo) return { ambientF: Math.max(TRUCK_FLOOR_F, seasonF), source: 'season-fallback (no geocode)' };
  const ck = `wx:${zip}:${startDate}:${endDate}`;
  const hit = _cacheGet(ck);
  if (hit) return hit;
  try {
    const u =
      `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
      `&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=auto` +
      `&start_date=${startDate}&end_date=${endDate}`;
    const r = await fetch(u);
    if (!r.ok) throw new Error('wx ' + r.status);
    const j = await r.json();
    const highs = (j.daily && j.daily.temperature_2m_max || []).filter((n) => typeof n === 'number');
    if (!highs.length) throw new Error('no forecast in window');
    const peak = Math.max(...highs);
    return _cacheSet(ck, { ambientF: Math.max(TRUCK_FLOOR_F, Math.round(peak)), source: `forecast peak ${Math.round(peak)}F` });
  } catch (e) {
    return { ambientF: Math.max(TRUCK_FLOOR_F, seasonF), source: `season-fallback (${e.message})` };
  }
}

/**
 * SYNC core. Turns conditions into blocks of dry ice. Everything the live path
 * resolves (ambientF, days, zone) can be passed in; anything omitted falls back
 * to the zone/season defaults so offline dry-runs still produce a number.
 */
function computeDryIce(opts = {}) {
  const zone = opts.zone || zoneForZip(opts.zip) || 4; // unknown -> worst case
  const days = opts.days != null ? opts.days : ZONE_TRANSIT_DAYS[zone] || 3;
  const season = opts.season || DEFAULT_SEASON;
  const ambientF = opts.ambientF != null ? opts.ambientF : Math.max(TRUCK_FLOOR_F, AMBIENT_BY_SEASON[season] || 90);
  const C = opts.C != null ? opts.C : C_DEFAULT;

  const deltaT = ambientF - T_DRYICE;
  const perDay = C * deltaT;
  const consumed = perDay * days;
  const reserve = Math.max(RESERVE_MIN_LB, perDay * RESERVE_DAYS);
  const totalLbs = consumed + reserve;
  const wantBlocks = Math.max(1, Math.ceil(totalLbs / BLOCK_LB));

  // Carrier + mode by destination (UPS Ground when reachable ≤2 ground days,
  // else Priority Shippers air). Caller may pin it via opts.mode/opts.carrier.
  const shipMode = opts.mode
    ? { mode: opts.mode, carrier: opts.carrier || (opts.mode === 'air' ? 'Priority Shippers' : 'UPS Ground'), declareDryIce: opts.mode === 'air', maxBlocks: opts.mode === 'air' ? AIR_MAX_BLOCKS : null }
    : resolveShipMode(opts.zip, zone);

  // Two ceilings, take the tighter. PHYSICAL: box can't hold more than
  // MAX_BLOCKS_PER_BOX alongside the bread. REGULATORY: AIR shipments (Priority
  // Shippers) are hard-capped at 1 slab / 5 lb by dry-ice air regs (UN1845);
  // GROUND (UPS) carries no regulatory cap. A per-service SERVICE_LEVELS cap, if
  // supplied, still applies and the tighter of the two wins.
  const svc = SERVICE_LEVELS[opts.service] || null;
  const svcCap = svc && svc.maxBlocks != null ? svc.maxBlocks : Infinity;
  const modeCap = shipMode.maxBlocks != null ? shipMode.maxBlocks : Infinity;
  const regCap = Math.min(svcCap, modeCap);
  const effectiveCap = Math.min(MAX_BLOCKS_PER_BOX, regCap);
  const blocks = Math.min(wantBlocks, effectiveCap);
  const physicalCapped = wantBlocks > MAX_BLOCKS_PER_BOX;
  const regCapped = wantBlocks > regCap; // math wanted more than regs allow for this Air service
  const capped = wantBlocks > effectiveCap;
  const zoneKnown = !!(opts.zone || zoneForZip(opts.zip));
  // Label for the cap that bit (air mode, or a specific UPS air service level).
  const capLabel = svc ? svc.label : (shipMode.mode === 'air' ? 'air (Priority Shippers)' : 'this lane');

  return {
    zip: opts.zip,
    zone,
    zoneKnown,
    mode: shipMode.mode, //          'ground' | 'air'
    carrier: shipMode.carrier, //    'UPS Ground' | 'Priority Shippers'
    declareDryIce: shipMode.declareDryIce, // AIR must declare dry ice; ground must not
    groundTransitDays: shipMode.groundTransitDays != null ? shipMode.groundTransitDays : null,
    transitDays: round1(days),
    ambientF,
    ambientSource: opts.ambientSource || null,
    season,
    C,
    calibrated: false, // flip once C is measured from a real shipment
    perDayLbs: round1(perDay),
    consumedLbs: round1(consumed),
    reserveLbs: round1(reserve),
    totalLbs: round1(totalLbs),
    blocks,
    lbs: blocks * BLOCK_LB,
    capped, //                  hit EITHER ceiling (physical or regulatory)
    physicalCapped, //          hit the physical per-box ceiling
    regCapped, //               hit the air-service regulatory dry-ice limit
    regCap: regCap === Infinity ? null : regCap,
    wantBlocks, //              what the math asked for before the cap
    warning: regCapped
      ? `Route wants ${wantBlocks} blocks (${wantBlocks * BLOCK_LB} lb) but ${capLabel} is capped at ${regCap} block${regCap > 1 ? 's' : ''} (${regCap * BLOCK_LB} lb) by dry-ice air regulations (UN1845). Shipping ${blocks} block${blocks > 1 ? 's' : ''} — if that won't hold temp, upgrade insulation or use a faster lane.`
      : physicalCapped
        ? `Route needs ${wantBlocks} blocks (${wantBlocks * BLOCK_LB} lb) — exceeds the ${MAX_BLOCKS_PER_BOX}-block box limit. Expedite, upgrade insulation, or split.`
        : null,
    transitNote: opts.transitNote || null,
    shipDayNote: opts.shipDayNote || null,
    shipDate: opts.shipDate || null,
    deliveryDate: opts.deliveryDate || null,
    line: `${blocks} block${blocks > 1 ? 's' : ''} (${blocks * BLOCK_LB} lb) — Zone ${zone}${
      zoneKnown ? '' : ' (assumed)'
    }, ~${round1(days)}d in box @ ${ambientF}F${capped ? (regCapped ? ' ⚠ air-limit capped' : ' ⚠ box-limit capped') : ''}`,
  };
}

/**
 * ASYNC orchestrator — the real thing the server calls per order. Resolves the
 * live weather + calendar-aware transit, then runs computeDryIce. Never throws:
 * on any lookup failure it degrades to the sync defaults so an order still packs.
 * @param {object} opts { zip, shipDate?, zone?, season?, C? }
 */
async function resolveDryIceConditions(opts = {}) {
  const zone = opts.zone || zoneForZip(opts.zip) || 4;
  const t = businessTransit({ zone, shipDate: opts.shipDate, service: opts.service });
  const wx = await fetchAmbientHigh({
    zip: opts.zip,
    startDate: t.shipDate,
    endDate: t.deliveryDate,
    season: opts.season || seasonForDate(t.shipDate),
  });
  const result = computeDryIce({
    zip: opts.zip,
    zone,
    days: t.daysInBox,
    ambientF: wx.ambientF,
    ambientSource: wx.source,
    transitNote: t.note,
    shipDayNote: t.shipDayNote,
    shipDate: t.shipDate,
    deliveryDate: t.deliveryDate,
    service: t.service, //   carry the service level so the air-regulatory cap applies
    C: opts.C,
  });
  result.service = t.service;
  result.serviceLabel = t.serviceLabel;
  result.address = opts.address || null;
  result.explain = explainDryIce(result);
  return result;
}

/**
 * Plain-English writeup of HOW the number was reached — so a packer (or Sam)
 * sees the reasoning, not just a block count. Built from the computeDryIce
 * result so it always matches the math.
 */
function explainDryIce(r) {
  const parts = [];
  const dest = r.address || (r.zip ? 'ZIP ' + r.zip : 'this address');
  parts.push(
    `Shipping from ${ORIGIN_LABEL} to ${dest} — Zone ${r.zone}${r.zoneKnown ? '' : ' (assumed)'}, via ${r.carrier || r.serviceLabel || 'UPS'}${r.mode === 'air' ? ' (air)' : r.mode === 'ground' ? ' (ground)' : ''}.`
  );
  if (r.declareDryIce) parts.push(`AIR shipment — DECLARE dry ice (check the dry-ice button on Priority Shippers); max 1 slab (5 lb).`);
  else if (r.mode === 'ground') parts.push(`Ground shipment — no dry-ice declaration required.`);
  if (r.transitNote) {
    parts.push(
      `${r.transitNote.charAt(0).toUpperCase() + r.transitNote.slice(1)} — dry ice sublimates every calendar day, even over a weekend when UPS isn't moving the box.`
    );
  } else {
    parts.push(`Assumed about ${r.transitDays} days in the box.`);
  }
  if (r.shipDayNote) parts.push(r.shipDayNote);
  const wx = r.ambientSource && r.ambientSource.startsWith('forecast')
    ? `Destination weather ${r.ambientSource.replace('forecast peak', 'is forecast to peak at')}`
    : `No live forecast for this window, so we assume a seasonal ${r.ambientF}°F`;
  parts.push(`${wx}; we never assume below ${TRUCK_FLOOR_F}°F because trucks and sort hubs run hot.`);
  parts.push(
    `Through 1" Green Cell Foam, dry ice burns off about ${r.perDayLbs} lb/day at ${r.ambientF}°F (insulation constant C=${r.C}).`
  );
  parts.push(
    `Over ~${r.transitDays} days that's ${r.consumedLbs} lb, plus a ${r.reserveLbs} lb reserve so it doesn't arrive empty if delivery slips = ${r.totalLbs} lb.`
  );
  parts.push(
    r.regCapped
      ? `That needs ${r.wantBlocks} blocks, but ${r.serviceLabel || 'this air service'} is limited to ${r.regCap} block${r.regCap > 1 ? 's' : ''} (${r.regCap * BLOCK_LB} lb) per package by dry-ice air regulations (UN1845) — capped at ${r.blocks}. If that won't hold temp, upgrade insulation or use a faster lane.`
      : r.physicalCapped
        ? `That needs ${r.wantBlocks} blocks, but a box only holds ${MAX_BLOCKS_PER_BOX} (${MAX_BLOCKS_PER_BOX * BLOCK_LB} lb) alongside the bread — capped at ${r.blocks}. This route should be expedited, better-insulated, or split.`
        : `Rounded up to 5 lb blocks → ${r.blocks} block${r.blocks > 1 ? 's' : ''} (${r.lbs} lb).`
  );
  return parts.join(' ');
}

function gelPacks(zone) {
  return GEL_PACKS_BASE + (Number(zone) >= 4 ? GEL_PACKS_ZONE4_EXTRA : 0);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

module.exports = {
  T_DRYICE,
  BLOCK_LB,
  MARGIN,
  C_DEFAULT,
  TRUCK_FLOOR_F,
  RESERVE_DAYS,
  ZONE_TRANSIT_DAYS,
  AMBIENT_BY_SEASON,
  UPS_HOLIDAYS_2026,
  FREEZER_PAPER_PER_LOAF,
  zoneForZip,
  resolveShipMode,
  serviceForZip,
  AIR_MAX_BLOCKS,
  businessTransit,
  geocodeZip,
  fetchAmbientHigh,
  seasonForDate,
  nextShipDay,
  addBusinessDays,
  ymd,
  computeDryIce,
  resolveDryIceConditions,
  gelPacks,
};
