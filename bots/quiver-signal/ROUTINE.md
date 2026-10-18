# Quiver signal bot: routine prompt

This is the prompt for the scheduled Claude routine that runs the bot. The
routine needs this repository, the **Co-Invest Computer** connector
(`https://coinvest-computer.liquid.trade/mcp`) set to **Paper** mode, and a
`QUIVER_API_TOKEN` environment variable.

Paste everything below the line as the routine's prompt.

---

Run one pass of the Quiver signal bot in `bots/quiver-signal`. Paper trading only.

1. **Confirm paper mode and the order limit.** Call `paper_trading_status` and
   `automated_trading_status` on the Liquid connector. Continue only if paper
   trading is ENABLED and an automated trading policy is active. If paper is
   disabled, the policy is missing or expired, or you cannot confirm either,
   stop here, place nothing, and report why. Never call `enable_paper_trading`,
   `disable_paper_trading` or `enable_automated_trading` yourself.
2. **Get Liquid's stock markets.** Call `search_markets` with the query
   `stocks` and save the full JSON response to `/tmp/liquid-markets.json`.
3. **Get open positions.** Call `get_portfolio` and list the symbols of all
   open positions, comma separated (for example `xyz:AAPL,xyz:TSLA`).
4. **Build the plan.** Run:
   ```bash
   pnpm install --frozen-lockfile
   node_modules/.bin/tsx bots/quiver-signal/src/main.ts \
     --markets /tmp/liquid-markets.json --held "<symbols from step 3>"
   ```
   The script prints a JSON plan to stdout. If it exits with an error, or
   `status` is `stopped`, place nothing and report the error or `reason`.
5. **Place the planned orders, and only those.** For each entry in `orders`:
   - Get the current price with `analyze_market` on `symbol`.
   - Call `execute_order` with `symbol`, `side: "buy"`, `type: "market"`,
     `size: notionalUsd`, `leverage: 1`, `sl` = price × (1 − `stopLossPct`/100),
     `tp` = price × (1 + `takeProfitPct`/100), and `idempotencyKey`.
   - If an order is rejected, note why and continue with the next one. Never
     retry with a different key, change the size, or buy anything not in `orders`.
6. **Report** in a few lines: the signals found, each order placed or rejected
   (with fill price), and open positions out of `maxOpenPositions`.
