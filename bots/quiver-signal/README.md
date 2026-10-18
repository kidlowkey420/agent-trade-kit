# Quiver signal bot

Paper-trades US stock perps on [Liquid](https://liquid.trade) (e.g. `xyz:AAPL`) when **members of Congress and company insiders** have both recently bought the same stock, using [Quiver Quant](https://www.quiverquant.com) data.

Liquid has no API key, so orders go through Liquid's **Co-Invest Computer** connector, driven by a scheduled Claude routine twice each weekday. The script in this folder does the deterministic part (signals, limits, sizing) and places no orders itself.

## How a run works

1. The routine confirms the connector is in **Paper** mode, and stops otherwise.
2. It fetches Liquid's stock markets and the open paper positions.
3. The script pulls recent congressional purchases from Quiver (filed in the last `LOOKBACK_DAYS`).
4. For those tickers it pulls insider open-market purchases (SEC Form 4, code `P`).
5. Signal = listed on Liquid + Congress bought + insider bought. Ranked by number of distinct buyers.
6. It skips anything already held and respects `MAX_OPEN_POSITIONS` and `MAX_NEW_TRADES_PER_RUN`, then prints a JSON plan.
7. The routine market-buys `TRADE_USD` per planned order at **1x isolated** leverage, with a stop-loss and take-profit attached.

Positions close only via the stop-loss / take-profit, or by you.

## Setup

**1. Add the Co-Invest Computer connector** to your Claude account (claude.ai → Settings → Connectors → add custom connector) with the URL `https://coinvest-computer.liquid.trade/mcp` and sign in to Liquid. Then, in a Claude chat, turn on paper trading and an automated trading policy with your maximum per-order amount. The policy lasts at most 7 days, so renew it weekly; the routine places nothing while it is expired. This is a different connector from the regular Liquid Co-Invest one, which asks you to approve every order in chat.

**2. Rotate your Quiver token** on your Quiver account page, since the old one was shared in chat.

**3. Give the routine's cloud environment** a `QUIVER_API_TOKEN` environment variable and network access to `api.quiverquant.com`.

**4. Create the routine** on a weekday schedule (for example 14:17 and 20:17 UTC, after the US open and before the close), with this repository and the Co-Invest Computer connector attached, using the prompt in [ROUTINE.md](ROUTINE.md).

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `SIGNAL_MODE` | `both` | `both` = Congress + insider; `congress` = Congress only |
| `TRADE_USD` | `100` | USD per trade (Liquid's minimum is 15) |
| `LOOKBACK_DAYS` | `14` | How recent a filing must be |
| `MAX_OPEN_POSITIONS` | `5` | Cap on simultaneous positions |
| `MAX_NEW_TRADES_PER_RUN` | `2` | Cap on buys per run |
| `STOP_LOSS_PCT` | `10` | Sell if price falls this % |
| `TAKE_PROFIT_PCT` | `20` | Sell if price rises this % |

## Quiver plan note

If Quiver refuses the **insider** feed for your plan, `both` mode stops safely with a message and the routine places no trades. Upgrade, or set `SIGNAL_MODE=congress`.

Congressional trades can be disclosed up to 45 days after they happen, so prices may already have moved.

## Local run

Save Liquid's stock market search result as JSON, then:

```bash
pnpm install
export QUIVER_API_TOKEN=...
node_modules/.bin/tsx bots/quiver-signal/src/main.ts --markets markets.json --held xyz:AAPL
```

This prints the plan and places nothing.

Tests: `node_modules/.bin/tsx --test bots/quiver-signal/test/*.test.ts`
