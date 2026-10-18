/**
 * Quiver signal bot: picks US stocks that members of Congress (and, in "both"
 * mode, company insiders) have recently bought, for Liquid paper trading.
 *
 * Liquid has no API key, so this script places no orders. It reads Quiver,
 * matches tickers against Liquid's stock markets and prints a JSON trade plan.
 * A scheduled Claude routine with the Co-Invest Computer connector supplies the
 * markets and open positions, runs this, and places the planned orders
 * (see ROUTINE.md).
 *
 * Usage:
 *   tsx bots/quiver-signal/src/main.ts --markets markets.json [--held xyz:AAPL,xyz:TSLA]
 *
 * The plan goes to stdout; progress goes to stderr.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadBotConfig } from "./config.js";
import { QuiverAccessError, QuiverClient } from "./quiver.js";
import {
  buildSignals,
  congressBuys,
  heldSymbols,
  idempotencyKey,
  insiderBuys,
  mapLiquidMarkets,
  marketSymbolsFrom,
  pickTrades,
  type InsiderTrade,
  type Signal,
} from "./strategy.js";

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

interface Plan {
  date: string;
  /** "ok", or "stopped" when the run ended early and nothing should be bought. */
  status: "ok" | "stopped";
  reason?: string;
  signalMode: string;
  signals: Signal[];
  openPositions: number;
  maxOpenPositions: number;
  orders: Array<{
    symbol: string;
    ticker: string;
    side: "buy";
    notionalUsd: number;
    leverage: 1;
    marginMode: "isolated";
    stopLossPct: number;
    takeProfitPct: number;
    idempotencyKey: string;
    reason: string;
  }>;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { markets: { type: "string" }, held: { type: "string", default: "" } },
  });
  if (!values.markets) throw new Error("--markets <file> is required (Liquid's stock market search result as JSON).");

  const bot = loadBotConfig();
  const marketSymbols = marketSymbolsFrom(JSON.parse(readFileSync(values.markets, "utf8")));
  if (marketSymbols.length === 0) throw new Error(`No market symbols found in ${values.markets}.`);
  const markets = mapLiquidMarkets(marketSymbols);
  const open = heldSymbols(values.held.split(","), markets);

  const quiver = new QuiverClient(bot.quiverToken);
  const today = new Date().toISOString().slice(0, 10);
  const plan: Plan = {
    date: today,
    status: "ok",
    signalMode: bot.signalMode,
    signals: [],
    openPositions: open.size,
    maxOpenPositions: bot.maxOpenPositions,
    orders: [],
  };

  log(`signal=${bot.signalMode} | $${bot.tradeUsd}/trade | lookback ${bot.lookbackDays}d | Liquid stock markets: ${markets.size}`);

  // 1. Congressional purchases.
  const congress = congressBuys(await quiver.congressTrades(), today, bot.lookbackDays);
  const tradeableCongress = [...congress.keys()].filter((t) => markets.has(t));
  log(`Congress-bought tickers (last ${bot.lookbackDays}d): ${congress.size}, on Liquid: ${tradeableCongress.length}`);

  // 2. Insider purchases, only for tickers that already passed step 1.
  let insiders = new Map<string, Set<string>>();
  if (bot.signalMode === "both") {
    const all: InsiderTrade[] = [];
    try {
      for (const ticker of tradeableCongress) all.push(...(await quiver.insiderTrades(ticker)));
    } catch (err) {
      if (err instanceof QuiverAccessError) {
        plan.status = "stopped";
        plan.reason = `${err.message} The insider feed may need a higher Quiver plan. Upgrade, or set SIGNAL_MODE=congress.`;
        log(`STOP: ${plan.reason}`);
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        return;
      }
      throw err;
    }
    insiders = insiderBuys(all, today, bot.lookbackDays);
  }

  // 3. Rank, skip what is already held, respect position limits.
  plan.signals = buildSignals(congress, insiders, markets, bot.signalMode === "both");
  for (const s of plan.signals) {
    log(`  ${s.symbol}  congress=[${s.congressBuyers.join(", ")}]  insiders=[${s.insiderBuyers.join(", ")}]`);
  }
  const picks = pickTrades(plan.signals, open, bot.maxOpenPositions, bot.maxNewTradesPerRun);
  log(`Open positions: ${open.size}/${bot.maxOpenPositions}. To buy: ${picks.map((p) => p.symbol).join(", ") || "none"}`);

  plan.orders = picks.map((p) => ({
    symbol: p.symbol,
    ticker: p.ticker,
    side: "buy",
    notionalUsd: bot.tradeUsd,
    leverage: 1,
    marginMode: "isolated",
    stopLossPct: bot.stopLossPct,
    takeProfitPct: bot.takeProfitPct,
    idempotencyKey: idempotencyKey(p.ticker, today),
    reason:
      `Congress: ${p.congressBuyers.join(", ")}` +
      (p.insiderBuyers.length ? `; insiders: ${p.insiderBuyers.join(", ")}` : ""),
  }));
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
