# Quiver signal bot: routine prompt

This is the prompt for the scheduled Claude routine that runs the bot. The
routine needs this repository, the **Co-Invest Computer** connector
(`https://coinvest-computer.liquid.trade/mcp`) set to **Paper** mode, and a
`QUIVER_API_TOKEN` environment variable.

Paste everything below the line as the routine's prompt.

---

Run one pass of the Quiver signal bot in `bots/quiver-signal`. Paper trading only.

1. **Confirm paper mode.** Using the Co-Invest Computer connector, check the
   account's trading mode. Continue only if it confirms Paper mode (simulated
   balance). If it says Live or On request or Automated with real funds, or you
   cannot confirm Paper, stop here, place nothing, and report why.
2. **Get Liquid's stock markets.** Search Liquid markets with the query
   `stocks` and save the full JSON response to `/tmp/liquid-markets.json`.
3. **Get open positions.** Read the paper portfolio and list the symbols of all
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
   - Set leverage to 1x isolated on `symbol`.
   - Place a market buy of `notionalUsd` USD on `symbol`.
   - Attach a stop-loss at `stopLossPct` % below and a take-profit at
     `takeProfitPct` % above the current mark price.
   - Use `idempotencyKey` as the order's idempotency key when the tool accepts one.
   - If an order is rejected, note why and continue with the next one. Never
     retry with a different key, change the size, or buy anything not in `orders`.
6. **Report** in a few lines: the signals found, each order placed or rejected
   (with fill price), and open positions out of `maxOpenPositions`.
