// Build the local parcel index for Liberty County from the Florida Department
// of Revenue's assessment roll (the NAL file — Name, Address, Legal).
//
// Why a local file instead of a live service: the statewide cadastral feature
// service holds 10.8 million parcels and is not indexed by county, so a Liberty
// County query either times out or is refused. Liberty's whole roll is 6,000
// records, so the county's own slice is small enough to ship with the app and
// answer instantly, offline, with no third-party dependency at the counter.
//
// Refresh once a year, after the Property Appraiser certifies the roll:
//   1. Open https://floridarevenue.com/property/dataportal/Pages/default.aspx
//        ?path=/property/dataportal/Documents/PTO Data Portal/Tax Roll Data Files
//   2. NAL -> the newest year folder -> "Liberty 49 ... NAL <year>.zip"
//      (the F folders are final rolls, P are preliminary)
//   3. Unzip it and run:  node scripts/build-parcels.js <path to NAL49...csv>
//
// The roll is a snapshot of ownership and improvements as of January 1 of its
// assessment year. It is not zoning, not the future land use map, and not live
// — those come from the Property Appraiser and the county's own maps.
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const OUT = path.join(REPO, 'data', 'parcels.json');
const src = process.argv[2];
if (!src || !fs.existsSync(src)) {
  console.error('usage: node scripts/build-parcels.js <NAL csv>');
  process.exit(1);
}

// The NAL is a plain comma-delimited file with quoted fields.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const rows = parseCsv(fs.readFileSync(src, 'utf8'));
const header = rows.shift().map(h => h.trim());
const col = {};
header.forEach((h, i) => col[h] = i);

const str = (r, name) => (col[name] === undefined ? '' : (r[col[name]] || '').trim());
const num = (r, name) => {
  const v = Number(str(r, name).replace(/,/g, ''));
  return Number.isFinite(v) ? v : 0;
};

// Parcel numbers get written down with and without dashes, so every record
// carries a normalised key and lookups are normalised the same way.
const normalise = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Acreage has to be cross-checked rather than trusted to one field. The roll
// carries it twice: LND_SQFOOT, and NO_LND_UNTS which is stored times 100 when
// the land unit code is 1 (acres). They usually agree, but a handful of records
// have a typo in one of them — one timber tract reads 273,250 acres in square
// feet where the legal description and the unit count both say 273.25. The
// legal description is used as the tie-breaker, and anything still in doubt is
// flagged so the assistant tells staff to confirm it rather than stating it.
function acreageOf(r) {
  const sqftAcres = num(r, 'LND_SQFOOT') / 43560;
  const unitsCode = str(r, 'LND_UNTS_CD');
  const unitAcres = unitsCode === '1' ? num(r, 'NO_LND_UNTS') / 100 : 0;
  const m = str(r, 'S_LEGAL').match(/(\d+(?:\.\d+)?)\s*AC\b/i);
  const legalAcres = m ? Number(m[1]) : 0;

  const candidates = [sqftAcres, unitAcres].filter(a => a > 0);
  if (!candidates.length) return { acres: 0, doubt: false };
  if (candidates.length === 1) return { acres: candidates[0], doubt: false };

  const disagree = Math.abs(candidates[0] - candidates[1]) / Math.max(...candidates) > 0.10;
  let acres = unitAcres;                       // the unit count is the tidier field
  if (legalAcres > 0) {                        // but the legal description decides
    acres = candidates.reduce((best, c) =>
      Math.abs(c - legalAcres) < Math.abs(best - legalAcres) ? c : best, candidates[0]);
  }
  return { acres, doubt: disagree };
}

const parcels = [];
let skipped = 0;
for (const r of rows) {
  const id = str(r, 'PARCEL_ID');
  if (!id) { skipped++; continue; }
  const sqft = num(r, 'LND_SQFOOT');
  const land = acreageOf(r);
  const p = {
    id,
    key: normalise(id),
    uc: str(r, 'DOR_UC'),
    puc: str(r, 'PA_UC'),
    own: str(r, 'OWN_NAME'),
    oad: [str(r, 'OWN_ADDR1'), str(r, 'OWN_ADDR2')].filter(Boolean).join(' '),
    oci: str(r, 'OWN_CITY'),
    ost: str(r, 'OWN_STATE'),
    ozp: str(r, 'OWN_ZIPCD'),
    adr: [str(r, 'PHY_ADDR1'), str(r, 'PHY_ADDR2')].filter(Boolean).join(' '),
    cty: str(r, 'PHY_CITY'),
    zip: str(r, 'PHY_ZIPCD'),
    leg: str(r, 'S_LEGAL'),
    sqft,
    acres: Math.round(land.acres * 100) / 100,
    chk: land.doubt ? 1 : 0,          // acreage fields disagree — have staff confirm
    liv: num(r, 'TOT_LVG_AREA'),
    bld: num(r, 'NO_BULDNG'),
    res: num(r, 'NO_RES_UNTS'),
    yr: num(r, 'ACT_YR_BLT'),
    jv: num(r, 'JV'),
    lv: num(r, 'LND_VAL'),
    hs: num(r, 'JV_HMSTD') > 0 || num(r, 'EXMPT_01') > 0 ? 1 : 0,
    twn: str(r, 'TWN'),
    rng: str(r, 'RNG'),
    sec: str(r, 'SEC'),
    splt: str(r, 'PAR_SPLT'),
    alt: str(r, 'ALT_KEY'),
    syr: num(r, 'SALE_YR1'),
    smo: num(r, 'SALE_MO1'),
    spr: num(r, 'SALE_PRC1'),
    bk: str(r, 'OR_BOOK1'),
    pg: str(r, 'OR_PAGE1'),
  };
  // Drop empty strings so the file stays small.
  for (const k of Object.keys(p)) if (p[k] === '' || p[k] === 0) delete p[k];
  p.id = id; p.key = normalise(id);
  parcels.push(p);
}

const asmntYr = str(rows[0] || [], 'ASMNT_YR') || (header.includes('ASMNT_YR') ? '' : '');
const out = {
  county: 'Liberty',
  countyNo: 49,
  source: path.basename(src),
  assessmentYear: asmntYr,
  built: new Date().toISOString().slice(0, 10),
  count: parcels.length,
  parcels,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);

console.log(`${parcels.length} parcels (${skipped} skipped) -> ${OUT}  ${kb} KB`);
console.log(`assessment year ${out.assessmentYear}, source ${out.source}`);
const withBldg = parcels.filter(p => p.bld).length;
const homestead = parcels.filter(p => p.hs).length;
const acres = parcels.reduce((a, p) => a + (p.acres || 0), 0);
console.log(`with buildings: ${withBldg} | homestead: ${homestead} | total acreage: ${acres.toFixed(0)}`);
const byUse = {};
parcels.forEach(p => { const k = (p.uc || '??').padStart(2, '0').slice(-2); byUse[k] = (byUse[k] || 0) + 1; });
console.log('top use codes:', Object.entries(byUse).sort((a, b) => b[1] - a[1]).slice(0, 8)
  .map(([k, v]) => `${k}:${v}`).join(' '));
