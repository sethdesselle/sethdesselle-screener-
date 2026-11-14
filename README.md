# Stock Screener

A personal stock screener website for your own list of stocks.

- **Screener table** with price, day change, 30-day chart, volume, market cap, P/E, 1-month and YTD performance, 52-week range, RSI and dividend yield. Tap a column to sort.
- **Ready-made screens:** top gainers/losers, unusual volume, near 52-week high/low, uptrend/downtrend, oversold/overbought (RSI), low P/E, high dividend, upcoming earnings, analyst upside.
- **Custom filters:** sector, price, market cap, P/E, day change, RSI, dividend yield, relative volume, above the 50- or 200-day average.
- **Stock detail:** 1M/3M/6M/1Y chart plus key stats, analyst target and next earnings date.
- **Favorites** (☆) and **CSV export**. Works on phones and desktops, in light and dark mode.

## How it works

```
stocks.txt ──► GitHub Action (scripts/fetch_data.py, Yahoo Finance) ──► data/*.json ──► website (index.html)
```

The Action **Update stock data** runs:
- every hour while the US market is open (weekdays), plus once after the close,
- right after you change `stocks.txt`,
- any time you start it by hand: **Actions** tab → **Update stock data** → **Run workflow**.

No API key needed. Prices can be delayed about 15 minutes.

## Change your stock list

Edit `stocks.txt` on GitHub (pencil icon), with one ticker per line, and commit. The data refreshes a few minutes later. Big lists (hundreds or thousands of tickers) are fine. Company info (name, sector, P/E …) for very large lists fills in over a few runs.

## Files

| Path | What it is |
| --- | --- |
| `stocks.txt` | Your list of tickers |
| `index.html`, `assets/` | The website |
| `scripts/fetch_data.py` | Downloads the data |
| `.github/workflows/update-data.yml` | The schedule that runs it |
| `data/` | Generated data (don't edit by hand) |

_For information only, not financial advice._
