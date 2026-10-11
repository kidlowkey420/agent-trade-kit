# Quiver signal bot

Buys OKX stock tokens (e.g. `AAPL-USDT-SWAP`) when **members of Congress and company insiders** have both recently bought the same stock, using [Quiver Quant](https://www.quiverquant.com) data.

Runs on GitHub Actions twice each weekday. Starts on the **OKX demo account** (fake money).

## How a run works

1. List OKX stock tokens that are currently trading.
2. Pull recent congressional purchases from Quiver (filed in the last `LOOKBACK_DAYS`).
3. For those tickers, pull insider open-market purchases (SEC Form 4, code `P`).
4. Signal = tradeable on OKX + Congress bought + insider bought. Ranked by number of distinct buyers.
5. Skip anything already held; respect `MAX_OPEN_POSITIONS` and `MAX_NEW_TRADES_PER_RUN`.
6. Market-buy `TRADE_USD` at **1x isolated** leverage (you can't lose more than the amount put in), with a stop-loss and take-profit attached.

Positions close only via the stop-loss / take-profit, or by you.

## Setup

**1. OKX demo API key.** OKX → Trade → Demo trading → API → create a key with *Trade* permission (never *Withdraw*).

**2. Rotate your Quiver token** on your Quiver account page, since the old one was shared in chat.

**3. Add repository secrets** (GitHub → Settings → Secrets and variables → Actions → *Secrets*):

| Secret | Value |
|---|---|
| `OKX_API_KEY` | demo API key |
| `OKX_SECRET_KEY` | demo secret |
| `OKX_PASSPHRASE` | demo passphrase |
| `QUIVER_API_TOKEN` | Quiver API token |

**4. Merge to the default branch.** GitHub only runs scheduled workflows from the default branch.

**5. Test it.** Actions → *Quiver signal bot* → *Run workflow* (dry run is on by default). Read the log.

## Settings (optional repository *Variables*)

| Variable | Default | Meaning |
|---|---|---|
| `SIGNAL_MODE` | `both` | `both` = Congress + insider; `congress` = Congress only |
| `TRADE_USD` | `100` | USDT per trade |
| `LOOKBACK_DAYS` | `14` | How recent a filing must be |
| `MAX_OPEN_POSITIONS` | `5` | Cap on simultaneous positions |
| `MAX_NEW_TRADES_PER_RUN` | `2` | Cap on buys per run |
| `STOP_LOSS_PCT` | `10` | Sell if price falls this % |
| `TAKE_PROFIT_PCT` | `20` | Sell if price rises this % |
| `DRY_RUN` | off | `1` = log only, never order |
| `OKX_DEMO` | `1` | `0` = real account (also needs the next one) |
| `BOT_LIVE_TRADING` | — | Must be `I_UNDERSTAND_THE_RISK` for real money |

## Quiver plan note

Quiver's **insider** feed over the direct API needs the **Trader** plan. On Hobbyist, `both` mode stops safely with a message and places no trades. Upgrade, or set `SIGNAL_MODE=congress`.

Congressional trades can be disclosed up to 45 days after they happen, so prices may already have moved.

## Local run

```bash
pnpm install
export OKX_API_KEY=... OKX_SECRET_KEY=... OKX_PASSPHRASE=... OKX_DEMO=1
export QUIVER_API_TOKEN=... DRY_RUN=1
node_modules/.bin/tsx bots/quiver-signal/src/main.ts
```

Tests: `node_modules/.bin/tsx --test bots/quiver-signal/test/*.test.ts`
