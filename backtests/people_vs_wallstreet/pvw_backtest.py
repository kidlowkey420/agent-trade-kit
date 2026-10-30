"""People vs Wall Street backtest.

Rules (from the project's standing rules):
  * 5-minute chart, session VWAP + 8 EMA.
  * Trades only in the first hour, 9:30-10:30 ET.
  * Enter on a retest of the pre-market high (PMH) or of VWAP.
  * Ride the 8 EMA: exit when a 5-min bar closes on the wrong side of it.
  * If the trade started on the far side of VWAP (long entered below VWAP),
    sell half when price reaches VWAP.
  * Every trade has a stop loss.

Interpretation choices (the rules don't pin these down, so they are explicit
and configurable):
  * Long side by default; --short adds the mirror (pre-market low / VWAP
    rejection).
  * Retest = price was already above the level on the previous bar close, the
    signal bar's low touches the level (within --touch-bps) and the bar closes
    back above it and above the 8 EMA.
  * Entry is at the NEXT bar's open, so the signal bar is never traded on
    information it hasn't finished printing.
  * Stop = signal bar low minus --stop-buffer-bps. If a bar hits both stop and
    target, the stop is assumed to fill first (conservative).
  * Everything still open is flattened at --flat-time (default 10:30).
  * One trade per ticker per day by default (--max-trades).

Data: Alpaca v2 5-minute bars including extended hours (needs APCA_API_KEY_ID /
APCA_API_SECRET_KEY), or CSV files with columns timestamp,open,high,low,close,volume.

Not financial advice.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd

ET = "America/New_York"
GO_LIVE_WIN_RATE = 0.744


# ---------------------------------------------------------------- data

def fetch_alpaca(symbol: str, start: str, end: str, feed: str, cache_dir: Path) -> pd.DataFrame:
    import requests

    cache = cache_dir / f"{symbol}_{feed}_{start}_{end}.csv.gz"
    if cache.exists():
        return load_csv(cache)

    key = os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY")
    secret = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_SECRET_KEY")
    if not key or not secret:
        sys.exit("Set APCA_API_KEY_ID and APCA_API_SECRET_KEY (paper keys work) or pass --csv-dir.")

    url = f"https://data.alpaca.markets/v2/stocks/{symbol}/bars"
    headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
    params = {"timeframe": "5Min", "start": start, "end": end, "limit": 10000,
              "adjustment": "all", "feed": feed, "sort": "asc"}
    rows = []
    while True:
        r = requests.get(url, headers=headers, params=params, timeout=60)
        if r.status_code == 429:
            time.sleep(3)
            continue
        r.raise_for_status()
        body = r.json()
        rows.extend(body.get("bars") or [])
        token = body.get("next_page_token")
        if not token:
            break
        params["page_token"] = token
    if not rows:
        raise RuntimeError(f"No bars returned for {symbol}")
    df = pd.DataFrame(rows).rename(columns={"t": "timestamp", "o": "open", "h": "high",
                                            "l": "low", "c": "close", "v": "volume"})
    df = df[["timestamp", "open", "high", "low", "close", "volume"]]
    cache_dir.mkdir(parents=True, exist_ok=True)
    df.to_csv(cache, index=False)
    return load_csv(cache)


def load_csv(path: Path) -> pd.DataFrame:
    df = pd.read_csv(path)
    ts = pd.to_datetime(df["timestamp"], utc=True)
    df.index = ts.dt.tz_convert(ET)
    df = df[["open", "high", "low", "close", "volume"]].astype(float)
    return df[~df.index.duplicated()].sort_index()


# ---------------------------------------------------------------- strategy

@dataclass
class Params:
    side: str = "long"            # "long" or "both"
    touch_bps: float = 5.0        # how close the low must get to the level
    stop_buffer_bps: float = 5.0  # stop below signal-bar low
    slippage_bps: float = 1.0     # per fill
    entry_end: str = "10:30"      # last bar that may trigger an entry (exclusive)
    flat_time: str = "10:30"      # force-close time
    max_trades: int = 1
    notional: float = 50.0


@dataclass
class Trade:
    symbol: str
    date: str
    side: str
    setup: str
    entry_time: str
    entry: float
    stop: float
    half_at_vwap: bool
    half_filled: bool
    exit_time: str
    exit: float
    exit_reason: str
    ret_pct: float
    pnl_usd: float
    win: bool


def _t(s: str) -> pd.Timestamp:
    return pd.Timestamp(s).time()


def run_symbol(symbol: str, bars: pd.DataFrame, p: Params) -> list[Trade]:
    trades: list[Trade] = []
    t = bars.index.time
    rth_mask = (t >= _t("09:30")) & (t < _t("16:00"))
    # 8 EMA on regular-session closes, carried across days (how most charting
    # platforms show it with extended hours off).
    rth = bars[rth_mask].copy()
    rth["ema8"] = rth["close"].ewm(span=8, adjust=False).mean()

    pre_mask = (t >= _t("04:00")) & (t < _t("09:30"))
    pre = bars[pre_mask]
    pm_high = pre.groupby(pre.index.date)["high"].max()
    pm_low = pre.groupby(pre.index.date)["low"].min()

    sides = ["long"] if p.side == "long" else ["long", "short"]
    entry_end, flat = _t(p.entry_end), _t(p.flat_time)
    slip = p.slippage_bps / 1e4

    for day, d in rth.groupby(rth.index.date):
        if day not in pm_high.index or len(d) < 4:
            continue
        d = d.copy()
        tp = (d["high"] + d["low"] + d["close"]) / 3
        d["vwap"] = (tp * d["volume"]).cumsum() / d["volume"].cumsum().replace(0, np.nan)
        rows = d.to_dict("records")
        idx = list(d.index)
        n_today = 0
        i = 1
        while i < len(rows) - 1 and n_today < p.max_trades:
            bar_time = idx[i].time()
            if bar_time >= entry_end:
                break
            prev, bar = rows[i - 1], rows[i]
            signal = None
            for side in sides:
                sgn = 1 if side == "long" else -1
                levels = [("PMH" if side == "long" else "PML",
                           pm_high[day] if side == "long" else pm_low[day]),
                          ("VWAP", bar["vwap"])]
                for name, lvl in levels:
                    if lvl is None or not math.isfinite(lvl):
                        continue
                    tol = lvl * p.touch_bps / 1e4
                    was_beyond = sgn * (prev["close"] - lvl) > 0
                    touched = (bar["low"] <= lvl + tol) if sgn > 0 else (bar["high"] >= lvl - tol)
                    held = sgn * (bar["close"] - lvl) > 0 and sgn * (bar["close"] - bar["ema8"]) > 0
                    if was_beyond and touched and held:
                        signal = (side, name, lvl)
                        break
                if signal:
                    break
            if not signal:
                i += 1
                continue

            side, setup, _lvl = signal
            sgn = 1 if side == "long" else -1
            e_i = i + 1
            entry = rows[e_i]["open"] * (1 + sgn * slip)
            extreme = bar["low"] if sgn > 0 else bar["high"]
            stop = extreme * (1 - sgn * p.stop_buffer_bps / 1e4)
            if sgn * (entry - stop) <= 0:  # gapped through the stop already
                i += 1
                continue
            vwap_at_entry = rows[i]["vwap"]
            half_at_vwap = sgn * (vwap_at_entry - entry) > 0  # entered on far side of VWAP
            half_filled = False
            realized = 0.0  # sum of signed returns weighted by size
            remaining = 1.0
            exit_px, exit_reason, x_i = None, None, e_i

            for j in range(e_i, len(rows)):
                b = rows[j]
                x_i = j
                if idx[j].time() >= flat:
                    exit_px, exit_reason = b["open"], "time"
                    break
                stop_hit = (b["low"] <= stop) if sgn > 0 else (b["high"] >= stop)
                if stop_hit:
                    gap_through = sgn * (b["open"] - stop) < 0
                    exit_px, exit_reason = (b["open"] if gap_through else stop), "stop"
                    break
                if half_at_vwap and not half_filled:
                    target = b["vwap"]
                    if (b["high"] >= target) if sgn > 0 else (b["low"] <= target):
                        fill = target * (1 - sgn * slip)
                        realized += 0.5 * sgn * (fill - entry) / entry
                        remaining = 0.5
                        half_filled = True
                # 8 EMA trail: close on wrong side -> out at next open
                if sgn * (b["close"] - b["ema8"]) < 0 and j + 1 < len(rows):
                    exit_px, exit_reason, x_i = rows[j + 1]["open"], "ema8", j + 1
                    break
            if exit_px is None:
                exit_px, exit_reason = rows[x_i]["close"], "eod"
            exit_fill = exit_px * (1 - sgn * slip)
            realized += remaining * sgn * (exit_fill - entry) / entry
            trades.append(Trade(
                symbol=symbol, date=str(day), side=side, setup=setup,
                entry_time=str(idx[e_i].time()), entry=round(entry, 4), stop=round(stop, 4),
                half_at_vwap=half_at_vwap, half_filled=half_filled,
                exit_time=str(idx[x_i].time()), exit=round(exit_px, 4), exit_reason=exit_reason,
                ret_pct=round(realized * 100, 4), pnl_usd=round(realized * p.notional, 4),
                win=realized > 0,
            ))
            n_today += 1
            i = x_i + 1
    return trades


# ---------------------------------------------------------------- reporting

def wilson(wins: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    ph = wins / n
    denom = 1 + z * z / n
    centre = (ph + z * z / (2 * n)) / denom
    half = z * math.sqrt(ph * (1 - ph) / n + z * z / (4 * n * n)) / denom
    return centre - half, centre + half


def summarize(df: pd.DataFrame) -> dict:
    n = len(df)
    w = int(df["win"].sum()) if n else 0
    lo, hi = wilson(w, n)
    gains = df.loc[df["pnl_usd"] > 0, "pnl_usd"].sum()
    losses = -df.loc[df["pnl_usd"] < 0, "pnl_usd"].sum()
    return {
        "trades": n,
        "win_rate": round(w / n, 4) if n else float("nan"),
        "ci95_low": round(lo, 4), "ci95_high": round(hi, 4),
        "avg_ret_pct": round(df["ret_pct"].mean(), 4) if n else float("nan"),
        "total_pnl_usd": round(df["pnl_usd"].sum(), 2),
        "profit_factor": round(gains / losses, 3) if losses else float("inf"),
        "passes_744": bool(n and w / n >= GO_LIVE_WIN_RATE),
    }


def report(trades: pd.DataFrame, recent_from: str) -> pd.DataFrame:
    out = []
    trades = trades.copy()
    trades["year"] = trades["date"].str[:4]
    recent = trades[trades["date"] >= recent_from]
    for label, frame in [("full", trades), (f"recent (>= {recent_from})", recent)]:
        out.append({"scope": label, "symbol": "ALL", **summarize(frame)})
        for sym, g in frame.groupby("symbol"):
            out.append({"scope": label, "symbol": sym, **summarize(g)})
    for yr, g in trades.groupby("year"):
        out.append({"scope": f"year {yr}", "symbol": "ALL", **summarize(g)})
    for setup, g in trades.groupby("setup"):
        out.append({"scope": f"setup {setup}", "symbol": "ALL", **summarize(g)})
    return pd.DataFrame(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbols", default="SPY,QQQ,NVDA,TSLA")
    ap.add_argument("--start", default="2016-01-01")
    ap.add_argument("--end", default=pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d"))
    ap.add_argument("--recent-from", default="2024-01-01")
    ap.add_argument("--feed", default="sip", help="Alpaca feed: sip (default) or iex")
    ap.add_argument("--csv-dir", help="Read <SYMBOL>.csv[.gz] from here instead of Alpaca")
    ap.add_argument("--cache-dir", default=str(Path(__file__).parent / "data"))
    ap.add_argument("--out-dir", default=str(Path(__file__).parent / "results"))
    ap.add_argument("--short", action="store_true", help="also trade the short mirror")
    ap.add_argument("--flat-time", default="10:30")
    ap.add_argument("--max-trades", type=int, default=1)
    ap.add_argument("--touch-bps", type=float, default=5.0)
    ap.add_argument("--stop-buffer-bps", type=float, default=5.0)
    ap.add_argument("--slippage-bps", type=float, default=1.0)
    ap.add_argument("--notional", type=float, default=50.0)
    a = ap.parse_args(argv)

    p = Params(side="both" if a.short else "long", touch_bps=a.touch_bps,
               stop_buffer_bps=a.stop_buffer_bps, slippage_bps=a.slippage_bps,
               flat_time=a.flat_time, max_trades=a.max_trades, notional=a.notional)

    all_trades: list[Trade] = []
    coverage = []
    for sym in [s.strip().upper() for s in a.symbols.split(",") if s.strip()]:
        if a.csv_dir:
            cands = [Path(a.csv_dir) / f"{sym}.csv", Path(a.csv_dir) / f"{sym}.csv.gz"]
            path = next((c for c in cands if c.exists()), None)
            if not path:
                print(f"skip {sym}: no CSV", file=sys.stderr)
                continue
            bars = load_csv(path)
        else:
            bars = fetch_alpaca(sym, a.start, a.end, a.feed, Path(a.cache_dir))
        coverage.append(f"{sym}: {bars.index.min().date()} -> {bars.index.max().date()} ({len(bars)} bars)")
        all_trades.extend(run_symbol(sym, bars, p))

    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    trades = pd.DataFrame([asdict(t) for t in all_trades])
    if trades.empty:
        print("No trades.")
        return 1
    trades.to_csv(out / "trades.csv", index=False)
    rep = report(trades, a.recent_from)
    rep.to_csv(out / "summary.csv", index=False)
    print("Data coverage:\n  " + "\n  ".join(coverage))
    print(f"\nParams: {asdict(p)}\n")
    with pd.option_context("display.width", 200, "display.max_rows", 200):
        print(rep.to_string(index=False))
    print(f"\nGo-live bar: {GO_LIVE_WIN_RATE:.1%} win rate on full history AND recent years.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
