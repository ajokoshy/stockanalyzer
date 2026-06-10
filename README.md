# NSE Stock Analyzer

A real-time NSE stock analysis web app that shows:
- **Current Market Price** with intraday change
- **High-probability Support & Resistance zones** (swing high/low clustering algorithm)
- **Classic Pivot Points** (R1/R2/R3, S1/S2/S3)
- **52-Week High/Low** with visual range bar
- **Fundamental Analysis** (P/E, P/B, Beta, DMA, Dividend Yield)
- **AI Trading Perspective** via Claude (Anthropic)

---

## Tech Stack

- React 18 + Vite
- Yahoo Finance API (free, no key needed for price/fundamental data)
- Anthropic Claude API (for AI summary)
- Vercel Serverless Functions (secure API proxy)

---

## Local Development

### 1. Clone the repo
```bash
git clone https://github.com/YOUR_USERNAME/nse-stock-analyzer.git
cd nse-stock-analyzer
```

### 2. Install dependencies
```bash
npm install
```

### 3. Set up environment variables
```bash
cp .env.example .env.local
# Edit .env.local and add your Anthropic API key
```

### 4. Run locally (with Vercel CLI for API routes)
```bash
npm install -g vercel
vercel dev
```
> Using `vercel dev` instead of `npm run dev` ensures the `/api/claude` serverless function works locally.

---

## Deploy to Vercel

### Option A — Vercel Dashboard (Recommended)

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **New Project** → Import your GitHub repo
3. Vercel auto-detects Vite. Click **Deploy**
4. After deploy, go to **Project Settings → Environment Variables**
5. Add: `ANTHROPIC_API_KEY` = your key
6. **Redeploy** (Settings → Deployments → Redeploy)

### Option B — Vercel CLI

```bash
npm install -g vercel
vercel login
vercel --prod
# Follow prompts, then add env variable:
vercel env add ANTHROPIC_API_KEY
vercel --prod   # redeploy with the new env var
```

---

## How Support & Resistance Works

The app uses a **swing high/low detection algorithm** on 1-year daily OHLC data:

1. Scans every candle with a ±5 bar window to find local peaks (swing highs) and troughs (swing lows)
2. Clusters nearby levels within 0.8% of each other
3. Ranks clusters by **touches × recency** — more touches + more recent = higher probability level
4. Shows top 4 resistance zones above CMP and top 4 support zones below CMP
5. Strength dots (1–5) show how many times the level has been tested

---

## Supported Symbols

Any NSE symbol works — enter without `.NS` suffix:
- `RELIANCE`, `TCS`, `HDFCBANK`, `INFY`, `ICICIBANK`
- `BAJFINANCE`, `NIFTY50` (as `^NSEI`), `SENSEX` (as `^BSESN`)
- Indices: `^NSEI` for Nifty 50, `^BSESN` for Sensex

---

## Disclaimer

This tool is for **educational purposes only**. Not financial advice. Always do your own research before trading.
