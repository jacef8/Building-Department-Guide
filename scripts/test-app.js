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

// The same trap at desktop width, in staff mode. The staff page puts a sidebar
// on one side and a parcel panel on the other, so its centre column is much
// narrower than the public page's - and the long upload wording wrapped there,
// putting a scrollbar on an empty box and cutting its own second line in half.
// Measured in the browser at the app's own font: 54 characters needs about
// 408px of box, 81 characters needs 592px.
{
  const desktopBranch = (html.match(/UPLOADS_ENABLED \? '([^']*)' : '([^']*)'/) || []).slice(1);
  ok(desktopBranch.length === 2, 'the desktop placeholder pair could not be found to measure');
  for (const ph of desktopBranch)
    ok(ph.length <= 56,
       `the desktop placeholder is ${ph.length} characters ("${ph}"); over about 56 it wraps in the staff column and has to be scrolled`);
}

// The answer column must be the piece that takes the leftover height. As a
// two-row grid with three or more children, the NOTICE took the 1fr row and
// stood 269px tall with the answer pushed under it and overlapping.
ok(ruleBody('.main').includes('display:flex'),
   'the main column must be flex, or an extra child steals the answer row');
ok(ruleBody('.main>.chat').includes('flex:1 1 auto'),
   'the answer column is not the piece that takes the leftover height');

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
  ok(/does the work need a permit|do i need a permit/i.test(h.chunks[0].section || ''),
     'the "do I need a permit?" material no longer ranks first');
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
  const dr = index.filter(c => c.source === 'Permit Desk Reference');
  ok(dr.length > 0 && dr.every(c => !/front matter/i.test(c.section)),
     'the Desk Reference lost its headings');
  // the five guides it replaced are in the county's Archive folder; nothing in
  // the app may still cite them, or a citation link opens a document that is gone
  const RETIRED = ['Building Guide', 'Permit Coverage Reference', 'Permit Eligibility Guide',
                   'Permit Exemption Quick Reference', 'Planning & Zoning Flow Chart'];
  for (const r of RETIRED) {
    ok(!index.some(c => c.source === r), `the index still carries the retired "${r}"`);
    ok(!new RegExp('\{ source: "' + r + '"').test(html),
       `a knowledge-base entry still cites the retired "${r}"`);
    ok(!html.includes('/docs/' + r.toLowerCase().replace(/[^a-z]+/g, '-')),
       `a document link still points at the retired "${r}"`);
  }
  ok(fs.existsSync(path.join(ROOT, 'public/docs/permit-desk-reference.pdf')),
     'the Desk Reference PDF the citations link to is missing');
  // the figures the retired guides had wrong must not come back as stated fact
  ok(!/Front 20 ft, Side 20 ft/.test(html), 'the wrong setback line is back in the knowledge base');
  ok(!/within 1,000 feet of a school/.test(html), 'the disputed alcohol distance is back');
  ok(!/Small-Scale, under 10 acres/.test(html), 'the superseded 10-acre threshold is back');
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


// The request body sent to the model. Checked here because there is no API key
// outside Railway, so these two lines cannot be exercised by actually asking a
// question from a developer machine.
{
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/model:\s*'claude-sonnet-5-5'/.test(server), 'the model is no longer Sonnet 5.5');
  // Thinking was off for speed until 2026-10-28, when Jace said completeness
  // and correctness beat the wait and the cost. These pin that decision.
  ok(/thinking:\s*\{\s*type:\s*'adaptive'\s*\}/.test(server),
     'thinking is off again - the tool is back to answering before it has read the passages');
  ok(/effort:\s*'xhigh'/.test(server), 'effort has dropped below xhigh');
  const mt = server.match(/max_tokens: isGuide \? (\d+) : \(.*?: (\d+)\)/);
  ok(mt && Number(mt[1]) >= 8000, 'the walkthrough token budget has been cut back');
  ok(mt && Number(mt[2]) >= 4000, 'the single-answer token budget has been cut back');
  ok(/retrying without them/.test(server),
     'the fallback for a rejected thinking or effort field is gone');
  ok(/Do NOT retract it/.test(server),
     'the rule stopping the model disowning an earlier cited answer is gone');
}


// ── SHIP housing assistance stays out of permit answers ──────────────
// SHIP is a different programme run from the same office, and it shares
// vocabulary with permitting - repair, rehabilitation, unit, owner-occupied.
// It is held out of retrieval behind SHIP_GATE. These checks are what stop
// that gate drifting open.
{
  // The gate is a regex literal, not assembled from strings, because \b inside
  // a JS string is a BACKSPACE character and these four words then match nothing
  // at all - no error, no visible symptom. That bug was written once already.
  for (const w of ['ship', 'lhap', 'hhrp', 'ami'])
    ok(sb.shipAsked('tell me about ' + w),
       `SHIP_GATE no longer matches the bare word "${w}" - look for \\b written inside a string`);

  const PERMIT_QS = [
    'do i need a permit for a shed', 'what is the roofing permit fee',
    'how far back does a house have to be from the property line',
    'who can pull a permit for a swimming pool', 'notice of commencement threshold',
    'can i repair my own roof after the storm', 'my mobile home needs repairs after the hurricane',
    'rehabilitation of an existing commercial building', 'owner builder affidavit requirements',
    'how much to replace my roof', 'do i need a permit to replace my floors',
    'can the owner do the electrical work themselves',
  ];
  for (const q of PERMIT_QS) {
    ok(!sb.shipAsked(q), `SHIP_GATE opens on the permit question "${q}"`);
    const got = sb.retrieveChunks(q, 9, new Map()).filter(c => c.topic === 'ship');
    ok(got.length === 0, `"${q}" pulled ${got.length} SHIP passage(s) into a permit answer`);
  }

  const SHIP_QS = ['what are the ship income limits', 'is there down payment assistance',
                   'what is the maximum ship award', 'owner occupied rehab assistance',
                   'does the county have housing assistance', 'rent limit for a 2 bedroom'];
  for (const q of SHIP_QS) {
    ok(sb.shipAsked(q), `SHIP_GATE stays shut on the housing question "${q}"`);
    ok(sb.retrieveChunks(q, 9, new Map()).some(c => c.topic === 'ship'),
       `"${q}" reached no SHIP material at all`);
  }

  // every SHIP passage carries the tag, and nothing else does
  const shipSrc = /SHIP|LHAP/;
  ok(index.filter(c => shipSrc.test(c.source) && c.topic !== 'ship').length === 0,
     'a SHIP passage is in the index untagged - it would show up in permit answers');
  ok(index.filter(c => c.topic === 'ship' && !shipSrc.test(c.source)).length === 0,
     'a non-SHIP passage is tagged topic:ship and is now hidden from permit answers');
  ok(index.some(c => c.topic === 'ship'), 'the SHIP documents are not in the index at all');

  // The statewide limits table must never be indexed as text: 67 counties of
  // bare numbers with the column headings in a separate row, so a passage about
  // Liberty carries the figures of the county printed above it.
  ok(!index.some(c => c.source === 'SHIP Income and Rent Limits'),
     'the 67-county limits table is indexed as text - a Liberty answer can quote another county');

  // Liberty's own figures. The 9- and 10-person cells are merged in the PDF and
  // were read against HUD's add-8%-of-the-4-person-limit rule.
  // reached through retrieval rather than the array: KNOWLEDGE_BASE is a const,
  // so it is not a property of the sandbox the way the functions are
  const limits = sb.retrieveChunks('ship income and rent limits for liberty county', 9, new Map())
    .find(c => c.source === 'SHIP Income and Rent Limits');
  ok(!!limits && limits.topic === 'ship', 'the Liberty income and rent limits entry is missing');
  for (const fig of ['75,500', '16,450', '39,150', '51,700', '54,810', '57,942', '1,408', '3,508'])
    ok(limits && limits.text.includes(fig), `the limits entry lost the figure ${fig}`);
  ok(limits && /Liberty County only/i.test(limits.text),
     'the limits entry no longer says the other 66 counties do not apply');

  // A conversation about SHIP stays about SHIP. Without this the gate shut on
  // every natural follow-up, the housing documents vanished mid-conversation,
  // and the model - seeing only permit material behind its own earlier answer -
  // retracted correct figures and told the reader not to quote them.
  {
    const convo = [{ role: 'user', content: 'what are the ship strategies and the maximum award for each one' },
                   { role: 'assistant', content: '...' }];
    const shipAfter = (q, hist) => {
      const h = (hist || []).concat([{ role: 'user', content: q }]);
      return sb.retrieveChunks(q, 9, new Map(), sb.shipInContext(h)).filter(c => c.topic === 'ship').length;
    };
    for (const q of ['give me an example of lot rent assistance', 'can you give me a worked example',
                     'how is that calculated', 'who qualifies for that', 'is that a grant or a loan',
                     'how long does it last', 'what does an applicant have to bring'])
      ok(shipAfter(q, convo) > 0,
         `the follow-up "${q}" lost the SHIP documents - the model will disown its own earlier answer`);

    // but a question that names its own permit subject is a new subject, not a
    // follow-up, and must not be handed SHIP material just because SHIP came up
    for (const q of ['what is the roofing permit fee', 'do i need a permit for a shed',
                     'how far back from the property line', 'what inspections does a house need',
                     'who can pull a pool permit'])
      ok(shipAfter(q, convo) === 0,
         `"${q}" pulled SHIP material because SHIP was discussed earlier in the conversation`);

    ok(sb.shipAsked('give me an example of lot rent assistance'),
       'the gate no longer recognises "lot rent assistance" on its own');
  }

  // the selector: explicit choice beats every inference
  {
    const ship = (q, mode) => sb.retrieveChunks(q, 9, new Map(), false, mode)
      .filter(c => c.topic === 'ship').length;
    // on SHIP, a question naming a permit subject still gets the housing
    // documents - someone who chose SHIP and asks about repairs means SHIP
    for (const q of ['what is covered for repairs', 'who qualifies', 'what is the maximum award',
                     'rehabilitation of a mobile home'])
      ok(ship(q, 'ship') > 0, `with the selector on SHIP, "${q}" got no housing documents`);
    // on Building, the gate is in charge: permit questions stay clean
    for (const q of ['what is the roofing permit fee', 'do i need a permit for a shed',
                     'can i repair my own roof after the storm'])
      ok(ship(q, 'building') === 0, `with the selector on Building, "${q}" pulled SHIP material`);
    // but an unmistakable SHIP question is still answered rather than dead-ended
    ok(ship('what are the ship income limits', 'building') > 0,
       'on Building, an unmistakable SHIP question gets a dead end instead of an answer');

    ok(/let docMode = 'building'/.test(html), 'the selector no longer defaults to the permit documents');
    ok(/function setDocMode/.test(html), 'the selector handler is gone');
    ok(/onclick="setDocMode\('ship'\)"/.test(html) && /onclick="setDocMode\('building'\)"/.test(html),
       'one of the two selector buttons is missing');
    ok(/class="doc-mode"/.test(html), 'the selector is not rendered');
    ok(/answeredFromShip/.test(html) && /class="cross-mode"/.test(html),
       'the notice that an answer came from the other document set is gone');
    ok(ruleBody('.doc-seg button.on').includes('fff'),
       'the chosen selector button is not legible — it needs white on maroon, not grey');
    // it must not look like the suggestion chips sitting directly above it
    ok(!/border-radius:999px/.test(ruleBody('.doc-seg button')),
       'the selector is a pill again — it reads as another suggestion to click');
    ok(/class="doc-seg"/.test(html) && /doc-mode-label/.test(html),
       'the selector lost its joined-segment shape or its label');
  }

  // Whole-section retrieval: a Code rule must not reach the model without the
  // passages around it that say what it applies to. The 10,000 sq ft minimum
  // lot lives under the SUBDIVISION design standards, and quoting it as a rule
  // for every lot is how a true sentence becomes wrong advice at the counter.
  {
    const base = sb.retrieveChunks('what is the minimum lot size for a single family home', 9, new Map());
    const full = sb.withWholeSection(base);
    ok(full.length > base.length, 'Code hits no longer bring the rest of their section with them');
    const added = full.filter(c => !base.includes(c));
    ok(added.every(c => ['Land Development Code', 'Comprehensive Plan'].includes(c.source)),
       'whole-section expansion is reaching outside the Code and the Plan');

    // never by section NAME: "3. Density" heads every land use district, and
    // "Sec. 2.4 Definition of terms." is 133 passages over 43 pages
    for (const q of ['what is the density for agriculture land', 'what is the minimum lot size',
                     'how far back from the property line', 'define a subdivision']) {
      const got = sb.withWholeSection(sb.retrieveChunks(q, 9, new Map()));
      const defs = got.filter(c => /Definition of terms/i.test(c.section || '')).length;
      ok(defs <= 2, `"${q}" bulk-expanded ${defs} definition passages into the answer`);
      ok(got.length <= 9 + 14, `"${q}" expanded past the budget: ${got.length} chunks`);
    }

    // every added passage must be adjacent, in the document, to a hit in the
    // same section - not merely share its heading
    const idxPos = new Map(index.map((c, i) => [c.source + '|' + c.page + '|' + c.text.slice(0, 40), i]));
    const key = c => c.source + '|' + c.page + '|' + c.text.slice(0, 40);
    for (const c of added) {
      const near = base.some(b => b.source === c.source && b.section === c.section &&
        Math.abs((idxPos.get(key(b)) ?? -99) - (idxPos.get(key(c)) ?? 99)) <= 4);
      ok(near, `an expanded passage (${c.source} p${c.page}) is not next to any hit it was added for`);
    }

    // Pages that were cited but did not hold the figure. Each page below was
  // confirmed against its PDF before being written into the entry.
  {
    const kbHas = (re) => sb.retrieveChunks('density by land use category', 14, new Map())
      .some(c => re.test(c.text));
    ok(kbHas(/Comprehensive Plan, page 7/),
       'the Agriculture density lost its real page (7); it was cited to page 1, which holds none of it');
    ok(!/section: "Future Land Use — Density by Category", page: 1,/.test(html),
       'the density entry is back on page 1');
    ok(!/source: "HB 803 Memo", section: "[^"]*", page: 1,/.test(html),
       'an HB 803 Memo entry is back on page 1; the $7,500 threshold is on page 7');
    // $2,500 appears in NO document this app serves - it is statutory
    ok(/713\.135/.test(html),
       'the Notice of Commencement threshold is stated without the statute that sets it, and no served document carries it');
    ok(/A DOLLAR AMOUNT IS ALWAYS CITED TO THE 2026 FEE SCHEDULE/.test(
         fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
       'the rule sending fee citations to the Fee Schedule is gone');
  }

  // Code sections and statutes named inside an answer are clickable. They are
  // what staff read out to an applicant, and checking one used to mean leaving
  // the answer and hunting through the PDF.
  {
    const link = (t) => (sb.inlineMd(t).match(/class="cite-link"/g) || []).length;
    for (const t of ['LDC Section 5.4(C) sets the minimum lot size',
                     'See Section 4.6-3 for the referral triggers',
                     'Land Development Code Section 6.4-4(A) is the wellfield rule',
                     'Comprehensive Plan Policy 8-2 allows the split'])
      ok(link(t) === 1, `no link made for a Code or Plan reference: "${t}"`);
    for (const t of ['Required under s. 489.103(7), Florida Statutes',
                     'FS 163.3187 sets the small-scale threshold',
                     'The threshold is in s. 713.135'])
      ok(link(t) === 1, `no link made for a statute: "${t}"`);

    // The Plan numbers policies per element, so half its numbers point at
    // several places. Those must stay plain rather than land on the wrong one.
    for (const t of ['Policy 1-2 says the land use line follows the property line',
                     'Objective 1 covers growth management'])
      ok(link(t) === 0, `an ambiguous Plan reference was linked and will land on the wrong element: "${t}"`);

    ok(link('Nothing to link in this sentence at all') === 0, 'plain prose is being linked');
    ok(/text-decoration:underline/.test(ruleBody('.cite-link')),
       'citation links are colour only, with nothing to see in print or for a colour-blind reader');
  }

  // The site plan. It used to be a rotatable 3D scene under a heading saying
  // "to scale", which perspective makes impossible to measure, and it drew a
  // 200 ft well exclusion circle on residential parcels.
  {
    const plan = html.slice(html.indexOf('window.siteDiagram'));
    ok(!/THREE\./.test(plan), 'the site plan is back to a 3D scene; a perspective view cannot be measured');
    ok(/createElementNS/.test(plan), 'the site plan is no longer drawn as SVG');
    ok(!/r: WELL_RADIUS/.test(plan),
       'the 200 ft well exclusion circle is being drawn again - LDC 6.4-4(A) excludes individual private wells');
    ok(/but not individual private wells/.test(plan),
       'the note no longer says the 200 ft zone does not cover a private well');
    ok(/6\.4-4\(A\)/.test(plan) && /page 127/.test(plan),
       'the private-well exclusion lost its section or its page');
    ok(/does not say where the house sits/.test(plan),
       'the plan no longer admits it does not know where the house is');
    ok(/state\.set = true/.test(plan),
       'the house no longer records that someone placed it, so an unplaced guess looks placed');
    ok(!/id="siteCanvas"><\/canvas>/.test(html), 'the plan host is a canvas again');
  }

  // An audit of the Code and the Plan against their PDFs: 182 of 184 Comp Plan
  // passages and 348 of 373 LDC passages sit on the page they name. The ones
  // that do not are off by one BACKWARDS, because a passage split at the size
  // limit opens with a tail carried from the previous page. The viewer
  // therefore starts its search one page earlier.
  {
    const viewer = fs.readFileSync(path.join(ROOT, 'public/source.html'), 'utf8');
    ok(/wanted - 1/.test(viewer),
       'the source viewer no longer looks one page back, so a split passage lands on the wrong page');
    ok(/probes\.some/.test(viewer),
       'the viewer stopped matching on the exact phrase, so looking back could land anywhere');
  }

  ok(/THE PAGE YOU CITE MUST BE THE PAGE THE FIGURE IS ON/.test(
         fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')),
       'the rule forbidding a borrowed page number is gone');
    ok(/Section 5\.4\(C\), page 115/.test(html),
       'the verified page for the 10,000 sq ft minimum lot is gone from the curated entry');
  }

  // Policy 8-1 is the cap on an exception for pre-1992 lots of record, not a
  // general "one house per lot" rule. The first version of this entry said it
  // "usually decides whether a second home can go on family land", which would
  // have had staff telling people with acreage they could not build.
  {
    const fam = sb.retrieveChunks('can my son put a mobile home on my land', 9, new Map())
      .find(c => /Policy 8-2/i.test(c.section || ''));
    ok(!!fam, 'the family-land entry no longer ranks for the question it exists to answer');
    ok(fam && /NOT a general rule/i.test(fam.text),
       'the entry treats Policy 8-1 as a universal one-house-per-lot rule again');
    ok(fam && /September 24, 1992|24 September 1992/.test(fam.text),
       'the entry lost the 1992 lot-of-record cut-off that decides whether Objective 8 applies');
    ok(fam && /density for the parcel's future land use category/i.test(fam.text),
       'the entry no longer points at density as what actually limits homes on a normal parcel');
  }

  // the strategy names and their awards print on different LHAP lines and land
  // in different passages, so this entry is what keeps them together
  {
    const strat = sb.retrieveChunks('what are the ship strategies and the maximum award for each', 9, new Map())
      .find(c => /four strategies/i.test(c.section || ''));
    ok(!!strat, 'the LHAP strategy-and-award entry no longer ranks for the question it exists to answer');
    for (const pair of [['Owner Occupied Rehabilitation', '50,000'], ['Disaster Recovery', '30,000'],
                        ['Emergency Repair', '27,500'], ['relocation assistance', '10,000']])
      ok(strat && strat.text.toLowerCase().includes(pair[0].toLowerCase())
              && strat.text.includes(pair[1]),
         `the strategy entry lost ${pair[0]} or its $${pair[1]} award`);
    ok(strat && /NOT Liberty County's allocation/i.test(strat.text),
       'the entry no longer warns that $350,000 is a statutory threshold, not the county allocation');
    // the manufactured housing strategy does NOT share the others' terms, and
    // the first version of this entry said it did
    ok(strat && /awarded as a GRANT/i.test(strat.text),
       'the entry no longer says relocation and lot rent assistance are grants, not loans');
    ok(strat && /TEN-year term/i.test(strat.text),
       'the entry no longer says manufactured-housing rehab runs ten years, not five');
    ok(strat && strat.text.includes('15,000'),
       'the entry lost the $15,000 manufactured-housing rehab award');
    ok(strat && /15 June 1994/.test(strat.text),
       'the entry lost the pre-1994 mobile home eligibility cut-off');
    ok(strat && /NOT the same across the strategies/i.test(strat.text),
       'the entry claims the terms are uniform again - they are not');
  }

  for (const [name, file] of [['Liberty County LHAP', 'liberty-lhap-2026-2029.pdf'],
                              ['SHIP Procedures Manual', 'ship-procedures-manual.pdf'],
                              ['SHIP Income and Rent Limits', 'ship-income-and-rent-limits-2026.pdf']]) {
    ok(fs.existsSync(path.join(ROOT, 'public/docs', file)), `${name}: ${file} is missing`);
    ok(html.includes("'" + name + "': '/docs/" + file + "'"), `${name} has no document link`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
bad.forEach(b => console.log('  FAIL ' + b));
process.exit(fail ? 1 : 0);
