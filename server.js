// Liberty County Building Dept — Staff Reference Assistant
// Minimal Express server: serves the static frontend AND proxies
// requests to the Anthropic API so the API key never reaches the browser.

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/ask', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY. Set it in Railway environment variables.' });
  }

  const { system, question } = req.body || {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Missing "question" in request body.' });
  }

  try {
    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: system || undefined,
        messages: [{ role: 'user', content: question }]
      })
    });

    if (!anthropicResponse.ok) {
      const errText = await anthropicResponse.text();
      console.error('Anthropic API error:', anthropicResponse.status, errText);
      return res.status(502).json({ error: `Anthropic API returned status ${anthropicResponse.status}` });
    }

    const data = await anthropicResponse.json();
    const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
    const answer = textBlocks.join('\n\n');

    res.json({ answer });
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Failed to reach Anthropic API from the server.' });
  }
});

// ── Parcel lookup: Florida DOR statewide parcel/cadastral feature service ──
// Public ArcGIS REST API (no key required), maintained by the Florida
// Dept of Revenue from each county property appraiser's annual tax roll
// submission. CO_NO=49 is Liberty County's DOR county number.
// This is a snapshot (updated a few times a year), not a live county feed —
// for anything legally significant, staff should still confirm against the
// county Property Appraiser's own site (linked in the UI).
const PARCEL_API_BASE = 'https://services9.arcgis.com/Gh9awoU677aKree0/arcgis/rest/services/Florida_Statewide_Cadastral/FeatureServer/0/query';
const LIBERTY_CO_NO = 49;

app.post('/api/parcel', async (req, res) => {
  const { parcelId } = req.body || {};
  if (!parcelId || typeof parcelId !== 'string') {
    return res.status(400).json({ error: 'Missing "parcelId" in request body.' });
  }

  const cleaned = parcelId.trim().replace(/'/g, "''"); // basic SQL-injection guard for this literal
  if (!cleaned) {
    return res.status(400).json({ error: 'Parcel ID was empty after trimming.' });
  }

  const whereClause = `CO_NO=${LIBERTY_CO_NO} AND (PARCEL_ID='${cleaned}' OR PARCEL_ID LIKE '%${cleaned}%')`;
  const outFields = [
    'PARCEL_ID', 'DOR_UC', 'OWN_NAME', 'OWN_ADDR1', 'OWN_CITY', 'OWN_STATE',
    'PHY_ADDR1', 'PHY_CITY', 'PHY_ZIPCD', 'S_LEGAL', 'LND_SQFOOT', 'TOT_LVG_AR',
    'JV', 'LND_VAL', 'NO_RES_UNT', 'NO_BULDNG', 'TWN', 'RNG', 'SEC', 'ACT_YR_BLT'
  ].join(',');

  const url = `${PARCEL_API_BASE}?where=${encodeURIComponent(whereClause)}` +
    `&outFields=${outFields}&resultRecordCount=5&returnGeometry=false&f=json`;

  try {
    const apiResponse = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!apiResponse.ok) {
      console.error('Parcel API HTTP error:', apiResponse.status);
      return res.status(502).json({ error: `Parcel data service returned status ${apiResponse.status}` });
    }
    const data = await apiResponse.json();
    if (data.error) {
      console.error('Parcel API returned an error object:', data.error);
      return res.status(502).json({ error: data.error.message || 'Parcel data service returned an error.' });
    }
    const features = (data.features || []).map(f => f.attributes);
    res.json({ features });
  } catch (err) {
    console.error('Parcel lookup proxy error:', err);
    res.status(500).json({ error: 'Failed to reach the Florida parcel data service from the server.' });
  }
});

// Health check — handy for Railway
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Building Dept Assistant running on port ${PORT}`);
  if (!ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set. /api/ask will return errors until it is.');
  }
});
