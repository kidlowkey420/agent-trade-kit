# People vs Wall Street backtest

5-min chart, session VWAP + 8 EMA, entries only 9:30–10:30 ET on a retest of the
pre-market high or VWAP, ride the 8 EMA, sell half at VWAP when the trade started
on the far side of it, stop loss on every trade. See the docstring in
`pvw_backtest.py` for every interpretation choice (they are all flags).

```bash
pip install pandas numpy requests
export APCA_API_KEY_ID=...  APCA_API_SECRET_KEY=...   # Alpaca paper keys are fine
python pvw_backtest.py                                 # SPY,QQQ,NVDA,TSLA, 2016 -> today
python pvw_backtest.py --csv-dir ./mydata              # or your own 5-min CSVs (incl. pre-market)
python -m pytest -q                                    # mechanics tests
```

Outputs `results/trades.csv` (every trade) and `results/summary.csv` (win rate with a
95% Wilson interval, P&L at $50/trade, profit factor, and pass/fail against the 74.4%
go-live rule for full history, recent years, each year and each setup).

Fills are modelled conservatively: entry at the next bar's open, stop assumed to hit
before any target inside the same bar, 1 bp slippage per fill. Not financial advice.
