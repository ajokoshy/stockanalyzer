// Fetches NSE stock data via Yahoo Finance API (free, no key needed)
// NSE symbols use .NS suffix on Yahoo Finance (e.g. RELIANCE.NS)

export async function fetchStockData(symbol) {
  const ticker = symbol.toUpperCase().endsWith('.NS')
    ? symbol.toUpperCase()
    : `${symbol.toUpperCase()}.NS`;

  // Yahoo Finance v8 quote endpoint (via allorigins CORS proxy)
  const quoteUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`;
  const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(quoteUrl)}`;

  const res = await fetch(proxyUrl);
  if (!res.ok) throw new Error('Network error fetching stock data');

  const wrapper = await res.json();
  const raw = JSON.parse(wrapper.contents);

  if (raw.chart?.error) throw new Error(raw.chart.error.description || 'Symbol not found');

  const result = raw.chart.result[0];
  const meta = result.meta;
  const quotes = result.indicators.quote[0];
  const timestamps = result.timestamp;
  const closes = quotes.close;
  const highs = quotes.high;
  const lows = quotes.low;
  const volumes = quotes.volume;

  // Current price
  const currentPrice = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose;
  const change = currentPrice - prevClose;
  const changePct = (change / prevClose) * 100;

  // 52-week high/low
  const validCloses = closes.filter(Boolean);
  const validHighs = highs.filter(Boolean);
  const validLows = lows.filter(Boolean);

  const week52High = meta.fiftyTwoWeekHigh || Math.max(...validHighs);
  const week52Low = meta.fiftyTwoWeekLow || Math.min(...validLows);

  // Support & Resistance using swing high/low detection
  const srLevels = detectSupportResistance(highs, lows, closes, volumes, currentPrice);

  // Pivot points (based on last session)
  const lastHigh = validHighs[validHighs.length - 1];
  const lastLow = validLows[validLows.length - 1];
  const lastClose = validCloses[validCloses.length - 1];
  const pivots = calculatePivots(lastHigh, lastLow, lastClose);

  // Volume analysis
  const recentVolumes = volumes.slice(-20).filter(Boolean);
  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const latestVolume = volumes[volumes.length - 1] || 0;
  const volumeRatio = latestVolume / avgVolume;

  // Momentum indicators
  const rsi = calculateRSI(closes.filter(Boolean), 14);
  const maData = calculateMovingAverages(closes.filter(Boolean));

  // Fundamental data (from meta)
  const fundamentals = {
    pe: meta.trailingPE || null,
    forwardPE: meta.forwardPE || null,
    marketCap: meta.marketCap || null,
    eps: meta.epsTrailingTwelveMonths || null,
    dividendYield: meta.dividendYield ? meta.dividendYield * 100 : null,
    beta: meta.beta || null,
    priceToBook: meta.priceToBook || null,
    fiftyDayAvg: meta.fiftyDayAverage || null,
    twoHundredDayAvg: meta.twoHundredDayAverage || null,
    avgVolume: meta.averageDailyVolume3Month || avgVolume,
    shortName: meta.shortName || symbol,
    exchange: meta.exchangeName || 'NSE',
    currency: meta.currency || 'INR',
  };

  return {
    symbol: ticker.replace('.NS', ''),
    currentPrice,
    change,
    changePct,
    week52High,
    week52Low,
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

// ── SWING HIGH/LOW S/R DETECTION ──────────────────────────────────────────────
function detectSupportResistance(highs, lows, closes, volumes, currentPrice) {
  const window = 5; // bars each side
  const swingHighs = [];
  const swingLows = [];

  for (let i = window; i < highs.length - window; i++) {
    if (!highs[i]) continue;
    const isSwingHigh = [...Array(window)].every(
      (_, k) => highs[i] >= (highs[i - k - 1] || 0) && highs[i] >= (highs[i + k + 1] || 0)
    );
    if (isSwingHigh) swingHighs.push({ price: highs[i], idx: i, vol: volumes[i] || 0 });

    if (!lows[i]) continue;
    const isSwingLow = [...Array(window)].every(
      (_, k) => lows[i] <= (lows[i - k - 1] || Infinity) && lows[i] <= (lows[i + k + 1] || Infinity)
    );
    if (isSwingLow) swingLows.push({ price: lows[i], idx: i, vol: volumes[i] || 0 });
  }

  // Cluster nearby levels (within 0.8%)
  const clusterLevels = (levels) => {
    const sorted = levels.sort((a, b) => b.price - a.price);
    const clusters = [];
    for (const level of sorted) {
      const existing = clusters.find(c => Math.abs(c.price - level.price) / c.price < 0.008);
      if (existing) {
        existing.touches++;
        existing.vol += level.vol;
        existing.recency = Math.max(existing.recency, level.idx);
      } else {
        clusters.push({ price: level.price, touches: 1, vol: level.vol, recency: level.idx });
      }
    }
    return clusters.sort((a, b) => (b.touches * 2 + b.recency / 100) - (a.touches * 2 + a.recency / 100));
  };

  const resistanceClusters = clusterLevels(swingHighs)
    .filter(c => c.price > currentPrice)
    .slice(0, 4);

  const supportClusters = clusterLevels(swingLows)
    .filter(c => c.price < currentPrice)
    .slice(0, 4);

  return { resistance: resistanceClusters, support: supportClusters };
}

// ── PIVOT POINTS ──────────────────────────────────────────────────────────────
function calculatePivots(high, low, close) {
  const P = (high + low + close) / 3;
  return {
    P: round(P),
    R1: round(2 * P - low),
    R2: round(P + (high - low)),
    R3: round(high + 2 * (P - low)),
    S1: round(2 * P - high),
    S2: round(P - (high - low)),
    S3: round(low - 2 * (high - P)),
  };
}

// ── RSI ───────────────────────────────────────────────────────────────────────
function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return round(100 - 100 / (1 + rs));
}

// ── MOVING AVERAGES ───────────────────────────────────────────────────────────
function calculateMovingAverages(closes) {
  const sma = (n) => {
    const slice = closes.slice(-n);
    return slice.length === n ? round(slice.reduce((a, b) => a + b, 0) / n) : null;
  };
  return { sma20: sma(20), sma50: sma(50), sma200: sma(200) };
}

function round(n) { return Math.round(n * 100) / 100; }

// ── FUNDAMENTAL SCORER ────────────────────────────────────────────────────────
export function scoreFundamentals(fund, currentPrice) {
  const items = [];
  let score = 0;
  let total = 0;

  // P/E Ratio
  if (fund.pe !== null) {
    total++;
    const good = fund.pe > 0 && fund.pe < 35;
    const moderate = fund.pe >= 35 && fund.pe < 60;
    score += good ? 1 : moderate ? 0.5 : 0;
    items.push({
      name: 'P/E Ratio',
      value: fund.pe.toFixed(1) + 'x',
      status: good ? 'good' : moderate ? 'neutral' : 'bad',
      verdict: good ? 'Reasonable valuation' : moderate ? 'Slightly elevated' : fund.pe < 0 ? 'Negative earnings' : 'Expensive',
    });
  }

  // Price vs 200 DMA
  if (fund.twoHundredDayAvg && currentPrice) {
    total++;
    const above = currentPrice > fund.twoHundredDayAvg;
    score += above ? 1 : 0;
    items.push({
      name: '200 DMA',
      value: '₹' + fund.twoHundredDayAvg.toFixed(0),
      status: above ? 'good' : 'bad',
      verdict: above ? 'Price above 200 DMA ↑' : 'Price below 200 DMA ↓',
    });
  }

  // Price vs 50 DMA
  if (fund.fiftyDayAvg && currentPrice) {
    total++;
    const above = currentPrice > fund.fiftyDayAvg;
    score += above ? 1 : 0;
    items.push({
      name: '50 DMA',
      value: '₹' + fund.fiftyDayAvg.toFixed(0),
      status: above ? 'good' : 'bad',
      verdict: above ? 'Price above 50 DMA ↑' : 'Price below 50 DMA ↓',
    });
  }

  // Dividend Yield
  if (fund.dividendYield !== null) {
    total++;
    const good = fund.dividendYield >= 1;
    score += good ? 1 : 0.3;
    items.push({
      name: 'Div. Yield',
      value: fund.dividendYield.toFixed(2) + '%',
      status: good ? 'good' : 'neutral',
      verdict: good ? 'Dividend paying' : 'Low / no dividend',
    });
  }

  // Beta
  if (fund.beta !== null) {
    total++;
    const good = fund.beta < 1.3;
    score += good ? 1 : 0.5;
    items.push({
      name: 'Beta',
      value: fund.beta.toFixed(2),
      status: good ? 'good' : 'neutral',
      verdict: good ? 'Low volatility' : 'High volatility',
    });
  }

  // P/B Ratio
  if (fund.priceToBook !== null) {
    total++;
    const good = fund.priceToBook > 0 && fund.priceToBook < 5;
    score += good ? 1 : 0.3;
    items.push({
      name: 'P/B Ratio',
      value: fund.priceToBook.toFixed(2) + 'x',
      status: good ? 'good' : 'bad',
      verdict: good ? 'Reasonable book value' : 'High premium to book',
    });
  }

  const pct = total > 0 ? score / total : 0;
  const overall = pct >= 0.65 ? 'strong' : pct >= 0.4 ? 'moderate' : 'weak';
  const label =
    overall === 'strong' ? 'Fundamentally Strong' :
    overall === 'moderate' ? 'Mixed Fundamentals' : 'Weak Fundamentals';
  const sub =
    overall === 'strong' ? 'Most key parameters look healthy' :
    overall === 'moderate' ? 'Some parameters need attention' : 'Several red flags detected';

  return { items, overall, label, sub, score: Math.round(pct * 100) };
}

export function formatCurrency(val) {
  if (!val) return 'N/A';
  if (val >= 1e12) return '₹' + (val / 1e12).toFixed(2) + 'T';
  if (val >= 1e9) return '₹' + (val / 1e9).toFixed(2) + 'B';
  if (val >= 1e7) return '₹' + (val / 1e7).toFixed(2) + 'Cr';
  return '₹' + val.toLocaleString('en-IN');
}

export function formatVolume(v) {
  if (!v) return 'N/A';
  if (v >= 1e7) return (v / 1e7).toFixed(2) + 'Cr';
  if (v >= 1e5) return (v / 1e5).toFixed(2) + 'L';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return v.toString();
}
