// Future land use by parcel — measured, not guessed.
//
// The tax roll does not carry the future land use category, and until now
// staff read it off the PDF map by eye. This overlays the state's parcel lines
// on the statewide future land use layer and measures how many acres of each
// parcel fall in each category.
//
// Where the data comes from:
//   - Future land use: UF GeoPlan statewide layer (2020, Level 2). Liberty
//     County's piece of it is the Apalachee Regional Planning Council's copy of
//     the adopted map, dated 2019. Map amendments since then are not in it.
//   - Parcel lines: Florida DOR statewide parcels (2023), served by FDACS.
//   - Section lines: BLM PLSS, used only to find where a parcel is so the
//     parcel query can be a small spatial one (attribute queries on the FDACS
//     service time out).
// Areas are measured in Florida Albers (EPSG 3087), an equal-area projection.
//
// HOW SURE IS THE ANSWER? Every result carries a confidence of High, Medium
// or Low with the reasons in plain words. The main test is a boundary shift:
// land use lines on a county map are drawn at a scale where a line can sit
// 100 feet off, so the land use layer is moved 100 feet north, south, east and
// west and the acres measured again. If the answer barely moves, the parcel is
// well inside one category and the answer is solid. If acres swing a lot, the
// parcel sits on a line and someone should look at the adopted map.

const pc = require('polygon-clipping');

const BLM = 'https://gis.blm.gov/arcgis/rest/services/Cadastral/BLM_Natl_PLSS_CadNSDI/MapServer/2/query';
const PARCELS = 'https://gis.fdacs.gov/mapping/rest/services/GIO_Parcels_for_OAWP_Optimized/FeatureServer/0/query';
const FLU = 'https://leo.at.geoplan.ufl.edu/arcgis/rest/services/geoplan/flu_l2_2020_jdx/FeatureServer/0/query';
const SQM_PER_ACRE = 4046.8564224;
const CO_NO = 49;                // Liberty County's DOR number
const MAX_PARCELS = 25;
const SHIFT_M = 30.48;           // 100 feet, the boundary-shift test
const SLIVER_SQM = 400;          // pieces under ~0.1 acre are line noise

const SOURCES = {
  future_land_use: 'UF GeoPlan Center statewide Future Land Use 2020 (Level 2); Liberty County portion from the Apalachee Regional Planning Council copy of the adopted map (2019)',
  parcels: 'Florida Dept. of Revenue statewide parcel lines (2023), as served by FDACS',
  sections: 'BLM PLSS section lines, used only to locate the parcels',
  projection: 'Areas measured in Florida Albers equal-area (EPSG 3087)',
};
const NOTES = [
  'GIS acres come from mapped lines and will not match deeded acres exactly. Apply the percentages to deeded acres.',
  'The GIS land use layer is the 2019 regional planning council copy of the adopted map. Confirm against the current adopted Future Land Use Map for any amendments since then.',
  'This is a planning estimate, not a survey.',
];

// GeoPlan's statewide names, mapped to the names on Liberty County's map.
const NAMES = {
  'AGRICULTURE': 'Agriculture',
  'CONSERVATION': 'Open Space/Conservation',
  'INDUSTRIAL': 'Industrial',
  'INSTITUTIONAL': 'Institutional',
  'MIXED USE - RURAL': 'Mixed Use Rural Residential',
  'MIXED USE - GENERAL': 'Mixed Use (Suburban Residential or Rural Village - check map)',
};

// ── helpers ─────────────────────────────────────────────────────────
async function arc(url, params, timeoutMs = 60000) {
  const host = new URL(url).host;
  let r;
  try {
    r = await fetch(url, {
      method: 'POST',
      body: new URLSearchParams({ ...params, f: 'json' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`${host} did not answer (${e && e.name === 'TimeoutError' ? 'timed out' : (e && e.message) || e})`);
  }
  if (!r.ok) throw new Error(`${host} returned ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${host}: ${j.error.message || 'query failed'}`);
  return j;
}

// Liberty parcel numbers carry their section, township and range:
// 005-3S-8W-02681-000 is section 5, township 3S, range 8W.
function parseId(raw) {
  const s = String(raw).toUpperCase().replace(/[^0-9A-Z]/g, '');
  const m = s.match(/^(\d{3})(\d{1,2})([NS])(\d{1,2})([EW])(\d{5})(\d{3})$/);
  if (!m) return null;
  const [, sec, t, td, r, rd, num, sub] = m;
  return {
    input: String(raw).trim(),
    key: `${sec}${+t}${td}${+r}${rd}${num}${sub}`,
    display: `${sec}-${+t}${td}-${+r}${rd}-${num}-${sub}`,
    sec: +sec, twp: +t, tdir: td, rng: +r, rdir: rd,
  };
}
const normKey = (s) => {
  const p = parseId(s || '');
  return p ? p.key : String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
};

function ringsBBox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a / 2);
}
const multiArea = (m) => m.reduce((s, poly) => s + ringArea(poly[0]) - poly.slice(1).reduce((h, r) => h + ringArea(r), 0), 0);

// Esri rings use even-odd fill, so XOR-ing them together gives real polygons.
function esriToMulti(rings) {
  const clean = (rings || []).filter((r) => r.length >= 4);
  if (!clean.length) return [];
  if (clean.length === 1) return [[clean[0]]];
  return pc.xor([[clean[0]]], ...clean.slice(1).map((r) => [[r]]));
}
const rectPoly = (b) => [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]];
const shift = (m, dx, dy) => m.map((p) => p.map((r) => r.map(([x, y]) => [x + dx, y + dy])));
const r1 = (n) => Math.round(n * 10) / 10;
const roundMulti = (m) => m.map((p) => p.map((r) => r.map(([x, y]) => [r1(x), r1(y)])));
const ac = (sqm) => +(sqm / SQM_PER_ACRE).toFixed(1);
const safeIntersect = (a, b) => { try { return pc.intersection(a, b); } catch { return []; } };

// ── lookups ─────────────────────────────────────────────────────────
const secCache = new Map();
async function sectionEnvelope(p) {
  const plss = `FL29${String(p.twp).padStart(3, '0')}0${p.tdir}${String(p.rng).padStart(3, '0')}0${p.rdir}0`;
  const k = `${plss}|${p.sec}`;
  if (secCache.has(k)) return secCache.get(k);
  const a = String(p.sec).padStart(2, '0'), b = String(p.sec);
  const j = await arc(BLM, {
    where: `PLSSID='${plss}' AND FRSTDIVNO IN ('${a}','${b}')`,
    outFields: 'FRSTDIVNO', returnGeometry: 'true', outSR: '3087',
  }, 40000);
  const rings = (j.features || []).flatMap((f) => (f.geometry && f.geometry.rings) || []);
  const env = rings.length ? ringsBBox(rings) : null;
  secCache.set(k, env);
  return env;
}

async function parcelsInEnvelope(env) {
  const pad = 600; // parcels often run past the section line
  const j = await arc(PARCELS, {
    geometry: [env[0] - pad, env[1] - pad, env[2] + pad, env[3] + pad].join(','),
    geometryType: 'esriGeometryEnvelope', inSR: '3087', spatialRel: 'esriSpatialRelIntersects',
    where: `CO_NO=${CO_NO}`, outFields: 'PARCEL_ID,OWN_NAME,DOR_UC',
    returnGeometry: 'true', outSR: '3087',
  });
  return j.features || [];
}
async function parcelById(p) {
  const j = await arc(PARCELS, {
    where: `CO_NO=${CO_NO} AND PARCEL_ID='${p.key}'`,
    outFields: 'PARCEL_ID,OWN_NAME,DOR_UC', returnGeometry: 'true', outSR: '3087',
  }, 45000);
  return j.features || [];
}

// ── confidence ──────────────────────────────────────────────────────
const RANK = { High: 3, Medium: 2, Low: 1 };
function rate({ areaSqm, cats, swingSqm, noneSqm }) {
  const reasons = [];
  const swingPct = areaSqm ? (swingSqm / areaSqm) * 100 : 0;
  const nonePct = areaSqm ? (noneSqm / areaSqm) * 100 : 0;
  const real = cats.filter((c) => c.sqm >= SQM_PER_ACRE);   // categories with at least an acre
  let level = 'High';
  const lower = (to) => { if (RANK[to] < RANK[level]) level = to; };

  if (real.length <= 1) {
    reasons.push(swingPct < 2
      ? 'The whole parcel sits inside one land use area, well away from any line.'
      : 'The parcel sits in one land use area, but close to a line.');
  } else {
    reasons.push(`A land use line runs through the parcel, splitting it ${real.length} ways.`);
    const small = real.filter((c) => c.sqm < 10 * SQM_PER_ACRE);
    if (small.length) reasons.push(`The smaller piece (${small.map((c) => `${ac(c.sqm)} ac ${c.name}`).join(', ')}) is under 10 acres, so the Comprehensive Plan's boundary rule (Policy 1-2) may read the whole parcel as one category. Check the adopted map.`);
  }

  if (swingPct >= 10) { lower('Low'); reasons.push(`Moving the land use lines 100 feet changes the split by about ${ac(swingSqm)} acres (${swingPct.toFixed(0)}% of the parcel).`); }
  else if (swingPct >= 2) { lower('Medium'); reasons.push(`Moving the land use lines 100 feet changes the split by about ${ac(swingSqm)} acres (${swingPct.toFixed(1)}% of the parcel).`); }
  else if (real.length > 1) reasons.push(`Moving the land use lines 100 feet changes the split by under ${Math.max(0.1, ac(swingSqm))} acres, so the split itself is stable.`);

  if (nonePct >= 10) { lower('Low'); reasons.push(`${ac(noneSqm)} acres (${nonePct.toFixed(0)}%) have no land use in the GIS layer, usually water or a gap at the map edge.`); }
  else if (nonePct >= 2) { lower('Medium'); reasons.push(`${ac(noneSqm)} acres (${nonePct.toFixed(1)}%) have no land use in the GIS layer.`); }

  if (cats.some((c) => /check map/i.test(c.name))) { lower('Medium'); reasons.push('The GIS layer lumps Mixed Use Suburban Residential and Rural Village together, so the exact category needs the adopted map.'); }
  return { level, reasons, swing_acres: ac(swingSqm), swing_pct: +swingPct.toFixed(1) };
}

// ── main ────────────────────────────────────────────────────────────
async function lookup(rawIds, deeded, withMap = false) {
  const seen = new Set();
  const ids = [];
  const invalid = [];
  for (const raw of rawIds.map((s) => String(s).trim()).filter(Boolean)) {
    const p = parseId(raw);
    if (!p) { invalid.push(raw); continue; }
    if (!seen.has(p.key)) { seen.add(p.key); ids.push(p); }
  }
  if (!ids.length) throw Object.assign(new Error(invalid.length
    ? `These don't look like Liberty County parcel numbers: ${invalid.join(', ')}. Use the qPublic format, like 005-3S-8W-02681-000.`
    : 'Enter at least one parcel number.'), { status: 400 });
  if (ids.length > MAX_PARCELS) throw Object.assign(new Error(`Up to ${MAX_PARCELS} parcels at a time.`), { status: 400 });

  // 1) parcel lines: one spatial query per section
  const bySec = new Map();
  for (const p of ids) {
    const k = `${p.sec}-${p.twp}${p.tdir}-${p.rng}${p.rdir}`;
    bySec.set(k, [...(bySec.get(k) || []), p]);
  }
  const found = new Map();
  await Promise.all([...bySec.values()].map(async (group) => {
    let feats = [];
    try {
      const env = await sectionEnvelope(group[0]);
      if (env) feats = await parcelsInEnvelope(env);
    } catch { /* fall through to the direct lookup */ }
    for (const p of group) {
      let mine = feats.filter((f) => normKey(f.attributes && f.attributes.PARCEL_ID) === p.key && f.geometry && f.geometry.rings);
      if (!mine.length) {
        try { mine = (await parcelById(p)).filter((f) => f.geometry && f.geometry.rings); } catch { /* not found */ }
      }
      if (mine.length) found.set(p.key, mine);
    }
  }));

  const notFound = ids.filter((p) => !found.has(p.key)).map((p) => p.display);
  const okIds = ids.filter((p) => found.has(p.key));
  if (!okIds.length) throw Object.assign(new Error(
    `Couldn't find parcel lines for ${notFound.join(', ')}. Check the numbers against qPublic.`), { status: 404 });

  const parcelGeoms = new Map();
  for (const p of okIds) {
    const parts = found.get(p.key).map((f) => esriToMulti(f.geometry.rings));
    parcelGeoms.set(p.key, parts.length === 1 ? parts[0] : pc.union(parts[0], ...parts.slice(1)));
  }

  // 2) land use polygons over the whole area, padded for the shift test
  const allBox = ringsBBox([...parcelGeoms.values()].flatMap((m) => m.flatMap((p) => p)));
  const box = [allBox[0] - 100, allBox[1] - 100, allBox[2] + 100, allBox[3] + 100];
  const fj = await arc(FLU, {
    geometry: box.join(','), geometryType: 'esriGeometryEnvelope', inSR: '3087',
    spatialRel: 'esriSpatialRelIntersects', where: '1=1',
    outFields: 'DESCRIPT,FLU_L2_DESC,JURISDICT', returnGeometry: 'true', outSR: '3087',
  });
  const boxPoly = rectPoly(box);
  const label = (name, jur) =>
    !jur || /LIBERTY COUNTY/i.test(jur) ? name : `${name} (${jur.replace(/\b(\w)(\w*)/g, (_, a, b) => a + b.toLowerCase())})`;
  const flu = (fj.features || []).filter((f) => f.geometry && f.geometry.rings && f.geometry.rings.length).map((f) => {
    const gisName = String(f.attributes.DESCRIPT || f.attributes.FLU_L2_DESC || 'UNKNOWN').trim();
    const jur = String(f.attributes.JURISDICT || '').trim();
    const name = NAMES[gisName] || gisName.charAt(0) + gisName.slice(1).toLowerCase();
    return { gisName, key: label(name, jur), geom: safeIntersect(esriToMulti(f.geometry.rings), boxPoly) };
  });
  const SHIFTS = [[SHIFT_M, 0], [-SHIFT_M, 0], [0, SHIFT_M], [0, -SHIFT_M]];
  const shifted = SHIFTS.map(([dx, dy]) => flu.map((f) => ({ ...f, geom: shift(f.geom, dx, dy) })));

  const measure = (g, layer, keepPieces) => {
    const cats = new Map();
    const pieces = [];
    for (const f of layer) {
      const inter = safeIntersect(g, f.geom);
      const a = multiArea(inter);
      if (a < SLIVER_SQM) continue;
      const c = cats.get(f.key) || { name: f.key, gis_name: f.gisName, sqm: 0 };
      c.sqm += a; cats.set(f.key, c);
      if (keepPieces) pieces.push({ cat: f.key, rings: roundMulti(inter) });
    }
    return { cats, pieces };
  };

  // 3) measure, then measure again with the lines moved
  const totals = new Map();
  let totalSqm = 0, totalUn = 0;
  const pieces = [];
  let worst = 'High';
  const parcelsOut = okIds.map((p) => {
    const g = parcelGeoms.get(p.key);
    const area = multiArea(g);
    const base = measure(g, flu, withMap);
    if (withMap) pieces.push(...base.pieces);
    const runs = shifted.map((layer) => measure(g, layer, false).cats);
    const names = new Set([...base.cats.keys(), ...runs.flatMap((m) => [...m.keys()])]);
    let swing = 0;
    const range = {};
    for (const n of names) {
      const vals = [base.cats.get(n), ...runs.map((m) => m.get(n))].map((c) => (c ? c.sqm : 0));
      const lo = Math.min(...vals), hi = Math.max(...vals);
      range[n] = [ac(lo), ac(hi)];
      swing = Math.max(swing, ...vals.map((v) => Math.abs(v - vals[0])));
    }
    const catList = [...base.cats.values()].sort((a, b) => b.sqm - a.sqm);
    const designated = catList.reduce((s, c) => s + c.sqm, 0);
    const un = Math.max(0, area - designated);
    totalSqm += area; totalUn += un;
    for (const c of catList) {
      const t = totals.get(c.name) || { ...c, sqm: 0 };
      t.sqm += c.sqm; totals.set(c.name, t);
    }
    const confidence = rate({ areaSqm: area, cats: catList, swingSqm: swing, noneSqm: un });
    if (RANK[confidence.level] < RANK[worst]) worst = confidence.level;
    const f0 = found.get(p.key)[0].attributes;
    return {
      parcel_id: p.display,
      owner: f0.OWN_NAME || null,
      pieces: found.get(p.key).length,
      gis_acres: ac(area),
      land_use: catList.map((c) => ({
        name: c.name, gis_name: c.gis_name, acres: ac(c.sqm),
        pct_of_parcel: +((c.sqm / area) * 100).toFixed(1),
        range_if_lines_off_100ft: range[c.name],
      })),
      no_designation_acres: ac(un),
      confidence,
    };
  });

  const designatedSqm = [...totals.values()].reduce((s, c) => s + c.sqm, 0);
  const totalList = [...totals.values()].sort((a, b) => b.sqm - a.sqm).map((c) => ({
    name: c.name, gis_name: c.gis_name,
    acres: ac(c.sqm),
    pct_of_designated: designatedSqm ? +((c.sqm / designatedSqm) * 100).toFixed(1) : 0,
  }));

  let deededOut = null;
  if (deeded && deeded > 0) {
    const gisAc = totalSqm / SQM_PER_ACRE;
    const diffPct = Math.abs(gisAc - deeded) / deeded * 100;
    deededOut = {
      acres: deeded,
      method: "Deeded acres split by each category's share of the designated GIS acres",
      split: totalList.map((c) => ({ name: c.name, acres: Math.round((deeded * c.pct_of_designated) / 100) })),
      gis_vs_deeded_pct: +diffPct.toFixed(1),
    };
    if (diffPct >= 10) {
      worst = RANK[worst] > RANK.Medium ? 'Medium' : worst;
      if (diffPct >= 25) worst = 'Low';
    }
  }

  // overall: the weakest parcel decides it, with the reasons gathered up
  const overallReasons = [];
  parcelsOut.forEach((p) => { if (p.confidence.level !== 'High' || parcelsOut.length === 1) overallReasons.push(`${p.parcel_id}: ${p.confidence.level}. ${p.confidence.reasons.join(' ')}`); });
  if (parcelsOut.length > 1 && parcelsOut.every((p) => p.confidence.level === 'High')) overallReasons.push('Every parcel sits well inside its land use areas.');
  if (deededOut && deededOut.gis_vs_deeded_pct >= 10) overallReasons.push(`The mapped parcel lines total ${deededOut.gis_vs_deeded_pct}% different from the deeded acres, so the parcel lines themselves may be off.`);
  overallReasons.push('The land use layer is the 2019 copy of the adopted map; any amendment since then is not in it.');

  const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const n = okIds.length;
  let summary = `${n === 1 ? 'This parcel totals' : `These ${n} parcels total`} ${fmt(totalSqm / SQM_PER_ACRE)} GIS acres. ` +
    totalList.map((c) => `${c.name}: ${fmt(c.acres)} acres (${c.pct_of_designated}% of designated land)`).join('; ') + '.';
  if (totalUn / SQM_PER_ACRE >= 0.5) summary += ` ${fmt(totalUn / SQM_PER_ACRE)} acres have no designation in the GIS layer.`;
  if (deededOut) summary += ` Applied to ${deeded.toLocaleString('en-US')} deeded acres: ` +
    deededOut.split.map((s) => `${s.name} about ${s.acres.toLocaleString('en-US')} acres`).join(', ') + '.';
  summary += ` Confidence: ${worst}.`;
  if (notFound.length) summary += ` Not found: ${notFound.join(', ')}.`;

  const out = {
    ok: true,
    county: 'Liberty County, FL',
    summary,
    confidence: { level: worst, reasons: overallReasons, test: 'Land use lines moved 100 feet north, south, east and west and the acres measured again' },
    parcels: parcelsOut,
    totals: { gis_acres: ac(totalSqm), land_use: totalList, no_designation_acres: ac(totalUn) },
    deeded: deededOut,
    not_found: notFound,
    invalid,
    sources: SOURCES,
    notes: NOTES,
  };
  if (withMap) {
    out.map = {
      parcels: okIds.map((p) => ({ parcel_id: p.display, rings: roundMulti(parcelGeoms.get(p.key)) })),
      pieces,
    };
  }
  return out;
}

module.exports = { lookup, parseId, _test: { esriToMulti, multiArea, rate } };
