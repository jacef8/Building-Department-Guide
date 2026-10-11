// Regression suite for the permit assistant. Lives in the project on purpose:
// an earlier set of these sat in a scratch folder, the folder was cleared
// overnight, and they were gone the morning a redesign needed checking.
//
//     node scripts/test-app.js
//
// It loads the app's first classic <script> into a sandbox — the same way the
// browser loads it, minus the DOM — so it tests the real retrieval code
// rather than a copy of it. The diagram and the smooth scrolling live in a
// separate module script and are deliberately NOT loaded here: a top-level
// import would break the sandbox, which is the reason they are separate.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];

const sb = {
  console, localStorage: { getItem: () => null, setItem() {} },
  location: { pathname: '/', hash: '', search: '' }, confirm: () => true,
  fetch: () => Promise.reject(new Error('no network in the suite')),
  document: {
    querySelector: () => null, querySelectorAll: () => [],
    getElementById: (i) => (i === 'app' ? { innerHTML: '' } : null),
    addEventListener() {},
    createElement: () => ({ set textContent(v) { this._t = v; }, get innerHTML() { return this._t; } }),
  },
  window: {}, navigator: {},
};
sb.window = sb;
vm.createContext(sb);
vm.runInContext(script.replace(/^init\(\);$/m, '') +
  '\nglobalThis.__kb=KNOWLEDGE_BASE;\nglobalThis.__setIndex=(a)=>{REFERENCE_INDEX=a;};', sb);

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/docs/reference-index.json'), 'utf8'));
sb.__setIndex(index);

let pass = 0, fail = 0; const bad = [];
const ok = (cond, label) => { if (cond) pass++; else { fail++; bad.push(label); } };

function hits(q) {
  const guide = sb.isGuideQuestion(q);
  const scores = new Map();
  const chunks = sb.retrieveChunks(sb.expandQuery(q, guide), guide ? 18 : 9, scores);
  return { chunks, shown: sb.citableSources(chunks, scores, q), text: chunks.map(c => c.text).join(' ') };
}

// ── 1. the page still holds together ────────────────────────────────
ok(/<script type="module">/.test(html), 'the diagram module is missing from the page');
ok(html.indexOf('<script>') < html.indexOf('<script type="module">'),
   'the module must come after the app script, or the suite loads the wrong one');
for (const fn of ['retrieveChunks', 'citableSources', 'expandQuery', 'isGuideQuestion', 'formatBubble',
                  'linkifyCitations', 'sourceViewerUrl', 'declinedAnswer', 'render', 'tokenize'])
  ok(typeof sb[fn] === 'function', `${fn}() went missing`);

// every handler the markup calls by name has to exist, or a button is dead
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'void', 'new']);
const handlers = [...html.matchAll(/on(?:click|change|keydown|paste)="([a-zA-Z_$][\w$]*)\(/g)]
  .map(m => m[1]).filter(n => !KEYWORDS.has(n));
for (const h of [...new Set(handlers)])
  ok(typeof sb[h] === 'function', `markup calls ${h}() but nothing defines it`);

// the markup and the stylesheet have to agree on class names
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
for (const cls of ['header', 'rail', 'main', 'detail', 'chat', 'input-bar', 'msg', 'bubble',
                   'citation-tag', 'suggestion-chip', 'kb-toggle', 'strip-btn', 'parcel-link',
                   'history-panel', 'hp-item', 'attach-chip', 'error-banner', 'empty-state',
                   'sources-used', 'disclaimer', 'tools-toggle', 'pb-flu', 'stage', 'legend'])
  ok(css.includes('.' + cls), `no style for .${cls}, which the markup uses`);

// directive 2.3: a phone rule that loses on source order silently does nothing
// The FIRST phone media query. There is a second one further down for tall
// phones, and taking the last match pointed these checks at that instead.
const phoneBlock = css.indexOf('@media(max-width:779px)');
for (const sel of ['.main', '.header', '.disclaimer'])
  ok(css.indexOf(sel + '{') < phoneBlock,
     `the base rule for ${sel} must come before the phone block`);

// the flexbox floor that let a long citation push the page sideways on a phone
// A flex item will not shrink below its own min-content width unless told to,
// and a citation chip set to nowrap has a min-content width of its whole
// label — which is what pushed the page sideways on a phone.
// Every rule that targets this selector, run together. Taking only the first
// one is wrong: ".new-btn" appears first in a shared display:none rule, so a
// check for its real properties looked at the wrong declaration and failed.
const ruleBody = (sel) => {
  let out = '', from = 0;
  for (;;) {
    const at = css.indexOf(sel, from);
    if (at === -1) return out;
    from = at + sel.length;
    const rest = css.slice(from);
    // the selector must end here — at the brace, or at a comma in a list
    const m = rest.match(/^\s*[,{]/);
    if (!m) continue;
    const open = css.indexOf('{', at);
    if (open !== -1) out += css.slice(open, css.indexOf('}', open)) + ' ';
  }
};
for (const rule of ['.citation-tag', '.sources-used', '.msg.assistant .bubble'])
  ok(ruleBody(rule).includes('min-width:0'),
     `${rule} needs min-width:0 or a long label scrolls the page sideways`);
ok(ruleBody('.msg.assistant .bubble').includes('overflow-wrap:anywhere'),
   'a long word in an answer can still push the page sideways');
ok(ruleBody('.chat').includes('overflow-x:hidden'), 'the answer column can scroll sideways');

// Starting a fresh question was only reachable from inside the drawer on a
// phone, where nobody found it. It has to be on the screen.
ok(/class="new-btn" onclick="newConversation\(\)"/.test(html), 'the phone has no visible New button');
ok(ruleBody('.tools-toggle,.parcelbar,.new-btn').includes('display:none'),
   'the New button should be hidden on desktop, where the rail carries it');
ok(css.lastIndexOf('.new-btn{display:inline-flex') > phoneBlock, 'the New button is never shown on a phone');

// directive 2.4: nothing you tap is under 44px
for (const rule of ['.new-btn', '.tools-toggle', '.parcelbar'])
  ok(/min-(height|width):44px/.test(ruleBody(rule)) || /min-height:4[4-9]px|min-height:[5-9]\dpx/.test(ruleBody(rule)),
     `${rule} is under the 44px tap target`);

// The opening screen has to fit a phone without scrolling (directive 2.3),
// so the intro has a short version — and the short one must be hidden on
// desktop, or the page prints the same thing twice.
ok(/<span class="long">/.test(html) && /<span class="short">/.test(html),
   'the empty state lost its short intro');
ok(ruleBody('.disclaimer .short,.empty-state .short').includes('display:none'),
   'the short intro is not hidden on desktop');
ok(css.lastIndexOf('.empty-state .short{display:inline') > phoneBlock ||
   css.lastIndexOf('.empty-state .short') > phoneBlock,
   'the short intro is never shown on a phone');
ok(/nth-child\(n\+5\)\{display:none\}/.test(css), 'the phone shows more than four suggestions');

// the placeholder has to fit the box on a phone with the paperclip showing,
// or it wraps into a one-line box and the second line is cut in half
const afterTernary = html.slice(html.indexOf('window.innerWidth <= 779'));
const phonePlaceholder = (afterTernary.match(/\?\s*'([^']*)'/) || [])[1];
ok(phonePlaceholder && phonePlaceholder.length <= 25,
   `the phone placeholder is ${phonePlaceholder ? phonePlaceholder.length : '?'} characters; over 25 it wraps and clips`);

// directive 2.1: no glow or haze anywhere
ok(!/text-shadow/.test(css), 'text-shadow is on the rejected list');
ok(!/backdrop-filter/.test(css), 'backdrop-filter is on the rejected list');

// ── 2. retrieval still finds the right material ─────────────────────
const KNOWN = [
  ['how much is a porch permit', /\$?125/, 'the $125 porch fee'],
  ['what is the setback for a wellhead', /200[- ]foot|200 feet/i, 'the 200 ft wellhead rule'],
  ['what counts as a subdivision', /three \(3\) or more lots/i, 'the three-lot definition'],
  ['how do i know if i need a permit', /7,500/, 'the $7,500 exemption'],
  ['do i need a permit', /exempt/i, 'the exemption material'],
  ['what does a roofing permit cover', /roof/i, 'roofing material'],
  ['do I need a permit for a shed under 120 sq ft', /120/, 'the 120 sq ft rule'],
];
for (const [q, re, label] of KNOWN) {
  const h = hits(q);
  ok(re.test(h.text), `"${q}" no longer reaches ${label}`);
  ok(h.shown.length > 0, `"${q}" lost its citations`);
}

// the question that could not be answered at all before the curated entry
{
  const h = hits('how do i know if i need a permit');
  ok(h.chunks.some(c => /Do I need a permit/i.test(c.section || '')),
     'the "Do I need a permit?" entry no longer ranks');
}

// ── 2b. setbacks, asked the way staff ask ───────────────────────────
// Reported from the counter: "where can they put a barn" came back saying the
// distances were not in the material. They are — Schedule 1.0 of the Code —
// and the entry holding them was right; the question just never reached it.
for (const q of ['where can they put a barn on their property',
                 'what are the setbacks for an accessory building',
                 'how far from the property line does a barn have to be',
                 'how close to the line can he build a shed',
                 'what is the side yard setback',
                 'where can I put a garage',
                 'how far back from the road does the house have to sit']) {
  const h = hits(q);
  ok(/Side 5 ft|Side Yard Building/i.test(h.text), `"${q}" does not reach the setback table`);
  ok(h.shown.length > 0, `"${q}" lost its citations`);
}
// the Code governs where it and the Guide disagree, and the answer must say so
{
  const h = hits('what is the side yard setback');
  ok(/Code governs|the Code governs/i.test(h.text), 'the Guide/Code side-yard conflict is no longer flagged');
}

// ── 3. citations: only what the answer used ─────────────────────────
for (const q of ['what is the website for using this tool on our phones',
                 'what is the staff password', 'is it going to rain tomorrow',
                 'what is your favorite color']) {
  const h = hits(q);
  ok(h.shown.length === 0, `off-topic question still cites ${h.shown.length}: "${q}"`);
  ok(h.chunks.length > 0, `context should still reach the model for: "${q}"`);
}
// no document may dominate the nine
for (const q of ['how do i know if i need a permit', 'how much is a porch permit',
                 'what is the fee for a deck']) {
  const count = {};
  hits(q).chunks.forEach(c => { count[c.source] = (count[c.source] || 0) + 1; });
  const worst = Math.max(...Object.values(count));
  ok(worst <= 4, `one document took ${worst} of the nine slots on "${q}"`);
}

// ── 4. the decline marker never reaches the reader ──────────────────
const MARK = '[[NO_SOURCES]]';
ok(sb.declinedAnswer('Outside what I cover.\n' + MARK), 'the decline marker is not detected');
ok(!sb.declinedAnswer('A porch is $125.00 [Building Guide].'), 'false positive on a real answer');
ok(!/NO_SOURCES|\[\[/.test(sb.formatBubble('Outside my scope.\n' + MARK, [])), 'the marker leaked on screen');
ok(!/\[\[/.test(sb.formatBubble('Outside my scope.\n[[NO_SOU', [])), 'a half-streamed marker leaked');
ok(/125/.test(sb.formatBubble('A porch permit is $125.00.', [])), 'a normal answer was mangled');

// ── 4b. markdown that used to leak onto the screen ──────────────────
{
  const md = (t) => sb.formatBubble(t, []);
  ok(/<a href="\/docs\/future-land-use-map\.pdf">Future Land Use Map<\/a>/.test(
       md('Find it on the [Future Land Use Map](/docs/future-land-use-map.pdf) first.')),
     'a link to one of our own documents still shows as raw markdown');
  ok(!/\[Future Land Use Map\]/.test(md('See the [Future Land Use Map](/docs/future-land-use-map.pdf).')),
     'the brackets of a relative link leaked');
  ok(/<a href="https:\/\/example\.com"[^>]*target="_blank"/.test(md('See [it](https://example.com).')),
     'an outside link lost target=_blank');
  ok(/<em>values as of January 1<\/em>/.test(md('Tax roll, _values as of January 1_, applies.')),
     'underscore emphasis leaked');
  ok(/<em>only<\/em>/.test(md('It is *only* the structure.')), 'asterisk emphasis leaked');
  ok(/file_name_here/.test(md('Open file_name_here now.')), 'underscores inside a word were eaten');
  ok(/<strong>bold<\/strong>/.test(md('This is **bold** text.')), 'bold stopped working');
  ok(!/<a /.test(md('Try [this](javascript:alert(1)) now.')), 'a javascript: link was made clickable');
}

// ── 5. citations land on the page the rule is on ────────────────────
{
  const spanning = { source: 'Land Development Code', section: 'x', page: 120, last: 122, id: 'ref1',
    text: 'Lots shall front on a street for at least sixty feet of continuous frontage.' };
  const u = sb.sourceViewerUrl(spanning);
  ok(/[?&]page=120\b/.test(u) && /[?&]last=122\b/.test(u), 'the link lost the page span');
  ok(!/[?&]last=/.test(sb.sourceViewerUrl({ ...spanning, last: 0 })), 'a single-page link carries a span');
  const two = sb.linkifyCitations('A rule [Land Development Code, pp. 120–122].', [spanning]);
  ok(/page=120/.test(two) && /last=122/.test(two), 'a two-page marker did not link');
  const one = sb.linkifyCitations('A rule [Land Development Code, p. 44].', [spanning]);
  ok(/page=44/.test(one), 'a single-page marker no longer links');
  ok(!/<a /.test(sb.linkifyCitations('Per the [Gadsden County Code, p. 4].', [spanning])),
     'a document we do not hold was linked');
  const viewer = fs.readFileSync(path.join(ROOT, 'public/source.html'), 'utf8');
  ok(/params\.get\('last'\)/.test(viewer) && /async function locate\(\)/.test(viewer),
     'the viewer no longer searches the page span');
}

// ── 6. the index itself ─────────────────────────────────────────────
{
  const seen = new Set(); let dup = 0;
  index.forEach(c => { const k = c.source + '|' + c.text; if (seen.has(k)) dup++; seen.add(k); });
  ok(dup === 0, `${dup} duplicate passages in the index`);
  ok(index.some(c => c.source === 'Land Development Code') &&
     index.some(c => c.source === 'Comprehensive Plan'), 'the Code or the Plan is missing');
  const qr = index.filter(c => c.source === 'Permit Exemption Quick Reference');
  ok(qr.length > 0 && qr.every(c => !/front matter/i.test(c.section)),
     'the exemption reference lost its headings');
  ok(index.filter(c => /^(CONTRACTOR|LICENSED CONTRACTOR|OWNER MAY PULL & DO THE)$/.test(c.section)).length === 0,
     'passages are filed under a table column label again');
  ok(index.filter(c => c.last).length > 0, 'no passage records the page it ends on');
  ok(index.filter(c => c.last && c.last <= c.page).length === 0, 'a page span runs backwards');
  // the pages that were being dropped outright
  for (const [p, probe] of [[83, 'Liberty Correctional Institution and other public facilities'],
                            [84, 'silviculture only, subject to Best Management'],
                            [85, 'Table of Development Standards']])
    ok(index.some(c => c.text.includes(probe)), `Land Development Code p.${p} fell out of the index again`);
}

console.log(`\n${pass} passed, ${fail} failed`);
bad.forEach(b => console.log('  FAIL ' + b));
process.exit(fail ? 1 : 0);
