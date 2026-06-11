// api/stock.js — Vercel Serverless Function
// Fetches Yahoo Finance chart + quoteSummary (full fundamentals) server-side

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

async function tryFetch(url) {
  // Try query1 first, fall back to query2
  const u1 = url.replace('query2', 'query1');
  const u2 = url.replace('query1', 'query2');
  let res = await fetch(u1, { headers: HEADERS });
  if (!res.ok) res = await fetch(u2, { headers: HEADERS });
  if (!res.ok) throw new Error(`Yahoo Finance returned HTTP ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Missing symbol parameter' });

  const ticker = symbol.toUpperCase().replace(/\.(NS|BO)$/, '') + '.NS';

  try {
    // ── 1. Chart data (OHLCV + basic meta) ───────────────────────────────────
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;

    // ── 2. Quote summary (full fundamentals) ─────────────────────────────────
    const modules = [
      'summaryDetail',
      'defaultKeyStatistics',
      'financialData',
      'price',
    ].join(',');
    const summaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`;

    // Fetch both in parallel
    const [chartData, summaryData] = await Promise.all([
      tryFetch(chartUrl),
      tryFetch(summaryUrl).catch(() => null), // don't fail if summary unavailable
    ]);

    // Merge summary fundamentals into chart meta for easy access on the client
    if (summaryData?.quoteSummary?.result?.[0]) {
      const s = summaryData.quoteSummary.result[0];
      const meta = chartData?.chart?.result?.[0]?.meta;

      if (meta) {
        const sd  = s.summaryDetail     || {};
        const ks  = s.defaultKeyStatistics || {};
        const fd  = s.financialData     || {};
        const pr  = s.price             || {};

        // Safely extract raw values from Yahoo's {raw, fmt} objects
        const raw = (obj, key) => obj?.[key]?.raw ?? obj?.[key] ?? null;

        meta.trailingPE             = raw(sd, 'trailingPE')    ?? raw(pr, 'trailingPE');
        meta.forwardPE              = raw(sd, 'forwardPE')     ?? raw(ks, 'forwardPE');
        meta.priceToBook            = raw(ks, 'priceToBook');
        meta.beta                   = raw(sd, 'beta')          ?? raw(ks, 'beta');
        meta.dividendYield          = raw(sd, 'dividendYield') ?? raw(sd, 'trailingAnnualDividendYield');
        meta.epsTrailingTwelveMonths= raw(ks, 'trailingEps')   ?? raw(fd, 'revenuePerShare');
        meta.marketCap              = raw(pr, 'marketCap')     ?? raw(sd, 'marketCap');
        meta.fiftyDayAverage        = raw(sd, 'fiftyDayAverage')       ?? meta.fiftyDayAverage;
        meta.twoHundredDayAverage   = raw(sd, 'twoHundredDayAverage')  ?? meta.twoHundredDayAverage;
        meta.averageDailyVolume3Month = raw(pr, 'averageDailyVolume3Month') ?? meta.averageDailyVolume3Month;
        meta.shortName              = pr.shortName   ?? meta.shortName;
        meta.longName               = pr.longName    ?? meta.longName;
        meta.sector                 = pr.sector      ?? null;
        meta.industry               = pr.industry    ?? null;

        // Extra fundamentals we'll surface
        meta.returnOnEquity         = raw(fd, 'returnOnEquity');
        meta.debtToEquity           = raw(fd, 'debtToEquity');
        meta.revenueGrowth          = raw(fd, 'revenueGrowth');
        meta.earningsGrowth         = raw(fd, 'earningsGrowth');
        meta.currentRatio           = raw(fd, 'currentRatio');
        meta.profitMargins          = raw(fd, 'profitMargins');
        meta.operatingMargins       = raw(fd, 'operatingMargins');
      }
    }

    return res.status(200).json(chartData);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch stock data', detail: err.message });
  }
}
