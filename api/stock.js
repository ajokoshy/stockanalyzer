// api/stock.js — Vercel Serverless Function
// Fetches Yahoo Finance chart + quoteSummary for full fundamentals.
// Crumb/cookie are cached at module level (reused across warm invocations).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

// ── Module-level crumb cache (survives warm Lambda invocations) ───────────────
let _crumbCache = null;        // { crumb, cookies, ts }
const CRUMB_TTL = 25 * 60 * 1000; // 25 minutes

async function getCrumb() {
  const now = Date.now();
  if (_crumbCache && (now - _crumbCache.ts) < CRUMB_TTL) return _crumbCache;

  try {
    // Step 1: get session cookie from Yahoo Finance
    const homeRes = await fetch('https://finance.yahoo.com/', {
      headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
    });
    const rawCookies = homeRes.headers.get('set-cookie') || '';
    const cookies = rawCookies.split(/,(?=[^ ])/)
      .map(c => c.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');

    // Step 2: get crumb using cookie
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...BASE_HEADERS, Cookie: cookies },
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb === 'null') return null;

    _crumbCache = { crumb, cookies, ts: now };
    return _crumbCache;
  } catch {
    return null;
  }
}

// ── Safe value extractor for Yahoo's {raw, fmt} objects ──────────────────────
function yval(obj, key) {
  if (obj == null || !(key in obj)) return null;
  const v = obj[key];
  if (v == null) return null;
  if (typeof v === 'object' && v !== null && 'raw' in v) return v.raw ?? null;
  return v;
}

// ── Fetch with fallback between query1 / query2 ──────────────────────────────
async function yFetch(path, extraHeaders = {}) {
  const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  let lastErr;
  for (const host of hosts) {
    try {
      const res = await fetch(host + path, { headers: { ...BASE_HEADERS, ...extraHeaders } });
      if (res.ok) return res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { symbol } = req.query;
  if (!symbol) return res.status(400).json({ error: 'Missing symbol parameter' });

  const ticker = symbol.toUpperCase().replace(/\.(NS|BO)$/i, '') + '.NS';

  try {
    // ── 1. Chart (OHLCV, always works) ────────────────────────────────────────
    const chartData = await yFetch(
      `/v8/finance/chart/${ticker}?interval=1d&range=1y&includePrePost=false`
    );

    if (chartData?.chart?.error) {
      return res.status(404).json({
        error: chartData.chart.error.description || 'Symbol not found on NSE. Check the ticker.'
      });
    }

    const meta = chartData?.chart?.result?.[0]?.meta;
    if (!meta) return res.status(404).json({ error: 'No price data returned for this symbol.' });

    // ── 2. quoteSummary (fundamentals, best-effort) ────────────────────────────
    const auth = await getCrumb();
    if (auth) {
      try {
        const modules = 'summaryDetail,defaultKeyStatistics,financialData,price';
        const summaryRes = await fetch(
          `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`,
          { headers: { ...BASE_HEADERS, Cookie: auth.cookies } }
        );

        if (summaryRes.ok) {
          const summaryData = await summaryRes.json();
          const s = summaryData?.quoteSummary?.result?.[0];

          if (s) {
            const sd = s.summaryDetail        || {};
            const ks = s.defaultKeyStatistics || {};
            const fd = s.financialData        || {};
            const pr = s.price                || {};

            // Merge into chart meta so client gets one clean object
            meta.trailingPE               = yval(sd,'trailingPE')    ?? yval(pr,'trailingPE')   ?? meta.trailingPE  ?? null;
            meta.forwardPE                = yval(sd,'forwardPE')     ?? yval(ks,'forwardPE')    ?? null;
            meta.priceToBook              = yval(ks,'priceToBook')   ?? null;
            meta.beta                     = yval(sd,'beta')          ?? yval(ks,'beta')         ?? meta.beta ?? null;
            meta.dividendYield            = yval(sd,'dividendYield') ?? yval(sd,'trailingAnnualDividendYield') ?? null;
            meta.epsTrailingTwelveMonths  = yval(ks,'trailingEps')  ?? null;
            meta.marketCap                = yval(pr,'marketCap')     ?? yval(sd,'marketCap')    ?? meta.marketCap ?? null;
            meta.fiftyDayAverage          = yval(sd,'fiftyDayAverage')      ?? meta.fiftyDayAverage      ?? null;
            meta.twoHundredDayAverage     = yval(sd,'twoHundredDayAverage') ?? meta.twoHundredDayAverage ?? null;
            meta.averageDailyVolume3Month = yval(pr,'averageDailyVolume3Month') ?? meta.averageDailyVolume3Month ?? null;
            meta.shortName                = pr.shortName  ?? meta.shortName  ?? null;
            meta.longName                 = pr.longName   ?? meta.longName   ?? null;
            meta.sector                   = pr.sector     ?? null;
            meta.industry                 = pr.industry   ?? null;
            meta.returnOnEquity           = yval(fd,'returnOnEquity')  ?? null;
            meta.debtToEquity             = yval(fd,'debtToEquity')    ?? null;
            meta.revenueGrowth            = yval(fd,'revenueGrowth')   ?? null;
            meta.earningsGrowth           = yval(fd,'earningsGrowth')  ?? null;
            meta.profitMargins            = yval(fd,'profitMargins')   ?? null;
            meta.operatingMargins         = yval(fd,'operatingMargins') ?? null;
            meta.currentRatio             = yval(fd,'currentRatio')    ?? null;
            meta._summaryOk               = true;
          }
        }
      } catch { /* silent — chart data still returned */ }
    }

    return res.status(200).json(chartData);

  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch stock data', detail: err.message });
  }
}
