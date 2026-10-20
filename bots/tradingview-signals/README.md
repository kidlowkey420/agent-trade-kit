# Quiver signals for TradingView

A TradingView indicator that marks congressional and corporate-insider trades from
[Quiver Quant](https://www.quiverquant.com) on your chart, with alerts. It only draws and
alerts; it never places orders.

Pine Script can't fetch outside data, so a small generator pulls the trades from Quiver and
writes them into the script. Regenerate it to refresh the data, then paste it again.

## Use it in TradingView

1. Open [`pine/quiver-signals.pine`](pine/quiver-signals.pine) and copy all of it.
2. In TradingView, open a chart and click **Pine Editor** at the bottom.
3. Click inside the editor, press Ctrl+A (Cmd+A on a Mac) to select the starter code TradingView puts
   there, paste over it, then click **Save** and **Add to chart**. If any starter code is left, you get
   "Scripts must contain one declaration statement".
4. Open any ticker in the data. The panel in the top right says how many Quiver trades it has
   and the date the data was pulled.

On the chart:

| Marker | Meaning |
|---|---|
| Green **C** below the bar | A member of Congress disclosed a buy |
| Teal **I** below the bar | An insider disclosed an open-market buy (SEC Form 4, code P) |
| Yellow **★** with a yellow background | Cluster buy: Congress and insiders both bought within the cluster window (30 days by default) |
| Red **C** / orange **I** above the bar | Congress / insider sell |

Hover a marker for who traded, how much, and the filing date. Markers sit on the bar of the
**filing date** (when the trade became public), not the trade date, so you never see a signal
before you could have acted on it.

Settings let you hide Congress, insiders or sells, and change the cluster window.

## Alerts

Click **Alert** (the clock icon), pick **Quiver Congress & Insider Signals** as the condition,
then one of:

- **Congress buy**, **Insider buy**, **Cluster buy**, or **Congress or insider sell**, or
- **Any alert() function call**, which sends one message per bar listing every trade on it.

Because the data is embedded, an alert can only fire for trades already in the script, on the
day they were filed. Alerts are most useful right after you regenerate and paste a fresh copy.
TradingView ties an alert to the script version it was created with, so recreate your alerts
after pasting a new version.

## Regenerate the data

With a Quiver API token:

```bash
QUIVER_API_TOKEN=... npx tsx bots/tradingview-signals/src/main.ts
```

Or from a saved snapshot (`{ "congress": [...], "insiders": [...] }`, Quiver REST or connector
field names both work):

```bash
npx tsx bots/tradingview-signals/src/main.ts --input snapshot.json
```

This rewrites `pine/quiver-signals.pine` from `pine/template.pine`. Edit the template, not the
generated file.

| Env var | Default | Meaning |
|---|---|---|
| `TICKERS` | none | Comma-separated watchlist, always kept and its insider trades fetched |
| `LOOKBACK_DAYS` | `90` | How far back to keep filings |
| `MAX_TICKERS` | `300` | Tickers kept, busiest first |
| `MAX_PER_TICKER` | `40` | Most recent trades kept per ticker |
| `AS_OF` | today | Date the lookback counts back from |

## Tests

```bash
npx tsx --test bots/tradingview-signals/test/*.test.ts
```

## Backtest

[`pine/quiver-strategy.pine`](pine/quiver-strategy.pine) is a TradingView strategy that buys after
Congress or insider buys are disclosed, for the 35 stocks Congress traded most over two years.
Paste it the same way, open one of the tickers listed at its top on the **1D** chart, and open the
**Strategy Tester** tab. Settings choose the entry (Congress, insider, any or cluster buy, and a
minimum number of buyers that day), the hold time, and an optional stop loss and take profit.
Orders fill at the next day's open after the filing date, with 0.05% commission and 2 ticks of slippage.

Regenerate it from saved history (one `<TICKER>.json` per stock in a folder):

```bash
npx tsx bots/tradingview-signals/src/backtest.ts <folder> 2024-10-01 2026-10-20
```
