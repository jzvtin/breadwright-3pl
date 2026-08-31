/**
 * config/dryiceModel.js
 * ---------------------------------------------------------------------------
 * Breadwright Dry Ice Model — implements BW_Dry_Ice_Build_Spec v0.1 (30 Aug 2026).
 *
 * Given a destination ZIP + ship date + box config, decide for EACH of the four
 * services: slab count, survival vs required hours, and a per-service verdict.
 * Then recommend the cheapest service that survives — or refuse (DO_NOT_SHIP).
 *
 * EVERYTHING here is a NAMED parameter (see PARAMS + CONSTS). Nothing is
 * hardcoded inline, so calibration (§7) moves numbers you can see. All values
 * are v0.1 PLACEHOLDERS until R0 etc. are measured — treat outputs as directional.
 *
 * Store dry ice as WEIGHT and derive slab count (§2). The air cap recomputes from
 * SLAB_LB, so a slab-spec change can never silently break the 1-slab air ceiling.
 *
 * Reuses the live forecast/transit/zone helpers from ./dryice.js so this model and
 * the locked zone-routing rule share one weather + calendar source.
 * ---------------------------------------------------------------------------
 */
const { geocodeZip, zoneForZip, seasonForDate, nextShipDay, addBusinessDays, ymd, TRUCK_FLOOR_F } = require('./dryice');

// --- Fixed constants (spec §2) ---------------------------------------------
const CONSTS = {
  SLAB_LB: 5.0, //           lb per slab — spot-weigh at pack (§7 storage sublimation)
  GEL_COUNT: 2, //           fixed, never varies
  GEL_OZ: 24, //             each; water-based, plateaus at 32F
  PAYLOAD_LB: 9, //          ~6-loaf box; override per box config
  AIR_MAX_SLABS: 1, //       ~5.5 lb/package air limit — 2 slabs cannot fit under it
  GROUND_MAX_SLABS: 2, //    operational, not regulatory
  PULL_TEMP_F: 0, //         CONFIRM WITH ICE CUBE (§7/§10) — measured, not assumed
  // Physical latents (not calibration knobs — real thermodynamics).
  LATENT_CO2_BTU_LB: 246, // dry-ice sublimation enthalpy
  LATENT_ICE_BTU_LB: 144, // water fusion enthalpy (gel packs)
};

// --- Open (calibratable) parameters (spec §5/§10) ---------------------------
// Move THESE when tuning — never nudge R0 until the output looks right.
const PARAMS = {
  TRANSIT_UPLIFT_F: 20, //   trailer/van interiors run hotter than outside air; fit separately from R0
  R0_LB_DAY: 2.5, //         sublimation rate at 70F for THIS box+liner+payload — the one empirical constant (§7)
  K_LB_DAY_PER_10F: 0.5, //  rate sensitivity per 10F above 70
  R_MIN_LB_DAY: 1.0, //      floor so cold lanes don't imply an infinite slab life
  SPECIFIC_HEAT_BTU_LB_F: 0.69, // frozen bread+packaging; ~200 BTU buffer on a 6-loaf box at PULL=0
  DWELL_HRS: 4, //           porch time after the delivery scan — a real thaw vector
  SAFETY_FACTOR: 1.2, //     do NOT target zero coolant at delivery (residual ~20%)
  GEL_EFFECTIVENESS: 1.0, // +1 assumes gel helps; calibration may drive NEGATIVE on long air lanes (§5.4)
};

// --- Services (spec §3) -----------------------------------------------------
// targetDays = the transit days the service PROMISES. Ground codes are only
// achievable if UPS Ground actually reaches the zone in <= targetDays; air codes
// are carrier-guaranteed. costRank orders cheapest-first for the recommendation.
const SERVICES = [
  { code: '2_DAY', carrier: 'UPS Ground', mode: 'ground', targetDays: 2, costRank: 1 },
  { code: '1_DAY', carrier: 'UPS Ground', mode: 'ground', targetDays: 1, costRank: 2 },
  { code: '2_AIR', carrier: 'UPS 2nd Day Air', mode: 'air', targetDays: 2, costRank: 3 },
  { code: '1_AIR', carrier: 'UPS Next Day Air', mode: 'air', targetDays: 1, costRank: 4 },
];
const modeMax = (mode) => (mode === 'air' ? CONSTS.AIR_MAX_SLABS : CONSTS.GROUND_MAX_SLABS);

// zone -> real UPS Ground transit days (mirrors dryice.js groundTransitDays).
const ZONE_GROUND_DAYS = { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 5, 8: 6 };
function groundDays(zone) { return zone == null ? null : (ZONE_GROUND_DAYS[zone] != null ? ZONE_GROUND_DAYS[zone] : null); }

// --- Thermal core (spec §5) -------------------------------------------------
/** Effective ambient: mean forecast across the transit window + trailer uplift. */
function effectiveAmbient(meanForecastF) {
  return meanForecastF + PARAMS.TRANSIT_UPLIFT_F;
}
/** Sublimation rate lb/day at an effective ambient (spec §5.2). */
function sublimationRate(tEffF) {
  const r = PARAMS.R0_LB_DAY + PARAMS.K_LB_DAY_PER_10F * (tEffF - 70) / 10;
  return Math.max(r, PARAMS.R_MIN_LB_DAY);
}
/** BTU/hr heat leak implied by the slab burn rate — one leak feeds slab+buffer+gel. */
function heatLeakRate(rLbDay) {
  return (rLbDay * CONSTS.LATENT_CO2_BTU_LB) / 24;
}
/** Payload buffer hours: frozen bread below 32F is stored cooling (spec §5.3). */
function bufferHrs(leakBtuHr, payloadLb) {
  const btu = payloadLb * PARAMS.SPECIFIC_HEAT_BTU_LB_F * (32 - CONSTS.PULL_TEMP_F);
  return btu / leakBtuHr;
}
/** Gel-pack hours as fixed thermal mass; may be NEGATIVE on long air (spec §5.4). */
function gelHrs(leakBtuHr) {
  const massLb = (CONSTS.GEL_COUNT * CONSTS.GEL_OZ) / 16;
  const btu = PARAMS.GEL_EFFECTIVENESS * massLb * CONSTS.LATENT_ICE_BTU_LB;
  return btu / leakBtuHr;
}
/** Survival hours for a given slab count at a given rate (spec §5.5). */
function survivalHrs(slabs, rLbDay, payloadLb) {
  const leak = heatLeakRate(rLbDay);
  const slabHrs = ((CONSTS.SLAB_LB * slabs) / rLbDay) * 24;
  return slabHrs + bufferHrs(leak, payloadLb) + gelHrs(leak);
}

/**
 * Evaluate ONE service at a given effective ambient + transit (spec §5.6/§6).
 * Finds the MIN slabs (0..mode_max) that survives; if none do, the service is
 * infeasible (upgrade or refuse — never a bigger number than the cap).
 */
function evalService(svc, { tEffF, transitDays, zone, payloadLb }) {
  const rate = sublimationRate(tEffF);
  const requiredHrs = transitDays * 24 + PARAMS.DWELL_HRS;
  const threshold = requiredHrs * PARAMS.SAFETY_FACTOR;

  // Ground codes are only achievable if UPS Ground truly reaches the zone in time.
  const gd = groundDays(zone);
  const timeOk = svc.mode === 'air' ? true : (gd != null && gd <= svc.targetDays);

  const max = modeMax(svc.mode);
  let feasibleSlabs = null;
  for (let n = 0; n <= max; n++) {
    if (survivalHrs(n, rate, payloadLb) >= threshold) { feasibleSlabs = n; break; }
  }
  const feasible = timeOk && feasibleSlabs != null;
  const slabs = feasibleSlabs != null ? feasibleSlabs : max; // report the best we could do
  return {
    code: svc.code, carrier: svc.carrier, mode: svc.mode, costRank: svc.costRank,
    transitDays, timeOk, rateLbDay: round1(rate),
    slabs, slabLb: round1(slabs * CONSTS.SLAB_LB),
    survivalHrs: round1(survivalHrs(slabs, rate, payloadLb)),
    requiredHrs: round1(requiredHrs), thresholdHrs: round1(threshold),
    feasible,
    declareDryIce: svc.mode === 'air' && slabs > 0, //  UN1845 air declaration
    placardsRequired: slabs > 0, //                     §9 gap fix — driven by slabs
    reason: !timeOk
      ? `ground can't reach zone ${zone == null ? '?' : zone} in ${svc.targetDays} day(s)`
      : feasible ? `survives ${round1(survivalHrs(slabs, rate, payloadLb))}h >= ${round1(threshold)}h needed`
      : `max ${max} slab(s) only lasts ${round1(survivalHrs(max, rate, payloadLb))}h < ${round1(threshold)}h needed`,
  };
}

/**
 * Full decision (spec §6). Async: pulls the mean forecast across the transit
 * window (climate-normals fallback beyond the horizon; records which source).
 * @param {object} o { zip, shipDate?, payloadLb?, butter? }
 * @returns { shipDay, dest, tempUsedF, tempSource, services:[verdict...],
 *            recommended|null, verdict:'ship'|'upgrade'|'do_not_ship', packListLine }
 */
async function evaluate(o = {}) {
  const zip = String(o.zip || '').trim();
  const zone = zoneForZip(zip);
  // Ship day is an OUTPUT (Tue/Wed), not an input (spec §6).
  const shipDate = o.shipDate ? new Date(o.shipDate + 'T00:00:00Z') : nextShipDay(new Date());
  const shipDay = ymd(shipDate);
  const payloadLb = o.payloadLb != null ? o.payloadLb : (CONSTS.PAYLOAD_LB + (o.butter ? 1 : 0));

  // Longest transit window across services = 2 business days; forecast that span.
  const deliveryMax = addBusinessDays(shipDate, 2);
  const wx = await meanForecast({ zip, startDate: shipDay, endDate: ymd(deliveryMax), season: seasonForDate(shipDay) });
  const tEffF = effectiveAmbient(wx.meanF);

  const services = SERVICES.map((svc) => {
    const transitDays = svc.mode === 'air' ? svc.targetDays : (groundDays(zone) || svc.targetDays);
    return evalService(svc, { tEffF, transitDays, zone, payloadLb });
  });

  // Recommend the cheapest FEASIBLE service (spec §6.1). Show all four regardless.
  const feasibleSorted = services.filter((s) => s.feasible).sort((a, b) => a.costRank - b.costRank);
  const recommended = feasibleSorted[0] || null;
  const anyGroundFeasible = feasibleSorted.some((s) => s.mode === 'ground');
  const verdict = recommended ? (recommended.mode === 'air' && !anyGroundFeasible ? 'upgrade' : 'ship') : 'do_not_ship';

  return {
    shipDay, dest: zip, zone,
    tempUsedF: Math.round(wx.meanF), tEffF: Math.round(tEffF), tempSource: wx.source,
    payloadLb, services, recommended, verdict,
    packListLine: recommended ? packListLine({ shipDay, dest: zip, tempUsedF: Math.round(wx.meanF), tempSource: wx.source, svc: recommended })
      : `DO NOT SHIP — no service keeps ${payloadLb}lb frozen to ${zip} (ship ${shipDay}, ambient ${Math.round(tEffF)}°F eff). Upgrade lane or hold.`,
  };
}

/** Pack-list result + reasoning block (spec §8). Whole pack units only. */
function packListLine({ shipDay, dest, tempUsedF, tempSource, svc }) {
  const residual = Math.round((PARAMS.SAFETY_FACTOR - 1) * 100);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(shipDay + 'T00:00:00Z').getUTCDay()];
  const slabTxt = svc.slabs === 0 ? 'NONE (gel packs only)' : `${svc.slabs} × ${CONSTS.SLAB_LB} LB SLAB`;
  return (
    `DRY ICE: ${slabTxt}   SERVICE: ${svc.code}\n` +
    `Transit ${svc.transitDays} day(s) · Ship ${dow} · Dest ${dest}\n` +
    `Temp used ${tempUsedF}°F (${tempSource}) · Dwell ${PARAMS.DWELL_HRS} hr · Residual target ${residual}%` +
    (svc.declareDryIce ? `\nDECLARE DRY ICE (UN1845) — placard required` : '')
  );
}

// --- Weather: MEAN daily-high across the transit window (spec §4/§5.1) -------
// Differs from dryice.js fetchAmbientHigh (which takes the PEAK): the model wants
// the mean across every transit day. Climate-normals fallback beyond the ~16-day
// forecast horizon or on API failure; records source. Never throws.
async function meanForecast({ zip, startDate, endDate, season }) {
  const seasonF = seasonHigh(season);
  try {
    const geo = await geocodeZip(zip);
    if (!geo) return { meanF: seasonF, source: 'climate-normals (no geocode)' };
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
      `&daily=temperature_2m_max&temperature_unit=fahrenheit&timezone=auto&start_date=${startDate}&end_date=${endDate}`;
    const highs = await getJsonHighs(url);
    if (!highs.length) throw new Error('beyond forecast horizon');
    const mean = highs.reduce((a, b) => a + b, 0) / highs.length;
    return { meanF: Math.round(mean), source: `forecast (${highs.length}d mean)` };
  } catch (e) {
    return { meanF: seasonF, source: `climate-normals (${e.message})` };
  }
}
function seasonHigh(season) {
  const T = { summer: 90, shoulder: 72, winter: 50 };
  return T[season] != null ? T[season] : 78;
}
function getJsonHighs(url) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const arr = (j.daily && j.daily.temperature_2m_max) || [];
          resolve(arr.filter((x) => x != null));
        } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('weather timeout')));
  });
}

function round1(n) { return Math.round(n * 10) / 10; }

module.exports = {
  evaluate, evalService, packListLine, meanForecast,
  sublimationRate, survivalHrs, effectiveAmbient, bufferHrs, gelHrs, heatLeakRate,
  CONSTS, PARAMS, SERVICES, groundDays,
};
