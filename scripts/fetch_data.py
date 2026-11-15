#!/usr/bin/env python3
"""Download data for every ticker in stocks.txt and write the JSON files the website reads.

Outputs (in data/):
  stocks.json        - one row per stock: price, change, technicals, fundamentals, 30-day sparkline
  history.json       - one year of daily closes per stock (loaded by the site only when you open a chart)
  fundamentals.json  - cache of slower company info (name, sector, P/E, P/S ...), refreshed about once a day
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re
import sys
import time
from pathlib import Path

import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parent.parent
LIST_FILE = ROOT / "stocks.txt"
DATA_DIR = ROOT / "data"
FUND_FILE = DATA_DIR / "fundamentals.json"
# Optional: stocks being considered for the watchlist. They are NOT shown on the site; their numbers
# are saved to data/candidates.json so the Tier 1 gates can be run on them before they are added.
CAND_FILE = ROOT / "candidates.txt"
CAND_MAX = 80

BATCH_SIZE = 150            # tickers per price download
FUND_MAX_AGE_HOURS = 20     # refresh company info roughly once a day
FUND_PER_RUN = 250          # cap per run so huge lists don't hit Yahoo rate limits; the rest fill in next run
SPARK_DAYS = 30


# ---------------------------------------------------------------- helpers

def read_tickers(path: Path = LIST_FILE) -> list[str]:
    tickers, seen = [], set()
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0]
        for tok in re.split(r"[\s,;]+", line):
            t = tok.strip().upper().lstrip("$")
            if not t:
                continue
            # Class shares: BRK.B -> BRK-B (Yahoo format). Leaves exchange suffixes like SHOP.TO alone.
            if re.fullmatch(r"[A-Z]{1,5}\.[A-Z]", t):
                t = t.replace(".", "-")
            if t not in seen:
                seen.add(t)
                tickers.append(t)
    return tickers


def num(x, digits: int | None = None):
    """Convert to a JSON-safe float (None for missing/NaN), optionally rounded."""
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    if digits is None:
        digits = 2 if abs(f) >= 1 else 4
    return round(f, digits)


def pct(a, b):
    a, b = num(a, 8), num(b, 8)
    if a is None or b is None or b == 0:
        return None
    return num((a / b - 1) * 100, 2)


def pctval(x):
    """Yahoo gives ratios like 0.31; store as a percentage (31.0)."""
    v = num(x, 6)
    return None if v is None else num(v * 100, 1)


def rsi(close: pd.Series, period: int = 14):
    if len(close) <= period:
        return None
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    g, l = gain.iloc[-1], loss.iloc[-1]
    if l == 0:
        return 100.0
    return num(100 - 100 / (1 + g / l), 1)


# ---------------------------------------------------------------- prices

def download_prices(tickers: list[str]) -> dict[str, pd.DataFrame]:
    frames: dict[str, pd.DataFrame] = {}
    for i in range(0, len(tickers), BATCH_SIZE):
        batch = tickers[i:i + BATCH_SIZE]
        print(f"Downloading prices {i + 1}-{i + len(batch)} of {len(tickers)}", flush=True)
        for attempt in range(3):
            try:
                raw = yf.download(batch, period="1y", interval="1d", group_by="ticker",
                                  auto_adjust=True, threads=True, progress=False)
                break
            except Exception as e:  # network hiccup / rate limit
                print(f"  download failed ({e}); retrying", flush=True)
                time.sleep(10 * (attempt + 1))
        else:
            continue
        if raw is None or raw.empty:
            continue
        for t in batch:
            try:
                if isinstance(raw.columns, pd.MultiIndex):
                    if t not in raw.columns.get_level_values(0):
                        continue
                    df = raw[t]
                else:
                    df = raw
                df = df.dropna(subset=["Close"])
                if not df.empty:
                    frames[t] = df
            except Exception as e:
                print(f"  {t}: {e}", flush=True)
    return frames


def price_metrics(df: pd.DataFrame) -> dict:
    close, vol = df["Close"], df["Volume"].fillna(0)
    price = close.iloc[-1]
    prev = close.iloc[-2] if len(close) > 1 else None

    def back(n):
        return pct(price, close.iloc[-1 - n]) if len(close) > n else None

    last_date = close.index[-1]
    before_year = close[close.index < pd.Timestamp(year=last_date.year, month=1, day=1, tz=close.index.tz)]
    avg_vol = vol.iloc[-21:-1].mean() if len(vol) > 1 else None

    def sma(n):
        return num(close.tail(n).mean()) if len(close) >= n else None

    high52, low52 = df["High"].max(), df["Low"].min()
    return {
        "price": num(price),
        "change": num(price - prev) if prev is not None else None,
        "changePct": pct(price, prev),
        "volume": int(vol.iloc[-1]),
        "avgVolume": int(avg_vol) if avg_vol and not math.isnan(avg_vol) else None,
        "relVolume": num(vol.iloc[-1] / avg_vol, 2) if avg_vol else None,
        "high52": num(high52),
        "low52": num(low52),
        "fromHigh": pct(price, high52),
        "fromLow": pct(price, low52),
        "sma20": sma(20),
        "sma50": sma(50),
        "sma200": sma(200),
        "rsi": rsi(close),
        "perfW1": back(5),
        "perfM1": back(21),
        "perfM3": back(63),
        "perfM6": back(126),
        "perfYtd": pct(price, before_year.iloc[-1]) if not before_year.empty else None,
        "perfY1": pct(price, close.iloc[0]) if len(close) >= 240 else None,
        "spark": [num(x) for x in close.tail(SPARK_DAYS)],
        "lastDate": last_date.strftime("%Y-%m-%d"),
    }


# ---------------------------------------------------------------- fundamentals

def load_fund_cache() -> dict:
    try:
        return json.loads(FUND_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


# Bump this when fetch_gate_data collects something new, so saved entries are refreshed once.
GATE_VERSION = 2


def _series(df, names, n=5):
    """First matching income-statement row as a list, newest year first."""
    for name in names:
        try:
            if name in df.index:
                return [num(v, 4) for v in df.loc[name].tolist()[:n]]
        except Exception:
            pass
    return None


def fetch_gate_data(tk, info: dict) -> dict:
    """Raw numbers behind the Tier 1 gates (multi-year growth, debt, analyst estimates).

    Kept only in fundamentals.json (key "_gate"), not in stocks.json. Every piece is optional:
    if Yahoo doesn't return something, it is simply left out.
    """
    g = {}
    for src, key in (("totalDebt", "totalDebt"), ("totalCash", "totalCash"), ("ebitda", "ebitda"), ("bookValue", "bookValue"),
                     ("returnOnEquity", "roe"), ("forwardEps", "forwardEps"), ("freeCashflow", "fcf"),
                     ("sharesOutstanding", "shares"), ("earningsGrowth", "earningsGrowth")):
        g[key] = num(info.get(src), 4)
    try:
        inc = tk.income_stmt
        if inc is not None and not inc.empty:
            g["years"] = [str(c)[:10] for c in inc.columns[:5]]
            g["revenue"] = _series(inc, ["Total Revenue", "Operating Revenue"])
            g["eps"] = _series(inc, ["Diluted EPS", "Basic EPS"])
            g["opIncome"] = _series(inc, ["Operating Income", "Total Operating Income As Reported"])
            g["netIncome"] = _series(inc, ["Net Income", "Net Income Common Stockholders"])
            g["ebitdaHist"] = _series(inc, ["EBITDA", "Normalized EBITDA"])
            g["interest"] = _series(inc, ["Interest Expense", "Interest Expense Non Operating"])
    except Exception as e:
        print(f"  income statement {tk.ticker}: {e}", flush=True)
    for attr, key in (("revenue_estimate", "revEst"), ("earnings_estimate", "epsEst"), ("eps_trend", "epsTrend")):
        try:
            df = getattr(tk, attr)
            if df is not None and not df.empty:
                out = {}
                for period in ("0y", "+1y"):
                    if period in df.index:
                        out[period] = {str(c): num(df.loc[period, c], 4) for c in df.columns}
                g[key] = out
        except Exception as e:
            print(f"  {attr} {tk.ticker}: {e}", flush=True)
    # Cash flow: yearly history plus the last four quarters added up (trailing twelve months).
    # Stock-based compensation is needed for the stock-pay adjustment in the fair value method.
    cf_rows = (("ocf", ["Operating Cash Flow"]), ("capex", ["Capital Expenditure"]),
               ("fcfHist", ["Free Cash Flow"]), ("sbc", ["Stock Based Compensation"]))
    try:
        cf = tk.cashflow
        if cf is not None and not cf.empty:
            for key, names in cf_rows:
                g[key + ("" if key.endswith("Hist") else "Hist")] = _series(cf, names)
    except Exception as e:
        print(f"  cash flow {tk.ticker}: {e}", flush=True)
    try:
        qcf = tk.quarterly_cashflow
        if qcf is not None and not qcf.empty and len(qcf.columns) >= 4:
            g["cfQuarters"] = [str(c)[:10] for c in qcf.columns[:4]]
            for key, names in cf_rows:
                vals = _series(qcf, names, 4)
                if vals and all(v is not None for v in vals):
                    g[key.replace("Hist", "") + "Ttm"] = round(sum(vals), 2)
    except Exception as e:
        print(f"  quarterly cash flow {tk.ticker}: {e}", flush=True)
    # Quarterly income statement: used for the red-flag checks (sales down on a year ago, share count up).
    try:
        qi = tk.quarterly_income_stmt
        if qi is not None and not qi.empty:
            g["quarters"] = [str(c)[:10] for c in qi.columns[:6]]
            g["qRevenue"] = _series(qi, ["Total Revenue", "Operating Revenue"], 6)
            g["qOpIncome"] = _series(qi, ["Operating Income", "Total Operating Income As Reported"], 6)
            g["qShares"] = _series(qi, ["Diluted Average Shares", "Basic Average Shares"], 6)
            g["qEps"] = _series(qi, ["Diluted EPS", "Basic EPS"], 6)
    except Exception as e:
        print(f"  quarterly income {tk.ticker}: {e}", flush=True)
    for src, key in (("enterpriseValue", "ev"), ("totalRevenue", "revenueTtm"), ("operatingCashflow", "ocfInfo"),
                     ("grossMargins", "grossMargin"), ("ebitdaMargins", "ebitdaMargin")):
        g[key] = num(info.get(src), 4)
    g["v"] = GATE_VERSION
    return g


def fetch_info(t: str) -> dict | None:
    for attempt in range(2):
        try:
            tk = yf.Ticker(t)
            info = tk.info or {}
            break
        except Exception as e:
            print(f"  info {t}: {e}", flush=True)
            time.sleep(5 * (attempt + 1))
    else:
        return None
    if not info:
        return None
    earnings = info.get("earningsTimestampStart") or info.get("earningsTimestamp")
    return {
        "name": info.get("shortName") or info.get("longName"),
        "sector": info.get("sector") or ("ETF" if info.get("quoteType") == "ETF" else None),
        "industry": info.get("industry") or info.get("category"),
        "type": info.get("quoteType"),
        "exchange": info.get("exchange"),
        "currency": info.get("currency"),
        "marketCap": info.get("marketCap") or info.get("totalAssets"),
        "pe": num(info.get("trailingPE")),
        "forwardPe": num(info.get("forwardPE")),
        "ps": num(info.get("priceToSalesTrailing12Months")),
        # Margins as percentages; used with P/S for the margin-adjusted P/S on the site.
        "opMargin": pctval(info.get("operatingMargins")),
        "netMargin": pctval(info.get("profitMargins")),
        "revGrowth": pctval(info.get("revenueGrowth")),
        "eps": num(info.get("trailingEps")),
        "dividendRate": num(info.get("dividendRate") or info.get("trailingAnnualDividendRate")),
        "beta": num(info.get("beta")),
        "targetPrice": num(info.get("targetMeanPrice")),
        "rating": info.get("recommendationKey"),
        "analysts": info.get("numberOfAnalystOpinions"),
        "earningsDate": dt.datetime.fromtimestamp(earnings, dt.timezone.utc).strftime("%Y-%m-%d") if earnings else None,
        "_gate": fetch_gate_data(tk, info) if info.get("quoteType") == "EQUITY" else {},
        "_fetched": time.time(),
    }


def refresh_fundamentals(tickers: list[str]) -> dict:
    cache = load_fund_cache()
    now = time.time()
    # Also refresh entries saved before a field was added (e.g. "ps", "opMargin"), so new columns fill in on the next run.
    stale = [t for t in tickers
             if now - cache.get(t, {}).get("_fetched", 0) > FUND_MAX_AGE_HOURS * 3600 or "opMargin" not in cache.get(t, {}) or "_gate" not in cache.get(t, {})
             or (cache.get(t, {}).get("type") == "EQUITY" and cache.get(t, {}).get("_gate", {}).get("v", 1) < GATE_VERSION)]
    stale.sort(key=lambda t: cache.get(t, {}).get("_fetched", 0))  # oldest first
    todo = stale[:FUND_PER_RUN]
    print(f"Refreshing company info for {len(todo)} of {len(stale)} stale tickers", flush=True)
    failures_in_a_row = 0
    for i, t in enumerate(todo, 1):
        info = fetch_info(t)
        if info:
            cache[t] = info
            failures_in_a_row = 0
        else:
            failures_in_a_row += 1
            if failures_in_a_row >= 8:
                print("  Yahoo is refusing company-info requests; keeping cached info and trying again next run", flush=True)
                break
        if i % 25 == 0:
            print(f"  {i}/{len(todo)}", flush=True)
        time.sleep(0.25)
    # Drop tickers no longer on the list
    return {t: v for t, v in cache.items() if t in set(tickers)}


# ---------------------------------------------------------------- main

def main() -> int:
    tickers = read_tickers()
    if not tickers:
        print("stocks.txt has no tickers", file=sys.stderr)
        return 1
    print(f"{len(tickers)} tickers in stocks.txt", flush=True)

    frames = download_prices(tickers)
    # Yahoo sometimes drops a symbol from a big batch; retry those once on their own.
    retry = [t for t in tickers if t not in frames]
    if frames and retry:
        print(f"Retrying {len(retry)} tickers with no data: {', '.join(retry)}", flush=True)
        time.sleep(5)
        frames.update(download_prices(retry))
    if not frames:
        print("No price data downloaded; keeping previous data files.", file=sys.stderr)
        return 1
    fund = refresh_fundamentals(tickers)

    stocks, missing = [], []
    for t in tickers:
        df = frames.get(t)
        if df is None:
            missing.append(t)
            continue
        try:
            row = {"symbol": t}
            info = fund.get(t, {})
            row.update({k: v for k, v in info.items() if not k.startswith("_")})
            row["name"] = row.get("name") or t
            row.update(price_metrics(df))
            if row.get("dividendRate") and row.get("price"):
                row["dividendYield"] = num(row["dividendRate"] / row["price"] * 100, 2)
            stocks.append(row)
        except Exception as e:
            print(f"  {t}: could not compute metrics ({e})", flush=True)
            missing.append(t)

    # One shared date axis for the history file keeps it compact.
    all_dates = sorted({d for df in frames.values() for d in df.index.strftime("%Y-%m-%d")})
    history = {"dates": all_dates, "closes": {}}
    for t, df in frames.items():
        s = pd.Series(df["Close"].values, index=df.index.strftime("%Y-%m-%d"))
        s = s[~s.index.duplicated(keep="last")].reindex(all_dates)
        history["closes"][t] = [num(x) for x in s]

    updated = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    DATA_DIR.mkdir(exist_ok=True)
    out = {"updated": updated, "count": len(stocks), "missing": missing, "stocks": stocks}
    (DATA_DIR / "stocks.json").write_text(json.dumps(out, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    history["updated"] = updated
    (DATA_DIR / "history.json").write_text(json.dumps(history, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    FUND_FILE.write_text(json.dumps(fund, indent=0, sort_keys=True, allow_nan=False), encoding="utf-8")

    print(f"Wrote {len(stocks)} stocks; no data for {len(missing)}: {', '.join(missing) or '-'}", flush=True)
    try:
        write_candidates(set(tickers), updated)
    except Exception as e:  # never let the optional candidates file break the main update
        print(f"candidates: skipped ({e})", flush=True)
    return 0


def write_candidates(have: set, updated: str) -> None:
    """Fetch the same numbers for the tickers in candidates.txt (if the file exists)."""
    if not CAND_FILE.exists():
        return
    cands = [t for t in read_tickers(CAND_FILE) if t not in have][:CAND_MAX]
    if not cands:
        return
    print(f"{len(cands)} watchlist candidates", flush=True)
    frames = download_prices(cands)
    out, missing = {}, []
    for t in cands:
        df = frames.get(t)
        info = fetch_info(t) if df is not None else None
        if df is None or not info:
            missing.append(t)
            continue
        row = dict(info)
        row.pop("_fetched", None)
        row.update(price_metrics(df))
        out[t] = row
        time.sleep(0.4)
    (DATA_DIR / "candidates.json").write_text(
        json.dumps({"updated": updated, "missing": missing, "stocks": out}, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(f"Wrote {len(out)} candidates; no data for: {', '.join(missing) or '-'}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
