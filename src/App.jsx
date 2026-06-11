import React, { useState, useCallback, useRef } from 'react';
import { fetchStockData, scoreFundamentals, formatCurrency, formatVolume, formatPrice } from './utils/stockApi';

const QUICK_PICKS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'BAJFINANCE', 'WIPRO', 'SBIN'];

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const [symbol, setSymbol]     = useState('');
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const inputRef = useRef(null);

  const analyze = useCallback(async (sym) => {
    const s = (sym || symbol).trim().toUpperCase();
    if (!s) { inputRef.current?.focus(); return; }
    setLoading(true);
    setError('');
    setData(null);
    try {
      const result = await fetchStockData(s);
      setData(result);
    } catch (e) {
      setError(e.message || 'Failed to fetch. Check symbol and try again.');
    } finally {
      setLoading(false);
    }
  }, [symbol]);


  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="header-brand">
          <div className="header-logo">NSE</div>
          <div>
            <div className="header-title">Stock Analyzer</div>
            <div className="header-sub">S/R · Pivots · Fundamentals</div>
          </div>
        </div>
        <div className="header-badges">
          <span className="header-badge">NSE · BSE</span>
          <span className="header-badge live">● LIVE</span>
        </div>
      </header>

      <main className="main">
        {/* Search */}
        <div className="search-section">
          <label className="search-label">NSE Symbol</label>
          <div className="search-row">
            <input
              ref={inputRef}
              className="search-input"
              value={symbol}
              onChange={e => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9&]/g, ''))}
              onKeyDown={e => e.key === 'Enter' && analyze()}
              placeholder="e.g. RELIANCE"
              spellCheck={false}
              autoFocus
            />
            <button className="search-btn" onClick={() => analyze()} disabled={loading || !symbol.trim()}>
              {loading
                ? <><span className="btn-spinner" /> Analyzing…</>
                : '⚡ Analyze'
              }
            </button>
          </div>
          <div className="quick-picks">
            <span className="quick-label">Quick:</span>
            {QUICK_PICKS.map(s => (
              <button key={s} className="quick-pick" onClick={() => { setSymbol(s); analyze(s); }}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="error-box">
            <span className="error-icon">⚠</span>
            <div>
              <div className="error-title">Could not fetch data</div>
              <div className="error-msg">{error}</div>
            </div>
          </div>
        )}

        {loading && (
          <div className="loading-state">
            <div className="loading-ring">
              <div /><div /><div /><div />
            </div>
            <div className="loading-text">Fetching market data for <strong>{symbol}</strong>…</div>
            <div className="loading-sub">Pulling 1-year OHLCV · Computing S/R · Scoring fundamentals</div>
          </div>
        )}

        {!loading && !data && !error && <EmptyState />}

        {data && !loading && (
          <StockReport data={data} />
        )}
      </main>

      <footer className="footer">
        <span>NSE Stock Analyzer</span>
        <span className="footer-dot">·</span>
        <span>Data via Yahoo Finance</span>
        <span className="footer-dot">·</span>
        <span>For educational purposes only — not financial advice</span>
      </footer>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-chart">
        {[40, 55, 45, 70, 60, 80, 65, 85, 75, 90].map((h, i) => (
          <div key={i} className="empty-bar" style={{ height: h + '%', animationDelay: i * 0.06 + 's' }} />
        ))}
      </div>
      <div className="empty-title">Enter any NSE symbol to begin</div>
      <div className="empty-sub">
        Get real-time price · Swing high/low S/R zones · Classic pivot points ·
        52-week range · Fundamental scoring
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function StockReport({ data }) {
  const {
    symbol, currentPrice, change, changePct,
    week52High, week52Low, week52Pos,
    srLevels, pivots, rsi, maData,
    fundamentals: fund, volumeRatio, latestVolume, avgVolume,
  } = data;

  const scored   = scoreFundamentals(fund, currentPrice);
  const isUp     = change >= 0;
  const dirClass = isUp ? 'up' : 'down';
  const sign     = isUp ? '+' : '';

  const rsiColor = rsi > 70 ? 'var(--red)' : rsi < 30 ? 'var(--green)' : 'var(--amber)';
  const rsiLabel = rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : 'Neutral';

  return (
    <div className="report">

      {/* ── Hero ── */}
      <div className="hero">
        <div className="hero-left">
          <div className="hero-symbol">{symbol}</div>
          <div className="hero-name">{fund.longName || fund.shortName}</div>
          <div className="hero-meta">
            <span className="tag">{fund.exchange}</span>
            {fund.sector && <span className="tag">{fund.sector}</span>}
            <span className="tag">{fund.currency}</span>
          </div>
        </div>
        <div className="hero-right">
          <div className={`hero-price ${dirClass}`}>{formatPrice(currentPrice)}</div>
          <div className={`hero-change ${dirClass}`}>
            {sign}₹{Math.abs(change).toFixed(2)}&nbsp;
            <span>({sign}{changePct.toFixed(2)}%)</span>
          </div>
          <div className="hero-mcap">{formatCurrency(fund.marketCap)}</div>
        </div>
      </div>

      {/* ── Stats Row ── */}
      <div className="stats-row">
        <StatCard label="RSI (14)" value={rsi ?? 'N/A'} sub={rsiLabel} valueStyle={{ color: rsiColor }} />
        <StatCard label="Volume" value={formatVolume(latestVolume)} sub={`${volumeRatio.toFixed(1)}x avg · ${formatVolume(Math.round(avgVolume))}`} valueStyle={{ color: volumeRatio > 1.5 ? 'var(--green)' : 'var(--text)' }} />
        <StatCard label="P/E (TTM)" value={fund.pe ? fund.pe.toFixed(1) + 'x' : 'N/A'} sub={fund.forwardPE ? `Fwd: ${fund.forwardPE.toFixed(1)}x` : '—'} />
        <StatCard label="EPS (TTM)" value={fund.eps != null ? '₹' + fund.eps.toFixed(2) : 'N/A'} sub={fund.eps > 0 ? 'Profitable' : fund.eps != null ? 'Loss-making' : '—'} valueStyle={{ color: fund.eps > 0 ? 'var(--green)' : fund.eps != null ? 'var(--red)' : 'var(--text)' }} />
        <StatCard label="20 / 50 SMA" value={`${maData.sma20 ? '₹' + maData.sma20.toLocaleString('en-IN') : '—'}`} sub={`200: ${maData.sma200 ? '₹' + maData.sma200.toLocaleString('en-IN') : '—'}`} />
        <StatCard label="Beta" value={fund.beta != null ? fund.beta.toFixed(2) : 'N/A'} sub={fund.beta != null ? (fund.beta < 1 ? 'Less volatile' : fund.beta < 1.5 ? 'Market-like' : 'High volatility') : '—'} />
      </div>

      {/* ── Support & Resistance ── */}
      <Section title="Support & Resistance Zones" hint="Swing H/L detection on 1Y daily data · Clusters within 1.2% merged · Ranked by touches × recency">
        <div className="sr-wrap">
          <div className="sr-col">
            <div className="sr-col-head resistance-head">▲ Resistance</div>
            {srLevels.resistance.length === 0
              ? <div className="sr-empty">No resistance zones above CMP in 1Y data</div>
              : srLevels.resistance.map((z, i) => <SRZone key={i} zone={z} type="resistance" cmp={currentPrice} />)
            }
          </div>

          <div className="sr-cmp-bar">
            <div className="sr-cmp-line" />
            <div className="sr-cmp-chip">CMP {formatPrice(currentPrice)}</div>
            <div className="sr-cmp-line" />
          </div>

          <div className="sr-col">
            <div className="sr-col-head support-head">▼ Support</div>
            {srLevels.support.length === 0
              ? <div className="sr-empty">No support zones below CMP in 1Y data</div>
              : srLevels.support.map((z, i) => <SRZone key={i} zone={z} type="support" cmp={currentPrice} />)
            }
          </div>
        </div>
      </Section>

      {/* ── Pivot Points ── */}
      <Section title="Classic Pivot Points" hint="Calculated from previous session's High / Low / Close">
        <div className="pivot-grid">
          {[
            { label: 'R3', price: pivots.R3, type: 'resistance' },
            { label: 'R2', price: pivots.R2, type: 'resistance' },
            { label: 'R1', price: pivots.R1, type: 'resistance' },
            { label: 'PP', price: pivots.P,  type: 'pivot' },
            { label: 'S1', price: pivots.S1, type: 'support' },
            { label: 'S2', price: pivots.S2, type: 'support' },
            { label: 'S3', price: pivots.S3, type: 'support' },
          ].map(row => {
            const dist = ((row.price - currentPrice) / currentPrice * 100);
            return (
              <div key={row.label} className={`pivot-row pivot-${row.type}`}>
                <span className="pivot-label">{row.label}</span>
                <span className="pivot-price">₹{row.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                <span className={`pivot-dist ${dist >= 0 ? 'up' : 'down'}`}>
                  {dist >= 0 ? '+' : ''}{dist.toFixed(2)}%
                </span>
              </div>
            );
          })}
        </div>
      </Section>

      {/* ── 52-Week Range ── */}
      <Section title="52-Week Range">
        <div className="range-panel">
          <div className="range-bar-wrap">
            <div className="range-track">
              <div className="range-fill" style={{ width: `${week52Pos}%` }} />
              <div className="range-thumb" style={{ left: `${week52Pos}%` }}>
                <div className="range-thumb-tooltip">{formatPrice(currentPrice)}</div>
              </div>
            </div>
          </div>
          <div className="range-labels">
            <div className="range-edge">
              <span className="range-edge-label">52W Low</span>
              <span className="range-edge-value down">{formatPrice(week52Low)}</span>
            </div>
            <div className="range-position">
              <span className="range-pos-num" style={{ color: week52Pos > 70 ? 'var(--green)' : week52Pos < 30 ? 'var(--red)' : 'var(--accent)' }}>
                {week52Pos.toFixed(1)}%
              </span>
              <span className="range-pos-label">of yearly range</span>
              <span className="range-pos-tag">
                {week52Pos >= 80 ? '🔥 Near yearly highs' : week52Pos <= 20 ? '🧊 Near yearly lows' : '📍 Mid-range'}
              </span>
            </div>
            <div className="range-edge" style={{ textAlign: 'right' }}>
              <span className="range-edge-label">52W High</span>
              <span className="range-edge-value up">{formatPrice(week52High)}</span>
            </div>
          </div>
          <div className="range-from-high">
            {((week52High - currentPrice) / week52High * 100).toFixed(1)}% below all-time high in range &nbsp;·&nbsp;
            {((currentPrice - week52Low) / week52Low * 100).toFixed(1)}% above yearly low
          </div>
        </div>
      </Section>

      {/* ── Fundamentals ── */}
      <Section title="Fundamental Analysis" hint="Indian market context · Missing fields excluded from score (no penalty)">
        <div className={`verdict-card ${scored.overall}`}>
          <div className="verdict-icon">
            {scored.overall === 'strong' ? '✅' : scored.overall === 'moderate' ? '⚠️' : '❌'}
          </div>
          <div className="verdict-body">
            <div className="verdict-title">{scored.label}</div>
            <div className="verdict-sub">{scored.sub}</div>
          </div>
          {scored.score != null && (
            <div className="verdict-score">
              <div className="score-ring" style={{ '--pct': scored.score }}>
                <span>{scored.score}</span>
              </div>
              <div className="score-label">/ 100</div>
            </div>
          )}
        </div>

        {scored.items.length === 0
          ? <div className="fund-empty">Yahoo Finance returned no fundamental data for this stock.</div>
          : (
            <div className="fund-grid">
              {scored.items.map((item, i) => (
                <div key={i} className={`fund-card fund-${item.status}`}>
                  <div className="fund-card-header">
                    <span className="fund-dot" />
                    <span className="fund-name">{item.name}</span>
                  </div>
                  <div className="fund-value">{item.value}</div>
                  <div className="fund-verdict">{item.verdict}</div>
                </div>
              ))}
            </div>
          )
        }
      </Section>


    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function Section({ title, hint, children }) {
  return (
    <div className="section">
      <div className="section-head">
        <span className="section-title">{title}</span>
        {hint && <span className="section-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function StatCard({ label, value, sub, valueStyle }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={valueStyle}>{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function SRZone({ zone, type, cmp }) {
  const isRes = type === 'resistance';
  const dist  = isRes
    ? ((zone.price - cmp) / cmp * 100).toFixed(2)
    : ((cmp - zone.price) / cmp * 100).toFixed(2);
  const strength = Math.min(Math.ceil(zone.touches / 1.5), 5);

  return (
    <div className={`sr-zone ${type}`}>
      <div className="sz-left">
        <div className="sz-price">₹{zone.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        <div className="sz-meta">{isRes ? '+' : '-'}{dist}% · {zone.touches} touch{zone.touches > 1 ? 'es' : ''}</div>
      </div>
      <div className="sz-dots">
        {[1,2,3,4,5].map(d => (
          <div key={d} className={`sz-dot ${d <= strength ? 'active' : ''}`} />
        ))}
      </div>
    </div>
  );
}
