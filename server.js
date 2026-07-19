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

// Health check — handy for Railway
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Building Dept Assistant running on port ${PORT}`);
  if (!ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY is not set. /api/ask will return errors until it is.');
  }
});
