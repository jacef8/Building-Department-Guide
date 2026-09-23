// Build a searchable passage index from the county's reference documents.
// Each passage keeps the heading it sits under and the PDF page it came from,
// so the assistant can cite "Land Development Code — Section 5.7, page 110".
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const OUT = 'C:/Users/jford/Desktop/Apps/building-dept-assistant/public/docs/reference-index.json';
const PZ = 'S:/BOCC/County Departments/Building Dept/Planning & Zoning';

const SOURCES = [
  { file: `${PZ}/LIBERTY-COUNTY-Land-Development-Code 2017.pdf`, source: 'Land Development Code' },
  { file: `${PZ}/Liberty-County-2012-2025-Comp-Plan.pdf`,        source: 'Comprehensive Plan' },
];

const MAX = 1000;      // characters per passage
const MIN = 220;       // don't emit slivers
const OVERLAP = 180;   // carry the tail of the previous passage for context

// lines that are page furniture, not content
const isFurniture = (l) =>
  /^\s*$/.test(l) ||
  /^\d{1,4}$/.test(l) ||
  /^-- \d+ of \d+ --$/.test(l) ||
  /^\d{4} Liberty County LDC( |$)/i.test(l) ||
  /^Liberty County Comprehensive Plan/i.test(l) ||
  /\.{6,}\s*\d+\s*$/.test(l);            // table-of-contents dot leaders

// heading styles used across these two documents
const HEADING = [
  /^(Chapter\s+\d+[A-Za-z]?\b.*)$/i,
  /^(ARTICLE\s+[IVXLC0-9]+\b.*)$/i,
  /^(Section\s+\d+[\d.\-]*\s*[:.]?.*)$/i,
  /^(Sec\.\s*\d+[\d.\-]*.*)$/i,
  /^((?:GOAL|OBJECTIVE|POLICY)\s+[\d.]+.*)$/i,
  /^(\d+\.\d+(?:\.\d+)*\s+[A-Z][^.]{4,80})$/,
  /^([A-Z][A-Z &,'\-/]{8,70})$/,          // ALL CAPS element/section titles
];
function headingOf(line) {
  const l = line.trim();
  if (l.length > 90) return null;
  for (const re of HEADING) { const m = l.match(re); if (m) return m[1].replace(/\s+/g, ' ').trim(); }
  return null;
}

function tidy(s) {
  return s.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\s+([.,;:)])/g, '$1').trim();
}

(async () => {
  const out = [];
  for (const src of SOURCES) {
    if (!fs.existsSync(src.file)) { console.log('MISSING: ' + src.file); continue; }
    const parser = new PDFParse({ data: fs.readFileSync(src.file) });
    const res = await parser.getText();
    await parser.destroy();

    const lines = res.text.split(/\r?\n/);
    let page = 1, heading = '(front matter)', buf = '', bufPage = 1, bufHeading = heading, made = 0;

    const flush = () => {
      const text = tidy(buf);
      if (text.length >= MIN) {
        out.push({ source: src.source, section: bufHeading, page: bufPage, text });
        made++;
      }
      buf = '';
    };

    for (const raw of lines) {
      const pm = raw.match(/^-- (\d+) of \d+ --$/);
      if (pm) { page = Number(pm[1]); continue; }
      if (isFurniture(raw)) continue;
      const h = headingOf(raw);
      if (h) {
        flush();
        heading = h; bufHeading = h; bufPage = page;
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
    flush();
    console.log(`${src.source}: ${made} passages from ${res.pages ? res.pages.length : '?'} pages`);
  }

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
