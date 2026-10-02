// Build a searchable passage index from the county's reference documents.
// Each passage keeps the heading it sits under and the PDF page it came from,
// so the assistant can cite "Land Development Code — Section 5.7, page 110".
//
// Run it after any document in public/docs changes:
//     npm install --no-save pdf-parse
//     node scripts/build-index.js
// pdf-parse is deliberately NOT a dependency of the app — it is only needed to
// rebuild public/docs/reference-index.json, which is committed, and keeping it
// out of package.json keeps it out of the deploy build.
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.mjs');

const DOCS = __dirname.replace(/\\/g, '/').replace(/\/scripts$/, '') + '/public/docs';
const OUT = DOCS + '/reference-index.json';
const PZ = 'S:/BOCC/County Departments/Building Department/Planning and Zoning';

// The department's own documents are indexed from the PDFs this app already
// serves, so a passage can never drift from the file a reader opens. The code
// and the plan come from the county's copies in Planning & Zoning.
const SOURCES = [
  { file: `${PZ}/LIBERTY-COUNTY-Land-Development-Code 2017.pdf`, source: 'Land Development Code' },
  { file: `${PZ}/Liberty-County-2012-2025-Comp-Plan.pdf`,        source: 'Comprehensive Plan' },
  { file: `${DOCS}/2026-fee-schedule.pdf`,                       source: '2026 Fee Schedule' },
  { file: `${DOCS}/building-department-guide.pdf`,               source: 'Building Guide' },
  { file: `${DOCS}/permit-eligibility-guide-2026.pdf`,           source: 'Permit Eligibility Guide' },
  { file: `${DOCS}/permit-coverage-reference.pdf`,               source: 'Permit Coverage Reference' },
  { file: `${DOCS}/permit-exemption-quick-reference.pdf`,        source: 'Permit Exemption Quick Reference' },
  { file: `${DOCS}/planning-zoning-flow-chart.pdf`,              source: 'Planning & Zoning Flow Chart' },
  { file: `${DOCS}/written-request-for-exemption-hb803.pdf`,     source: 'Exemption Form' },
  { file: `${DOCS}/building-fee-resolution-2026.pdf`,            source: 'Fee Resolution 2026' },
  { file: `${DOCS}/dbpr-license-abbreviations.pdf`,              source: 'DBPR License Abbreviations' },
  { file: `${DOCS}/hb803-legislative-memo.pdf`,                  source: 'HB 803 Memo' },
];

const MAX = 1000;      // characters per passage
const MIN = 220;       // don't emit slivers
const OVERLAP = 180;   // carry the tail of the previous passage for context
const TAIL_MIN = 60;   // the last scrap of a document is still worth keeping

// lines that are page furniture, not content
const isFurniture = (l) =>
  /^\s*$/.test(l) ||
  /^\d{1,4}$/.test(l) ||
  /^-- \d+ of \d+ --$/.test(l) ||
  /^\d{4} Liberty County LDC( |$)/i.test(l) ||
  /^Liberty County Comprehensive Plan/i.test(l) ||
  /Clerk of Court & Comptroller · jford@libertyclerk\.com/i.test(l) ||   // county footer line
  /^Liberty County Board of County Commissioners/i.test(l) ||
  /\.{6,}\s*\d+\s*$/.test(l);            // table-of-contents dot leaders

// ALL-CAPS titles, kept separate because a repeated one is page furniture
const ALLCAPS = /^([A-Z][A-Z &,'\-/]{8,70})$/;

// heading styles used across these two documents
const HEADING = [
  /^(Chapter\s+\d+[A-Za-z]?\b.*)$/i,
  /^(ARTICLE\s+[IVXLC0-9]+\b.*)$/i,
  /^(Section\s+\d+[\d.\-]*\s*[:.]?.*)$/i,
  /^(Sec\.\s*\d+[\d.\-]*.*)$/i,
  /^((?:GOAL|OBJECTIVE|POLICY)\s+[\d.]+.*)$/i,
  /^(\d+\.\d+(?:\.\d+)*\s+[A-Z][^.]{4,80})$/,
  ALLCAPS,                                // ALL CAPS element/section titles
  // the department's own documents: "I. New construction", "Part 1b — …",
  // "Step 3: …", "1. Property and owner", "Fee Assessment"
  /^([IVXLC]{1,5}\.\s+[A-Z][^.]{3,70})$/,
  /^(Part\s+\d+[a-z]?\s*[—\-:].{3,70})$/i,
  /^(Step\s+\d+\s*[:.]\s*.{3,70})$/i,
  /^(\d{1,2}\.\s+[A-Z][^.]{3,60})$/,
  /^((?:Fee Assessment|Permit Coverage|Intake Rules|Fee Modifiers|Additional Permit Rules|Documented Inspections|Inspection Fees)\b.*)$/i,
];
function headingOf(line, big, repeated) {
  const l = line.trim();
  if (l.length > 90) return null;
  // Set in type larger than the body text — the only signal available in the
  // department's own one-pagers, whose headings are ordinary sentences
  // ("Exempt — no permit needed") that no pattern can tell from body text.
  // A wrapped body line can key-match a heading once punctuation is stripped
  // ("electrical)" against the heading "Electrical"), so the line still has to
  // read like a heading, and the heading's own wording is what gets stored.
  if (big && /^[A-Z0-9]/.test(l) && !/[,;)]$/.test(l)) {
    const canonical = big.get(headingKey(l));
    if (canonical) return canonical;
  }
  for (const re of HEADING) {
    const m = l.match(re);
    if (m) {
      const h = m[1].replace(/\s+/g, ' ').trim();
      // An ALL-CAPS "heading" that fires over and over is a table column label
      // or a running page header, not a heading. The 2026 Eligibility Guide is
      // laid out as a table, and its column labels — CONTRACTOR, LICENSED
      // CONTRACTOR, OWNER MAY PULL & DO THE — were being read as the titles of
      // 37 of its 39 passages, which let that one guide crowd into answers it
      // had nothing to do with. Only ALL-CAPS matches are tested this way: a
      // numbered subheading like "3. Density" legitimately recurs under every
      // land use district in the Code.
      if (re === ALLCAPS && repeated && repeated.has(h)) return null;
      return h;
    }
  }
  return null;
}

// comparison key: the two extractors disagree about spacing around dashes
const headingKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
// the type extractor runs words together across a dash: "Exempt—no permit needed"
const tidyHeading = (s) => s.replace(/\s+/g, ' ').replace(/\s*—\s*/g, ' — ').trim();

// Lines set larger than the document's body text. Body size is the size most
// of the characters are set in, so this does not depend on knowing the
// document's design. The Code and the Plan set their headings bold at body
// size and are unaffected — they keep matching by pattern, as before.
async function bigHeadings(file) {
  const found = new Map();   // comparison key -> the heading as written
  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true,
    }).promise;
    const weight = new Map();      // type size -> characters set in it
    const lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const byRow = new Map();     // same baseline = same line
      for (const item of content.items) {
        if (!item.str.trim()) continue;
        const row = Math.round(item.transform[5]);
        const size = Math.round((Math.abs(item.transform[0]) || item.height) * 2) / 2;
        if (!byRow.has(row)) byRow.set(row, { size: 0, text: '' });
        const line = byRow.get(row);
        line.text += item.str;
        if (size > line.size) line.size = size;
        weight.set(size, (weight.get(size) || 0) + item.str.length);
      }
      byRow.forEach(line => lines.push(line));
    }
    await doc.destroy();
    const body = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0];
    let biggest = 0;
    for (const line of lines) {
      const t = line.text.trim();
      if (line.size >= body + 0.5 && t.length > 2 && t.length <= 90) {
        const key = headingKey(t);
        if (!found.has(key)) found.set(key, tidyHeading(t));
        if (line.size > biggest) { biggest = line.size; found.title = tidyHeading(t); }
      }
    }
  } catch (err) {
    console.log('  (type-size pass unavailable: ' + err.message + ')');
    return new Map();
  }
  return found;
}

function tidy(s) {
  return s.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s+([.,;:)])/g, '$1').trim();
}

(async () => {
  const out = [];
  for (const src of SOURCES) {
    // Skipping a missing file used to be a printed note, which is how a
    // renamed folder could silently cost the index the Code and the Plan.
    if (!fs.existsSync(src.file)) {
      console.error('MISSING SOURCE: ' + src.file + '\n  The index would be built without it. Fix the path and run again.');
      process.exit(1);
    }
    const parser = new PDFParse({ data: fs.readFileSync(src.file) });
    const res = await parser.getText();
    await parser.destroy();

    const lines = res.text.split(/\r?\n/);

    const big = await bigHeadings(src.file);
    // first pass: which heading patterns fire so often they must be furniture
    const hits = new Map();
    for (const raw of lines) {
      if (isFurniture(raw)) continue;
      const m = raw.trim().length <= 90 && raw.trim().match(ALLCAPS);
      if (m) { const h = m[1].replace(/\s+/g, ' ').trim(); hits.set(h, (hits.get(h) || 0) + 1); }
    }
    const repeated = new Set([...hits].filter(([, n]) => n > 3).map(([h]) => h));
    if (repeated.size) console.log(`  ignoring repeated table labels: ${[...repeated].join(', ')}`);

    // Material above the first heading is filed under the document's title
    // rather than "(front matter)", which named nothing and matched nothing.
    const opening = big.title || '(front matter)';
    let page = 1, heading = opening, buf = '', bufPage = 1, bufHeading = heading, made = 0;

    // Returns false when what had accumulated was too short to stand on its
    // own. In that case the text stays in the buffer and joins the passage
    // that follows, rather than being discarded with the heading change.
    const flush = (final) => {
      const text = tidy(buf);
      if (text.length >= MIN || (final && text.length >= TAIL_MIN)) {
        out.push({ source: src.source, section: bufHeading, page: bufPage, text });
        made++;
        buf = '';
        return true;
      }
      if (final) buf = '';
      return false;
    };

    for (const raw of lines) {
      // The extractor writes "-- 7 of 138 --" at the END of page 7, so text
      // after the marker belongs to page 8. Reading it as page 7 put every
      // citation one page low, landing readers on the page before the rule.
      const pm = raw.match(/^-- (\d+) of \d+ --$/);
      if (pm) { page = Number(pm[1]) + 1; continue; }
      if (isFurniture(raw)) continue;
      const h = headingOf(raw, big, repeated);
      if (h) {
        const emitted = flush(false);
        heading = h;
        // Only retitle the buffer when the previous passage actually closed.
        // Carried-over text keeps the heading and page it started under.
        if (emitted) { bufHeading = h; bufPage = page; }
        continue;
      }
      if (!buf) { bufPage = page; bufHeading = heading; }
      buf += (buf ? ' ' : '') + raw.trim();
      if (buf.length >= MAX) {
        const cut = buf.lastIndexOf('. ', MAX);
        let keep = buf, rest = '';
        if (cut > MIN) { keep = buf.slice(0, cut + 1); rest = buf.slice(cut + 1).trim(); }
        const text = tidy(keep);
        if (text.length >= MIN) { out.push({ source: src.source, section: bufHeading, page: bufPage, text }); made++; }
        buf = (text.slice(-OVERLAP) + ' ' + rest).trim();
        bufPage = page; bufHeading = heading;
      }
    }
    flush(true);
    console.log(`${src.source}: ${made} passages from ${res.pages ? res.pages.length : '?'} pages`);
  }

  // The same passage reaching the index twice wastes one of the nine slots a
  // question gets, and the reader sees the same citation listed twice.
  const seen = new Set();
  const unique = out.filter(c => {
    const key = c.source + '|' + c.text;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length !== out.length) console.log(`\ndropped ${out.length - unique.length} duplicate passages`);
  out.length = 0;
  out.push(...unique);

  out.forEach((c, i) => c.id = 'ref' + (i + 1));
  fs.writeFileSync(OUT, JSON.stringify(out));
  const bytes = fs.statSync(OUT).size;
  console.log(`\nwrote ${out.length} passages, ${(bytes / 1024).toFixed(0)} KB -> ${OUT}`);
  const bySrc = {};
  out.forEach(c => bySrc[c.source] = (bySrc[c.source] || 0) + 1);
  console.log(bySrc);
  const hit = out.filter(c => /three \(3\) or more lots/i.test(c.text));
  console.log('\nsubdivision passage found: ' + hit.length);
  if (hit[0]) console.log(`  [${hit[0].source} — ${hit[0].section}, page ${hit[0].page}]\n  ${hit[0].text.slice(0, 300)}...`);
})();
