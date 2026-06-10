import React, { useState, useCallback } from 'react';
import { fetchStockData, scoreFundamentals, formatCurrency, formatVolume } from './utils/stockApi';

const QUICK_PICKS = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'BAJFINANCE', 'TATAMOTORS', 'WIPRO'];

export default function App() {
  const [symbol, setSymbol] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [aiSummary, setAiSummary] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  const analyze = useCallback(async (sym) => {
    const s = (sym || symbol).trim().toUpperCase();
    if (!s) return;
    setLoading(true);
    setError('');
    setData(null);
    setAiSummary('');
    try {
      const result = await fetchStockData(s);
      setData(result);
      fetchAISummary(result);
    } catch (e) {
      setError(e.message || 'Failed to fetch data. Try again or check the symbol.');
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  const fetchAISummary = async (stockData) => {
    setAiLoading(true);
    try {
      const fund = stockData.fundamentals;
      const sr = stockData.srLevels;
      const prompt = `You are a concise NSE market analyst. Given the following data for ${stockData.symbol}, provide a 3-4 sentence swing trading perspective covering: current price action vs key levels, fundamental quality, and one key risk or opportunity. Be direct and actionable. No disclaimers.

Stock: ${stockData.symbol} (${fund.shortName})
CMP: ₹${stockData.currentPrice} (${stockData.changePct > 0 ? '+' : ''}${stockData.changePct.toFixed(2)}% today)
RSI(14): ${stockData.rsi || 'N/A'}
52W Range: ₹${stockData.week52Low} - ₹${stockData.week52High}
200 DMA: ₹${fund.twoHundredDayAvg?.toFixed(0) || 'N/A'}
50 DMA: ₹${fund.fiftyDayAvg?.toFixed(0) || 'N/A'}
P/E: ${fund.pe?.toFixed(1) || 'N/A'}
Beta: ${fund.beta?.toFixed(2) || 'N/A'}
Key Resistance: ₹${sr.resistance[0]?.price || 'N/A'}, ₹${sr.resistance[1]?.price || 'N/A'}
Key Support: ₹${sr.support[0]?.price || 'N/A'}, ₹${sr.support[1]?.price || 'N/A'}
Volume ratio vs avg: ${stockData.volumeRatio.toFixed(2)}x`;

      // Uses /api/claude serverless proxy so the API key stays server-side
      const response = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const aiData = await response.json();
      const text = aiData.content?.map(b => b.text || '').join('') || 'AI analysis unavailable.';
      setAiSummary(text);
    } catch {
      setAiSummary('AI summary could not be generated. Check your API key in the .env file.');
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-brand">
          <div className="header-logo">NS</div>
          <div>
            <div className="header-title">NSE Stock Analyzer</div>
            <div className="header-sub">Support · Resistance · Fundamentals</div>
          </div>
        </div>
        <div className="header-badge">NSE · BSE · India</div>
      </header>

      <main className="main">
        <div className="search-section">
          <span className="search-label">Enter NSE Symbol</span>
          <div className="search-row">
            <input
              className="search-input"
              value={symbol}
              onChange={e => setSymbol(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && analyze()}
              placeholder="e.g. RELIANCE"
              autoFocus
            />
            <button className="search-btn" onClick={() => analyze()} disabled={loading || !symbol.trim()}>
              {loading ? 'Analyzing…' : '⚡ Analyze'}
            </button>
          </div>
          <div className="quick-picks">
            {QUICK_PICKS.map(s => (
              <button key={s} className="quick-pick" onClick={() => { setSymbol(s); analyze(s); }}>
                {s}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="error-box">⚠ {error}</div>}

        {loading && (
          <div className="loading-state">
            <div className="spinner" />
            <div className="loading-text">Fetching market data…</div>
          </div>
        )}

        {!loading && !data && !error && (
          <div className="empty-state">
            <div className="empty-icon">📊</div>
            <div className="empty-title">Enter a stock symbol to begin</div>
            <div className="empty-sub">Get real-time price, support & resistance zones, 52-week range, and fundamental analysis for any NSE stock.</div>
          </div>
        )}

        {data && !loading && <StockReport data={data} aiSummary={aiSummary} aiLoading={aiLoading} />}
      </main>

      <footer className="disclaimer">
        For educational purposes only. Not financial advice. Data via Yahoo Finance.
      </footer>
    </div>
  );
}

function StockReport({ data, aiSummary, aiLoading }) {
  const { symbol, currentPrice, change, changePct, week52High, week52Low, srLevels, pivots, rsi, maData, fundamentals, volumeRatio, latestVolume, avgVolume } = data;
  const fund = scoreFundamentals(fundamentals, currentPrice);
  const direction = change >= 0 ? 'up' : 'down';
  const sign = change >= 0 ? '+' : '';
  const week52Pos = ((currentPrice - week52Low) / (week52High - week52Low)) * 100;

  return (
    <>
      {/* Hero */}
      <div className="hero-row">
        <div className="stock-identity">
          <div className="stock-symbol">{symbol}</div>
          <div className="stock-name">{fundamentals.shortName}</div>
          <div className="stock-sector">{fundamentals.exchange} · {fundamentals.currency}</div>
        </div>
        <div className="price-block">
          <div className={`price-value ${direction}`}>₹{currentPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className={`price-change ${direction}`}>
            {sign}₹{Math.abs(change).toFixed(2)} ({sign}{changePct.toFixed(2)}%)
          </div>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="cards-grid">
        <div className="card">
          <div className="card-label">RSI (14)</div>
          <div className={`card-value ${rsi > 70 ? 'down' : rsi < 30 ? 'up' : 'neutral'}`}>{rsi || 'N/A'}</div>
          <div className="card-sub">{rsi > 70 ? 'Overbought' : rsi < 30 ? 'Oversold' : 'Neutral zone'}</div>
        </div>
        <div className="card">
          <div className="card-label">Volume</div>
          <div className={`card-value ${volumeRatio > 1.5 ? 'up' : 'neutral'}`}>{formatVolume(latestVolume)}</div>
          <div className="card-sub">{volumeRatio.toFixed(1)}x avg ({formatVolume(Math.round(avgVolume))})</div>
        </div>
        <div className="card">
          <div className="card-label">Market Cap</div>
          <div className="card-value">{formatCurrency(fundamentals.marketCap)}</div>
          <div className="card-sub">P/E: {fundamentals.pe?.toFixed(1) || 'N/A'}</div>
        </div>
        <div className="card">
          <div className="card-label">SMA 20 / 50</div>
          <div className="card-value" style={{ fontSize: 14 }}>
            ₹{maData.sma20 || 'N/A'} / ₹{maData.sma50 || 'N/A'}
          </div>
          <div className="card-sub">200 DMA: ₹{maData.sma200 || fundamentals.twoHundredDayAvg?.toFixed(0) || 'N/A'}</div>
        </div>
      </div>

      {/* S/R Levels */}
      <div className="section-header">
        <span className="section-title">Support & Resistance</span>
        <div className="section-line" />
      </div>
      <div className="sr-panel">
        <div className="sr-grid">
          {/* Resistance */}
          <div className="sr-resistance">
            <div className="sr-col-title">▲ Resistance Zones</div>
            {srLevels.resistance.length === 0 && <div style={{ color: 'var(--text3)', fontSize: 13 }}>No resistance detected above CMP</div>}
            {srLevels.resistance.map((r, i) => {
              const dist = ((r.price - currentPrice) / currentPrice * 100).toFixed(2);
              const strength = Math.min(r.touches, 5);
              return (
                <div key={i} className="sr-level">
                  <div className="sr-level-price">₹{r.price.toFixed(2)}</div>
                  <div className="sr-level-meta">
                    <div className="sr-level-dist">+{dist}% away</div>
                    <div className="sr-level-type">Touched {r.touches}x</div>
                    <div className="sr-strength">
                      {[1,2,3,4,5].map(d => <div key={d} className={`sr-dot ${d <= strength ? 'active-r' : ''}`} />)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Support */}
          <div className="sr-support">
            <div className="sr-col-title">▼ Support Zones</div>
            {srLevels.support.length === 0 && <div style={{ color: 'var(--text3)', fontSize: 13 }}>No support detected below CMP</div>}
            {srLevels.support.map((s, i) => {
              const dist = ((currentPrice - s.price) / currentPrice * 100).toFixed(2);
              const strength = Math.min(s.touches, 5);
              return (
                <div key={i} className="sr-level">
                  <div className="sr-level-price">₹{s.price.toFixed(2)}</div>
                  <div className="sr-level-meta">
                    <div className="sr-level-dist">-{dist}% away</div>
                    <div className="sr-level-type">Touched {s.touches}x</div>
                    <div className="sr-strength">
                      {[1,2,3,4,5].map(d => <div key={d} className={`sr-dot ${d <= strength ? 'active-s' : ''}`} />)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Pivot Points */}
      <div className="section-header">
        <span className="section-title">Classic Pivot Points</span>
        <div className="section-line" />
      </div>
      <div className="pivot-panel">
        <table className="pivot-table">
          <thead>
            <tr>
              <th>Level</th>
              <th>Price</th>
              <th>Distance</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {[
              { label: 'R3', price: pivots.R3, cls: 'r-val', type: 'Resistance 3' },
              { label: 'R2', price: pivots.R2, cls: 'r-val', type: 'Resistance 2' },
              { label: 'R1', price: pivots.R1, cls: 'r-val', type: 'Resistance 1' },
              { label: 'PP', price: pivots.P, cls: 'p-val', type: 'Pivot Point' },
              { label: 'S1', price: pivots.S1, cls: 's-val', type: 'Support 1' },
              { label: 'S2', price: pivots.S2, cls: 's-val', type: 'Support 2' },
              { label: 'S3', price: pivots.S3, cls: 's-val', type: 'Support 3' },
            ].map(row => {
              const dist = ((row.price - currentPrice) / currentPrice * 100);
              const sign = dist >= 0 ? '+' : '';
              return (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td className={row.cls}>₹{row.price.toFixed(2)}</td>
                  <td style={{ color: dist >= 0 ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--mono)', fontSize: 12 }}>{sign}{dist.toFixed(2)}%</td>
                  <td>{row.type}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 52-Week Range */}
      <div className="section-header">
        <span className="section-title">52-Week Range</span>
        <div className="section-line" />
      </div>
      <div className="week52-panel">
        <div className="week52-bar-wrap">
          <div className="week52-bar">
            <div className="week52-bar-fill" style={{ width: `${week52Pos}%` }} />
            <div className="week52-marker" style={{ left: `${week52Pos}%` }} />
          </div>
        </div>
        <div className="week52-labels">
          <div className="week52-label">
            <span>52W Low</span>
            ₹{week52Low.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </div>
          <div className="week52-label" style={{ textAlign: 'center' }}>
            <span>Current</span>
            ₹{currentPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </div>
          <div className="week52-label" style={{ textAlign: 'right' }}>
            <span>52W High</span>
            ₹{week52High.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </div>
        </div>
        <div className="week52-position">
          Stock is at <strong style={{ color: 'var(--accent)' }}>{week52Pos.toFixed(1)}%</strong> of its 52-week range
          {week52Pos > 80 ? ' — Near yearly highs' : week52Pos < 20 ? ' — Near yearly lows' : ''}
        </div>
      </div>

      {/* Fundamentals */}
      <div className="section-header">
        <span className="section-title">Fundamental Analysis</span>
        <div className="section-line" />
      </div>
      <div className="fundamentals-panel">
        <div className={`fundamental-verdict ${fund.overall}`}>
          <div className="verdict-icon">
            {fund.overall === 'strong' ? '✅' : fund.overall === 'moderate' ? '⚠️' : '❌'}
          </div>
          <div>
            <div className="verdict-text">{fund.label}</div>
            <div className="verdict-sub">{fund.sub} · Score: {fund.score}/100</div>
          </div>
        </div>
        <div className="fundamentals-grid">
          {fund.items.map((item, i) => (
            <div key={i} className="fund-item">
              <div className={`fund-indicator ${item.status === 'neutral' ? 'neutral-ind' : item.status}`} />
              <div className="fund-content">
                <div className="fund-name">{item.name}</div>
                <div className="fund-val">{item.value}</div>
                <div className="fund-verdict">{item.verdict}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* AI Summary */}
      <div className="section-header">
        <span className="section-title">AI Trading Perspective</span>
        <div className="section-line" />
      </div>
      <div className="ai-panel">
        <div className="ai-header">
          <div className="ai-badge">Claude AI</div>
        </div>
        {aiLoading ? (
          <div className="ai-loading">
            <div className="ai-dot" /><div className="ai-dot" /><div className="ai-dot" />
            <span>Generating analysis…</span>
          </div>
        ) : (
          <div className="ai-text">{aiSummary || 'Analysis will appear here.'}</div>
        )}
      </div>
    </>
  );
}
