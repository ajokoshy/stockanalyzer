// NSE Stock Analyzer — stockApi.js  (v2 final)
// All Yahoo Finance fetching done server-side via /api/stock (no CORS)

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FETCH
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchStockData(symbol) {
  const clean  = symbol.toUpperCase().replace(/\.(NS|BO)$/i, '');
  const ticker = `${clean}.NS`;

  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(ticker)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error (${res.status}). Please try again.`);
  }

  const raw = await res.json();

  if (raw.chart?.error) {
    throw new Error(
      raw.chart.error.description ||
      'Symbol not found. Enter the NSE ticker without suffix (e.g. RELIANCE, not RELIANCE.NS).'
    );
  }

  const result = raw.chart?.result?.[0];
  if (!result) throw new Error('No data returned. Verify the NSE ticker symbol.');

  const meta      = result.meta;
  const q         = result.indicators?.quote?.[0] || {};
  const closes    = q.close  || [];
  const highs     = q.high   || [];
  const lows      = q.low    || [];
  const volumes   = q.volume || [];
  const timestamps = result.timestamp || [];

  // ── Filtered arrays (remove nulls/non-finite) ─────────────────────────────
  const validCloses  = closes.filter(v => v != null && isFinite(v));
  const validHighs   = highs.filter(v => v != null && isFinite(v));
  const validLows    = lows.filter(v => v != null && isFinite(v));
  const validVolumes = volumes.filter(v => v != null && isFinite(v) && v > 0);

  if (validCloses.length < 20) throw new Error('Insufficient historical data for this symbol.');

  // ── Price ─────────────────────────────────────────────────────────────────
  const currentPrice = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose
    ?? meta.regularMarketPreviousClose
    ?? validCloses[validCloses.length - 2]
    ?? validCloses[validCloses.length - 1];
  const change    = safeNum(currentPrice - prevClose);
  const changePct = prevClose ? safeNum((change / prevClose) * 100) : 0;

  // ── 52-week range ─────────────────────────────────────────────────────────
  const week52High = meta.fiftyTwoWeekHigh ?? Math.max(...validHighs);
  const week52Low  = meta.fiftyTwoWeekLow  ?? Math.min(...validLows);
  const range52    = week52High - week52Low;
  const week52Pos  = range52 > 0
    ? Math.min(100, Math.max(0, ((currentPrice - week52Low) / range52) * 100))
    : 50;

  // ── Volume ────────────────────────────────────────────────────────────────
  const recentVols   = validVolumes.slice(-20);
  const avgVolume    = recentVols.length > 0
    ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length
    : 0;
  // Use last valid volume (handles market-closed days where latest candle may be null)
  const latestVolume = [...volumes].reverse().find(v => v != null && v > 0) ?? 0;
  const volumeRatio  = avgVolume > 0 ? safeNum(latestVolume / avgVolume) : 1;

  // ── Indicators ────────────────────────────────────────────────────────────
  const rsi    = calculateRSI(validCloses, 14);
  const maData = calculateMovingAverages(validCloses);
  const srLevels = detectSupportResistance(highs, lows, volumes, currentPrice, validCloses.length);

  // Pivots: use last session with valid H/L/C
  const lastH = validHighs[validHighs.length - 1];
  const lastL = validLows[validLows.length - 1];
  const lastC = validCloses[validCloses.length - 1];
  const pivots = calculatePivots(lastH, lastL, lastC);
  const pivotsValid = pivots.P > 0;

  // ── Fundamentals ─────────────────────────────────────────────────────────
  const fundamentals = {
    pe:               meta.trailingPE               ?? null,
    forwardPE:        meta.forwardPE                ?? null,
    priceToBook:      meta.priceToBook              ?? null,
    beta:             meta.beta                     ?? null,
    // Yahoo returns dividendYield as decimal (0.015 = 1.5%) — convert to %
    dividendYield:    (meta.dividendYield != null && meta.dividendYield > 0)
                        ? meta.dividendYield * 100 : null,
    eps:              meta.epsTrailingTwelveMonths  ?? null,
    marketCap:        meta.marketCap                ?? null,
    fiftyDayAvg:      meta.fiftyDayAverage          ?? null,
    twoHundredDayAvg: meta.twoHundredDayAverage     ?? null,
    avgVolume:        meta.averageDailyVolume3Month  ?? avgVolume,
    shortName:        meta.shortName                ?? clean,
    longName:         meta.longName ?? meta.shortName ?? clean,
    exchange:         meta.exchangeName             ?? 'NSE',
    currency:         meta.currency                 ?? 'INR',
    sector:           meta.sector                   ?? null,
    industry:         meta.industry                 ?? null,
    returnOnEquity:   meta.returnOnEquity           ?? null,
    debtToEquity:     meta.debtToEquity             ?? null,
    revenueGrowth:    meta.revenueGrowth            ?? null,
    earningsGrowth:   meta.earningsGrowth           ?? null,
    profitMargins:    meta.profitMargins            ?? null,
    operatingMargins: meta.operatingMargins         ?? null,
    currentRatio:     meta.currentRatio             ?? null,
  };

  return {
    symbol: clean,
    ticker,
    currentPrice,
    change,
    changePct,
    week52High,
    week52Low,
    week52Pos,
    srLevels,
    pivots,
    pivotsValid,
    volumeRatio,
    latestVolume,
    avgVolume,
    rsi,
    maData,
    fundamentals,
    priceHistory: { closes: validCloses, highs: validHighs, lows: validLows, timestamps },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SWING HIGH / LOW S/R DETECTION
// ─────────────────────────────────────────────────────────────────────────────
function detectSupportResistance(highs, lows, volumes, currentPrice, totalCandles) {
  const WINDOW      = 5;      // bars each side for swing detection
  const CLUSTER_PCT = 0.012;  // merge levels within 1.2% of each other
  const swingHighs  = [];
  const swingLows   = [];

  for (let i = WINDOW; i < highs.length - WINDOW; i++) {
    const h   = highs[i];
    const l   = lows[i];
    const vol = volumes[i] ?? 0;

    // ── Swing High: must be strictly greater than all neighbours ─────────────
    if (h != null && isFinite(h)) {
      let isHigh = true;
      for (let k = 1; k <= WINDOW && isHigh; k++) {
        const left  = highs[i - k];
        const right = highs[i + k];
        // Skip comparison if neighbour candle is null (gap/holiday)
        if (left  != null && isFinite(left)  && left  >= h) isHigh = false;
        if (right != null && isFinite(right) && right >= h) isHigh = false;
      }
      if (isHigh) swingHighs.push({ price: h, idx: i, vol });
    }

    // ── Swing Low: must be strictly less than all neighbours ─────────────────
    if (l != null && isFinite(l)) {
      let isLow = true;
      for (let k = 1; k <= WINDOW && isLow; k++) {
        const left  = lows[i - k];
        const right = lows[i + k];
        if (left  != null && isFinite(left)  && left  <= l) isLow = false;
        if (right != null && isFinite(right) && right <= l) isLow = false;
      }
      if (isLow) swingLows.push({ price: l, idx: i, vol });
    }
  }

  // ── Cluster nearby levels ─────────────────────────────────────────────────
  const cluster = (levels) => {
    const sorted   = [...levels].sort((a, b) => b.price - a.price);
    const clusters = [];

    for (const lv of sorted) {
      const match = clusters.find(
        c => Math.abs(c.price - lv.price) / c.price < CLUSTER_PCT
      );
      if (match) {
        // Volume-weighted mean price
        const totalVol = match.vol + lv.vol;
        match.price = totalVol > 0
          ? (match.price * match.vol + lv.price * lv.vol) / totalVol
          : (match.price + lv.price) / 2;
        match.touches++;
        match.vol     = totalVol;
        match.recency = Math.max(match.recency, lv.idx);
      } else {
        clusters.push({ price: lv.price, touches: 1, vol: lv.vol, recency: lv.idx });
      }
    }

    // Normalise recency against total candle count for stable ranking
    const norm = totalCandles > 0 ? totalCandles : 1;
    return clusters.sort(
      (a, b) =>
        (b.touches * 3 + (b.recency / norm) * 2) -
        (a.touches * 3 + (a.recency / norm) * 2)
    );
  };

  return {
    resistance: cluster(swingHighs)
      .filter(c => c.price > currentPrice * 1.001)
      .slice(0, 5),
    support: cluster(swingLows)
      .filter(c => c.price < currentPrice * 0.999)
      .slice(0, 5),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PIVOT POINTS (Classic floor pivot)
// ─────────────────────────────────────────────────────────────────────────────
function calculatePivots(high, low, close) {
  // Guard: values must exist and be positive numbers
  if (high == null || low == null || close == null) {
    return { P: 0, R1: 0, R2: 0, R3: 0, S1: 0, S2: 0, S3: 0 };
  }
  if (!isFinite(high) || !isFinite(low) || !isFinite(close)) {
    return { P: 0, R1: 0, R2: 0, R3: 0, S1: 0, S2: 0, S3: 0 };
  }
  const P = (high + low + close) / 3;
  return {
    P:  r(P),
    R1: r(2 * P - low),
    R2: r(P + (high - low)),
    R3: r(high + 2 * (P - low)),
    S1: r(2 * P - high),
    S2: r(P - (high - low)),
    S3: r(low - 2 * (high - P)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// RSI — Wilder's smoothing (correct)
// ─────────────────────────────────────────────────────────────────────────────
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  return r(100 - 100 / (1 + avgGain / avgLoss));
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVING AVERAGES (SMA)
// ─────────────────────────────────────────────────────────────────────────────
function calculateMovingAverages(closes) {
  const sma = (n) => {
    if (closes.length < n) return null;
    const slice = closes.slice(-n);
    return r(slice.reduce((a, b) => a + b, 0) / n);
  };
  return { sma20: sma(20), sma50: sma(50), sma200: sma(200) };
}

// ─────────────────────────────────────────────────────────────────────────────
// FUNDAMENTAL SCORER
// Rules: Indian market PE norms, null-safe, missing fields skip (no penalty),
//        12 parameters across valuation / trend / quality / growth / risk
// ─────────────────────────────────────────────────────────────────────────────
export function scoreFundamentals(fund, currentPrice) {
  const items = [];
  let score = 0;
  let total = 0;

  const add = (goodScore, item) => {
    total++;
    score += goodScore;
    items.push(item);
  };

  // ── 1. P/E Ratio (NSE context) ────────────────────────────────────────────
  if (fund.pe != null) {
    const pe = fund.pe;
    let s, st, v;
    if      (pe <= 0)  { s = 0;   st = 'bad';     v = 'Negative / no earnings'; }
    else if (pe <= 25) { s = 1;   st = 'good';    v = 'Attractively valued'; }
    else if (pe <= 50) { s = 0.8; st = 'good';    v = 'Fair valuation (NSE norm)'; }
    else if (pe <= 80) { s = 0.5; st = 'neutral'; v = 'Growth premium priced in'; }
    else               { s = 0.2; st = 'bad';     v = 'Expensive — needs strong growth'; }
    add(s, { name: 'P/E Ratio', value: pe.toFixed(1) + 'x', status: st, verdict: v });
  }

  // ── 2. Forward P/E vs Trailing P/E (earnings trend) ──────────────────────
  if (fund.forwardPE != null && fund.pe != null) {
    const improving = fund.forwardPE < fund.pe;
    add(improving ? 0.8 : 0.4, {
      name: 'Forward P/E',
      value: fund.forwardPE.toFixed(1) + 'x',
      status: improving ? 'good' : 'neutral',
      verdict: improving ? 'Earnings growth expected ↑' : 'Flat / declining earnings outlook',
    });
  }

  // ── 3. EPS — must be positive ─────────────────────────────────────────────
  if (fund.eps != null) {
    const pos = fund.eps > 0;
    add(pos ? 1 : 0, {
      name: 'EPS (TTM)',
      value: '₹' + fund.eps.toFixed(2),
      status: pos ? 'good' : 'bad',
      verdict: pos ? 'Company is profitable' : 'Reporting net loss',
    });
  }

  // ── 4. Price vs 200 DMA ───────────────────────────────────────────────────
  if (fund.twoHundredDayAvg != null && currentPrice != null) {
    const above  = currentPrice > fund.twoHundredDayAvg;
    const pctNum = (currentPrice - fund.twoHundredDayAvg) / fund.twoHundredDayAvg * 100;
    const pct    = Math.abs(pctNum).toFixed(1);
    add(above ? 1 : 0, {
      name: '200 DMA',
      value: formatPrice(fund.twoHundredDayAvg),
      status: above ? 'good' : 'bad',
      verdict: above ? `${pct}% above long-term avg` : `${pct}% below long-term avg`,
    });
  }

  // ── 5. Price vs 50 DMA ────────────────────────────────────────────────────
  if (fund.fiftyDayAvg != null && currentPrice != null) {
    const above  = currentPrice > fund.fiftyDayAvg;
    const pctNum = (currentPrice - fund.fiftyDayAvg) / fund.fiftyDayAvg * 100;
    const pct    = Math.abs(pctNum).toFixed(1);
    add(above ? 1 : 0, {
      name: '50 DMA',
      value: formatPrice(fund.fiftyDayAvg),
      status: above ? 'good' : 'bad',
      verdict: above ? `${pct}% above 50-day avg` : `${pct}% below 50-day avg`,
    });
  }

  // ── 6. P/B Ratio ──────────────────────────────────────────────────────────
  if (fund.priceToBook != null) {
    const pb = fund.priceToBook;
    let s, st, v;
    if      (pb <= 0)  { s = 0;   st = 'bad';     v = 'Negative book value'; }
    else if (pb <= 3)  { s = 1;   st = 'good';    v = 'Good value vs book'; }
    else if (pb <= 8)  { s = 0.7; st = 'good';    v = 'Moderate premium to book'; }
    else if (pb <= 20) { s = 0.5; st = 'neutral'; v = 'High premium (asset-light biz)'; }
    else               { s = 0.2; st = 'bad';     v = 'Very high premium to book'; }
    add(s, { name: 'P/B Ratio', value: pb.toFixed(2) + 'x', status: st, verdict: v });
  }

  // ── 7. ROE ────────────────────────────────────────────────────────────────
  if (fund.returnOnEquity != null) {
    const roe = fund.returnOnEquity * 100;
    let s, st, v;
    if      (roe >= 20) { s = 1;   st = 'good';    v = 'Excellent capital efficiency'; }
    else if (roe >= 12) { s = 0.7; st = 'good';    v = 'Decent return on equity'; }
    else if (roe >= 5)  { s = 0.4; st = 'neutral'; v = 'Below-average ROE'; }
    else                { s = 0;   st = 'bad';     v = 'Poor capital utilisation'; }
    add(s, { name: 'ROE', value: roe.toFixed(1) + '%', status: st, verdict: v });
  }

  // ── 8. Net Profit Margin ──────────────────────────────────────────────────
  if (fund.profitMargins != null) {
    const pm = fund.profitMargins * 100;
    let s, st, v;
    if      (pm >= 20) { s = 1;   st = 'good';    v = 'High profit margins'; }
    else if (pm >= 10) { s = 0.7; st = 'good';    v = 'Healthy margins'; }
    else if (pm >= 5)  { s = 0.5; st = 'neutral'; v = 'Thin but positive margins'; }
    else if (pm >= 0)  { s = 0.2; st = 'neutral'; v = 'Very thin margins'; }
    else               { s = 0;   st = 'bad';     v = 'Loss-making operations'; }
    add(s, { name: 'Net Margin', value: pm.toFixed(1) + '%', status: st, verdict: v });
  }

  // ── 9. Revenue Growth ─────────────────────────────────────────────────────
  if (fund.revenueGrowth != null) {
    const rg = fund.revenueGrowth * 100;
    let s, st, v;
    if      (rg >= 15) { s = 1;   st = 'good';    v = 'Strong revenue growth'; }
    else if (rg >= 8)  { s = 0.7; st = 'good';    v = 'Steady revenue growth'; }
    else if (rg >= 0)  { s = 0.4; st = 'neutral'; v = 'Slow growth'; }
    else               { s = 0;   st = 'bad';     v = 'Revenue declining'; }
    add(s, {
      name: 'Rev. Growth',
      value: (rg >= 0 ? '+' : '') + rg.toFixed(1) + '%',
      status: st, verdict: v,
    });
  }

  // ── 10. Debt / Equity ─────────────────────────────────────────────────────
  if (fund.debtToEquity != null) {
    const de = fund.debtToEquity; // Yahoo returns as %, e.g. 45.2 = 45.2%
    let s, st, v;
    if      (de <= 30)  { s = 1;   st = 'good';    v = 'Very low leverage'; }
    else if (de <= 100) { s = 0.7; st = 'good';    v = 'Manageable debt levels'; }
    else if (de <= 200) { s = 0.4; st = 'neutral'; v = 'Moderate leverage'; }
    else                { s = 0.1; st = 'bad';     v = 'High debt burden'; }
    add(s, { name: 'Debt/Equity', value: de.toFixed(0) + '%', status: st, verdict: v });
  }

  // ── 11. Dividend Yield (optional — growth stocks penalised lightly) ───────
  if (fund.dividendYield != null) {
    const dy = fund.dividendYield;
    let s, st, v;
    if      (dy >= 3) { s = 1;   st = 'good';    v = 'High dividend yield'; }
    else if (dy >= 1) { s = 0.8; st = 'good';    v = 'Steady dividend payer'; }
    else              { s = 0.5; st = 'neutral'; v = 'Low dividend (growth focus)'; }
    add(s, { name: 'Div. Yield', value: dy.toFixed(2) + '%', status: st, verdict: v });
  }

  // ── 12. Beta ──────────────────────────────────────────────────────────────
  if (fund.beta != null) {
    const beta = fund.beta;
    let s, st, v;
    if      (beta < 0.8)  { s = 0.9; st = 'good';    v = 'Defensive stock (low volatility)'; }
    else if (beta <= 1.2) { s = 1;   st = 'good';    v = 'Market-correlated volatility'; }
    else if (beta <= 1.8) { s = 0.6; st = 'neutral'; v = 'Above-market volatility'; }
    else                  { s = 0.3; st = 'bad';     v = 'High risk / volatile stock'; }
    add(s, { name: 'Beta', value: beta.toFixed(2), status: st, verdict: v });
  }

  // ── Score ─────────────────────────────────────────────────────────────────
  // Need at least 2 data points for a meaningful verdict
  if (total < 2) return { items: [], overall: 'moderate', label: '', sub: '', score: null };

  const pct     = score / total;
  const overall = pct >= 0.70 ? 'strong' : pct >= 0.45 ? 'moderate' : 'weak';
  const label   = overall === 'strong'  ? 'Fundamentally Strong'
                : overall === 'moderate'? 'Mixed Fundamentals'
                : 'Weak Fundamentals';
  const sub     = overall === 'strong'  ? 'Most key parameters look healthy'
                : overall === 'moderate'? 'Some parameters need attention'
                : 'Multiple red flags — review carefully';

  return { items, overall, label, sub, score: Math.round(pct * 100) };
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTING HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function r(n) { return Math.round(n * 100) / 100; }
function safeNum(n) { return isFinite(n) ? r(n) : 0; }

export function formatPrice(p) {
  if (p == null || !isFinite(p)) return 'N/A';
  return '₹' + p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatCurrency(val) {
  if (val == null || !isFinite(val)) return 'N/A';
  const abs = Math.abs(val);
  if (abs >= 1e12) return '₹' + (val / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9)  return '₹' + (val / 1e9).toFixed(2) + 'B';
  if (abs >= 1e7)  return '₹' + (val / 1e7).toFixed(2) + ' Cr';
  if (abs >= 1e5)  return '₹' + (val / 1e5).toFixed(2) + ' L';
  return '₹' + val.toLocaleString('en-IN');
}

export function formatVolume(v) {
  if (v == null || !isFinite(v) || v === 0) return 'N/A';
  if (v >= 1e7)  return (v / 1e7).toFixed(2) + ' Cr';
  if (v >= 1e5)  return (v / 1e5).toFixed(2) + ' L';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return v.toString();
}
