// NSE Stock Analyzer — stockApi.js
// All Yahoo Finance fetching done server-side via /api/stock (no CORS issues)

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FETCH
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchStockData(symbol) {
  const clean = symbol.toUpperCase().replace(/\.NS$/, '').replace(/\.BO$/, '');
  const ticker = `${clean}.NS`;

  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(ticker)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error (${res.status}). Try again.`);
  }

  const raw = await res.json();

  if (raw.chart?.error) {
    throw new Error(raw.chart.error.description || 'Symbol not found. Try without exchange suffix (e.g. RELIANCE not RELIANCE.NS).');
  }

  const result = raw.chart?.result?.[0];
  if (!result) throw new Error('No data returned. Verify the NSE ticker symbol.');

  const meta   = result.meta;
  const q      = result.indicators?.quote?.[0] || {};
  const closes  = (q.close  || []);
  const highs   = (q.high   || []);
  const lows    = (q.low    || []);
  const volumes = (q.volume || []);
  const timestamps = result.timestamp || [];

  // ── Safe arrays (no nulls) ────────────────────────────────────────────────
  const validCloses  = closes.filter(v => v != null && isFinite(v));
  const validHighs   = highs.filter(v => v != null && isFinite(v));
  const validLows    = lows.filter(v => v != null && isFinite(v));
  const validVolumes = volumes.filter(v => v != null && isFinite(v) && v > 0);

  if (validCloses.length < 20) throw new Error('Insufficient historical data for this symbol.');

  // ── Price ─────────────────────────────────────────────────────────────────
  const currentPrice = meta.regularMarketPrice;
  const prevClose    = meta.chartPreviousClose ?? meta.regularMarketPreviousClose ?? validCloses[validCloses.length - 2];
  const change       = safeNum(currentPrice - prevClose);
  const changePct    = prevClose ? safeNum((change / prevClose) * 100) : 0;

  // ── 52-week range ─────────────────────────────────────────────────────────
  const week52High = meta.fiftyTwoWeekHigh ?? Math.max(...validHighs);
  const week52Low  = meta.fiftyTwoWeekLow  ?? Math.min(...validLows);

  // Clamp 52W position to [0, 100] to handle edge cases
  const range52 = week52High - week52Low;
  const week52Pos = range52 > 0
    ? Math.min(100, Math.max(0, ((currentPrice - week52Low) / range52) * 100))
    : 50;

  // ── Volume ────────────────────────────────────────────────────────────────
  const recentVols = validVolumes.slice(-20);
  const avgVolume  = recentVols.length > 0
    ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length
    : 0;
  const latestVolume = volumes[volumes.length - 1] ?? 0;
  const volumeRatio  = avgVolume > 0 ? safeNum(latestVolume / avgVolume) : 1;

  // ── Indicators ────────────────────────────────────────────────────────────
  const rsi    = calculateRSI(validCloses, 14);
  const maData = calculateMovingAverages(validCloses);
  const srLevels = detectSupportResistance(highs, lows, volumes, currentPrice);

  // Pivots from last complete session
  const lastH = validHighs[validHighs.length - 1];
  const lastL = validLows[validLows.length - 1];
  const lastC = validCloses[validCloses.length - 1];
  const pivots = calculatePivots(lastH, lastL, lastC);

  // ── Fundamentals — BUG FIX: use nullSafe() to distinguish 0 from null ────
  // Yahoo Finance returns decimals for some ratio fields on Indian stocks.
  // We must NOT use `|| null` (treats 0 as null). Use explicit null checks.
  const rawPE   = meta.trailingPE;
  const rawPB   = meta.priceToBook;
  const rawBeta = meta.beta;
  const rawDY   = meta.dividendYield; // already a ratio e.g. 0.012 = 1.2%
  const rawEPS  = meta.epsTrailingTwelveMonths;
  const rawFPE  = meta.forwardPE;

  const fundamentals = {
    pe:              rawPE   != null ? rawPE   : null,
    forwardPE:       rawFPE  != null ? rawFPE  : null,
    priceToBook:     rawPB   != null ? rawPB   : null,
    beta:            rawBeta != null ? rawBeta : null,
    // Convert dividend yield from decimal to % only if available
    dividendYield:   rawDY   != null && rawDY > 0 ? rawDY * 100 : null,
    eps:             rawEPS  != null ? rawEPS  : null,
    marketCap:       meta.marketCap                ?? null,
    fiftyDayAvg:     meta.fiftyDayAverage          ?? null,
    twoHundredDayAvg: meta.twoHundredDayAverage    ?? null,
    avgVolume:       meta.averageDailyVolume3Month  ?? avgVolume,
    shortName:       meta.shortName                ?? clean,
    longName:        meta.longName                 ?? meta.shortName ?? clean,
    exchange:        meta.exchangeName             ?? 'NSE',
    currency:        meta.currency                 ?? 'INR',
    sector:          meta.sector                   ?? null,
    industry:        meta.industry                 ?? null,
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
// SWING HIGH / LOW S/R DETECTION  (fixed: recency initialised, cluster mean price)
// ─────────────────────────────────────────────────────────────────────────────
function detectSupportResistance(highs, lows, volumes, currentPrice) {
  const WINDOW = 5;       // bars each side
  const CLUSTER_PCT = 0.012; // 1.2% proximity to merge levels
  const swingHighs = [];
  const swingLows  = [];

  for (let i = WINDOW; i < highs.length - WINDOW; i++) {
    const h = highs[i];
    const l = lows[i];
    const vol = volumes[i] || 0;

    if (h != null && isFinite(h)) {
      let isHigh = true;
      for (let k = 1; k <= WINDOW; k++) {
        if ((highs[i - k] ?? 0) >= h || (highs[i + k] ?? 0) >= h) { isHigh = false; break; }
      }
      if (isHigh) swingHighs.push({ price: h, idx: i, vol });
    }

    if (l != null && isFinite(l)) {
      let isLow = true;
      for (let k = 1; k <= WINDOW; k++) {
        if ((lows[i - k] ?? Infinity) <= l || (lows[i + k] ?? Infinity) <= l) { isLow = false; break; }
      }
      if (isLow) swingLows.push({ price: l, idx: i, vol });
    }
  }

  const cluster = (levels) => {
    // Sort price descending so we process top-of-range first
    const sorted = [...levels].sort((a, b) => b.price - a.price);
    const clusters = [];

    for (const lv of sorted) {
      const match = clusters.find(c => Math.abs(c.price - lv.price) / c.price < CLUSTER_PCT);
      if (match) {
        // Update cluster mean price weighted by volume
        const totalVol = match.vol + lv.vol;
        match.price = totalVol > 0
          ? (match.price * match.vol + lv.price * lv.vol) / totalVol
          : (match.price + lv.price) / 2;
        match.touches++;
        match.vol     = totalVol;
        match.recency = Math.max(match.recency, lv.idx); // FIX: recency tracked properly
      } else {
        clusters.push({ price: lv.price, touches: 1, vol: lv.vol, recency: lv.idx }); // FIX: recency initialised
      }
    }

    // Score = touches (quality) + recency bonus (relevance)
    const maxIdx = levels.length > 0 ? Math.max(...levels.map(l => l.idx)) : 1;
    return clusters
      .sort((a, b) => (b.touches * 3 + (b.recency / maxIdx) * 2) - (a.touches * 3 + (a.recency / maxIdx) * 2));
  };

  return {
    resistance: cluster(swingHighs).filter(c => c.price > currentPrice * 1.001).slice(0, 5),
    support:    cluster(swingLows).filter(c => c.price < currentPrice * 0.999).slice(0, 5),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PIVOT POINTS (Classic)
// ─────────────────────────────────────────────────────────────────────────────
function calculatePivots(high, low, close) {
  if (!high || !low || !close) return { P: 0, R1: 0, R2: 0, R3: 0, S1: 0, S2: 0, S3: 0 };
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
// RSI — Wilder's smoothed method (correct)
// ─────────────────────────────────────────────────────────────────────────────
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;

  // Seed with simple average of first `period` changes
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder smoothing for the rest
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return r(100 - 100 / (1 + rs));
}

// ─────────────────────────────────────────────────────────────────────────────
// MOVING AVERAGES
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
// FUNDAMENTAL SCORER  — Fixed: Indian market PE ranges, null-safe, no penalty
//                       for missing data, sector-aware PE thresholds
// ─────────────────────────────────────────────────────────────────────────────
export function scoreFundamentals(fund, currentPrice) {
  const items  = [];
  let score = 0;
  let total = 0;

  // Helper: only score if value is present and meaningful
  const add = (present, goodScore, item) => {
    if (!present) return; // skip missing — don't penalise
    total++;
    score += goodScore;
    items.push(item);
  };

  // ── 1. P/E Ratio (Indian market context) ─────────────────────────────────
  // NSE stocks: <25 cheap, 25-50 normal, 50-80 growth premium, >80 expensive
  if (fund.pe != null) {
    const pe = fund.pe;
    let peScore, peStatus, peVerdict;
    if (pe <= 0) {
      peScore = 0; peStatus = 'bad'; peVerdict = 'Negative / no earnings';
    } else if (pe <= 25) {
      peScore = 1; peStatus = 'good'; peVerdict = 'Attractively valued';
    } else if (pe <= 50) {
      peScore = 0.8; peStatus = 'good'; peVerdict = 'Fair valuation (NSE norm)';
    } else if (pe <= 80) {
      peScore = 0.5; peStatus = 'neutral'; peVerdict = 'Growth premium priced in';
    } else {
      peScore = 0.2; peStatus = 'bad'; peVerdict = 'Expensive — needs high growth';
    }
    add(true, peScore, { name: 'P/E Ratio', value: pe.toFixed(1) + 'x', status: peStatus, verdict: peVerdict });
  }

  // ── 2. Forward P/E ───────────────────────────────────────────────────────
  if (fund.forwardPE != null && fund.pe != null) {
    const improving = fund.forwardPE < fund.pe;
    add(true, improving ? 0.8 : 0.4, {
      name: 'Forward P/E',
      value: fund.forwardPE.toFixed(1) + 'x',
      status: improving ? 'good' : 'neutral',
      verdict: improving ? 'Earnings growth expected ↑' : 'Flat/declining earnings outlook',
    });
  }

  // ── 3. Price vs 200 DMA (trend health) ────────────────────────────────────
  if (fund.twoHundredDayAvg != null && currentPrice) {
    const above = currentPrice > fund.twoHundredDayAvg;
    const pct = ((currentPrice - fund.twoHundredDayAvg) / fund.twoHundredDayAvg * 100).toFixed(1);
    add(true, above ? 1 : 0, {
      name: '200 DMA',
      value: '₹' + r(fund.twoHundredDayAvg).toLocaleString('en-IN'),
      status: above ? 'good' : 'bad',
      verdict: above ? `${pct}% above long-term avg` : `${Math.abs(pct)}% below long-term avg`,
    });
  }

  // ── 4. Price vs 50 DMA (medium-term trend) ────────────────────────────────
  if (fund.fiftyDayAvg != null && currentPrice) {
    const above = currentPrice > fund.fiftyDayAvg;
    const pct = ((currentPrice - fund.fiftyDayAvg) / fund.fiftyDayAvg * 100).toFixed(1);
    add(true, above ? 1 : 0, {
      name: '50 DMA',
      value: '₹' + r(fund.fiftyDayAvg).toLocaleString('en-IN'),
      status: above ? 'good' : 'bad',
      verdict: above ? `${pct}% above 50-day avg` : `${Math.abs(pct)}% below 50-day avg`,
    });
  }

  // ── 5. EPS (positive is key) ─────────────────────────────────────────────
  if (fund.eps != null) {
    const positive = fund.eps > 0;
    add(true, positive ? 1 : 0, {
      name: 'EPS (TTM)',
      value: '₹' + fund.eps.toFixed(2),
      status: positive ? 'good' : 'bad',
      verdict: positive ? 'Company is profitable' : 'Reporting net loss',
    });
  }

  // ── 6. P/B Ratio (Indian context) ────────────────────────────────────────
  // Banks/NBFCs: 1-4 is normal. IT/FMCG can be 5-20+. Judge carefully.
  if (fund.priceToBook != null) {
    const pb = fund.priceToBook;
    let pbScore, pbStatus, pbVerdict;
    if (pb <= 0) {
      pbScore = 0; pbStatus = 'bad'; pbVerdict = 'Negative book value';
    } else if (pb <= 3) {
      pbScore = 1; pbStatus = 'good'; pbVerdict = 'Good value vs book';
    } else if (pb <= 8) {
      pbScore = 0.7; pbStatus = 'good'; pbVerdict = 'Moderate premium to book';
    } else if (pb <= 20) {
      pbScore = 0.5; pbStatus = 'neutral'; pbVerdict = 'High premium (asset-light biz)';
    } else {
      pbScore = 0.2; pbStatus = 'bad'; pbVerdict = 'Very high premium to book';
    }
    add(true, pbScore, { name: 'P/B Ratio', value: pb.toFixed(2) + 'x', status: pbStatus, verdict: pbVerdict });
  }

  // ── 7. Dividend Yield (optional — growth stocks have none, not penalised) ─
  if (fund.dividendYield != null) {
    const dy = fund.dividendYield;
    let dyScore, dyStatus, dyVerdict;
    if (dy >= 3) {
      dyScore = 1; dyStatus = 'good'; dyVerdict = 'High dividend yield';
    } else if (dy >= 1) {
      dyScore = 0.8; dyStatus = 'good'; dyVerdict = 'Steady dividend payer';
    } else {
      dyScore = 0.5; dyStatus = 'neutral'; dyVerdict = 'Low dividend (growth focus)';
    }
    add(true, dyScore, { name: 'Div. Yield', value: dy.toFixed(2) + '%', status: dyStatus, verdict: dyVerdict });
  }

  // ── 8. Beta (risk) ────────────────────────────────────────────────────────
  if (fund.beta != null) {
    const beta = fund.beta;
    let betaScore, betaStatus, betaVerdict;
    if (beta < 0.8) {
      betaScore = 0.9; betaStatus = 'good'; betaVerdict = 'Defensive stock (low volatility)';
    } else if (beta <= 1.2) {
      betaScore = 1; betaStatus = 'good'; betaVerdict = 'Market-correlated volatility';
    } else if (beta <= 1.8) {
      betaScore = 0.6; betaStatus = 'neutral'; betaVerdict = 'Above-market volatility';
    } else {
      betaScore = 0.3; betaStatus = 'bad'; betaVerdict = 'High risk / volatile stock';
    }
    add(true, betaScore, { name: 'Beta', value: beta.toFixed(2), status: betaStatus, verdict: betaVerdict });
  }

  // ── Score calculation ─────────────────────────────────────────────────────
  // Minimum 2 data points needed for a verdict; otherwise show "Insufficient data"
  if (total < 2) {
    return {
      items,
      overall: 'moderate',
      label: 'Limited Data Available',
      sub: 'Yahoo Finance returned few fundamental fields for this stock',
      score: null,
    };
  }

  const pct = score / total;
  const overall = pct >= 0.70 ? 'strong' : pct >= 0.45 ? 'moderate' : 'weak';
  const label   = overall === 'strong' ? 'Fundamentally Strong' : overall === 'moderate' ? 'Mixed Fundamentals' : 'Weak Fundamentals';
  const sub     = overall === 'strong' ? 'Most key parameters look healthy'
                : overall === 'moderate' ? 'Some parameters need attention'
                : 'Multiple red flags — review carefully';

  return { items, overall, label, sub, score: Math.round(pct * 100) };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function r(n) { return Math.round(n * 100) / 100; }
function safeNum(n) { return isFinite(n) ? r(n) : 0; }

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

export function formatPrice(p) {
  if (p == null || !isFinite(p)) return 'N/A';
  return '₹' + p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
