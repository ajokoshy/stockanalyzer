// api/stock.js — Vercel Serverless Function
// Fetches Yahoo Finance data server-side to avoid CORS restrictions

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Missing symbol parameter' });

  const ticker = symbol.toUpperCase().endsWith('.NS')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}.NS`;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
      },
    });

    if (!response.ok) {
      // Try alternate Yahoo endpoint
      const alt = await fetch(
        `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json',
            'Referer': 'https://finance.yahoo.com/',
          },
        }
      );
      if (!alt.ok) throw new Error(`Yahoo Finance returned ${response.status}`);
      const data = await alt.json();
      return res.status(200).json(data);
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch stock data', detail: err.message });
  }
}
