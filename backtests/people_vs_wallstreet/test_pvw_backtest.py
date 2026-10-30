import pandas as pd

from pvw_backtest import Params, run_symbol, wilson


def _day(rows, date="2025-03-03"):
    """rows: list of (HH:MM, open, high, low, close, volume)."""
    idx = pd.DatetimeIndex([pd.Timestamp(f"{date} {r[0]}", tz="America/New_York") for r in rows])
    return pd.DataFrame([r[1:] for r in rows], index=idx,
                        columns=["open", "high", "low", "close", "volume"]).astype(float)


def _premarket(high=100.0):
    return [("08:00", 99, high, 98.5, 99.5, 1000), ("09:00", 99.5, 99.8, 99.0, 99.6, 1000)]


def test_pmh_retest_rides_ema_then_stops_on_ema_close():
    bars = _day(_premarket() + [
        ("09:30", 100.2, 100.8, 100.1, 100.7, 5000),   # breaks above PMH 100
        ("09:35", 100.6, 100.9, 100.02, 100.8, 5000),  # retests PMH, holds -> signal
        ("09:40", 100.8, 101.5, 100.7, 101.4, 5000),   # entry at this open
        ("09:45", 101.4, 102.0, 101.3, 101.9, 5000),
        ("09:50", 101.9, 101.95, 100.5, 100.6, 5000),  # closes below 8 EMA
        ("09:55", 100.6, 100.8, 100.4, 100.5, 5000),   # exit at this open
        ("10:00", 100.5, 100.6, 100.3, 100.4, 5000),
    ])
    trades = run_symbol("TEST", bars, Params(slippage_bps=0))
    assert len(trades) == 1
    t = trades[0]
    assert t.setup in ("PMH", "VWAP")
    assert t.entry_time == "09:40:00" and t.entry == 100.8
    assert t.stop < 100.02  # stop below the signal bar's low
    assert t.exit_reason == "ema8" and t.exit_time == "09:55:00"
    assert t.win is False  # exited at 100.6 < 100.8


def test_stop_fills_before_anything_else():
    bars = _day(_premarket() + [
        ("09:30", 100.2, 100.8, 100.1, 100.7, 5000),
        ("09:35", 100.6, 100.9, 100.02, 100.8, 5000),
        ("09:40", 100.8, 100.9, 99.0, 99.2, 5000),     # blows through the stop
        ("09:45", 99.2, 99.3, 99.0, 99.1, 5000),
    ])
    t = run_symbol("TEST", bars, Params(slippage_bps=0))[0]
    assert t.exit_reason == "stop"
    assert abs(t.exit - t.stop) < 1e-9
    assert t.ret_pct < 0


def test_no_entries_after_first_hour():
    rows = _premarket()
    rows += [(f"{h:02d}:{m:02d}", 99, 99.5, 98.9, 99.2, 1000)
             for h in (9, 10) for m in range(0, 60, 5) if (h, m) >= (9, 30)]
    rows += [("10:30", 100.2, 100.8, 100.1, 100.7, 5000),
             ("10:35", 100.6, 100.9, 100.02, 100.8, 5000),
             ("10:40", 100.8, 101.5, 100.7, 101.4, 5000)]
    assert run_symbol("TEST", _day(rows), Params()) == []


def test_wilson_interval():
    lo, hi = wilson(50, 100)
    assert 0.40 < lo < 0.41 and 0.59 < hi < 0.60
