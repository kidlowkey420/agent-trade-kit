/**
 * Quiver signal bot: buys OKX stock tokens that members of Congress (and, in
 * "both" mode, company insiders) have recently bought.
 *
 * One run = one pass. Schedule it (see .github/workflows/quiver-bot.yml).
 */
import { OkxRestClient, createToolRunner, loadConfig } from "../../../packages/core/src/index.js";
import { loadBotConfig } from "./config.js";
import { QuiverAccessError, QuiverClient } from "./quiver.js";
import {
  buildSignals,
  clientOrderId,
  congressBuys,
  insiderBuys,
  mapStockTokens,
  pickTrades,
  roundToTick,
  type InsiderTrade,
} from "./strategy.js";

type Row = Record<string, unknown>;

function rows(result: { data: unknown }): Row[] {
  return Array.isArray(result.data) ? (result.data as Row[]) : [];
}

function log(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

async function main(): Promise<void> {
  const bot = loadBotConfig();
  const okxConfig = await loadConfig({ readOnly: false });
  if (!okxConfig.apiKey) throw new Error("OKX_API_KEY / OKX_SECRET_KEY / OKX_PASSPHRASE are not set.");
  if (!okxConfig.demo && !bot.allowLive) {
    throw new Error(
      "Refusing to trade real money. Set OKX_DEMO=1 for the demo account, " +
        "or BOT_LIVE_TRADING=I_UNDERSTAND_THE_RISK to go live.",
    );
  }

  const run = createToolRunner(new OkxRestClient(okxConfig), okxConfig);
  const quiver = new QuiverClient(bot.quiverToken);
  const today = new Date().toISOString().slice(0, 10);
  const demo = okxConfig.demo;

  log(`Mode: ${demo ? "DEMO" : "LIVE"}${bot.dryRun ? " (dry run, no orders)" : ""} | signal=${bot.signalMode} | $${bot.tradeUsd}/trade | lookback ${bot.lookbackDays}d`);

  // 1. What can we trade on OKX?
  const instruments = rows(await run("market_get_instruments_by_category", { instCategory: "3", demo }));
  const live = instruments.filter((i) => i.state === undefined || i.state === "live");
  const tokens = mapStockTokens(live.map((i) => String(i.instId)));
  const tickSizes = new Map(live.map((i) => [String(i.instId), String(i.tickSz ?? "")]));
  log(`OKX stock tokens available: ${tokens.size}`);

  // 2. Congressional purchases.
  const congress = congressBuys(await quiver.congressTrades(), today, bot.lookbackDays);
  const tradeableCongress = [...congress.keys()].filter((t) => tokens.has(t));
  log(`Congress-bought tickers (last ${bot.lookbackDays}d): ${congress.size}, tradeable on OKX: ${tradeableCongress.length}`);

  // 3. Insider purchases, only for tickers that already passed step 2.
  let insiders = new Map<string, Set<string>>();
  if (bot.signalMode === "both") {
    const all: InsiderTrade[] = [];
    try {
      for (const ticker of tradeableCongress) all.push(...(await quiver.insiderTrades(ticker)));
    } catch (err) {
      if (err instanceof QuiverAccessError) {
        log(`STOP: ${err.message}`);
        log('The insider feed needs Quiver\'s Trader plan. Upgrade, or set SIGNAL_MODE=congress. No trades placed.');
        return;
      }
      throw err;
    }
    insiders = insiderBuys(all, today, bot.lookbackDays);
  }

  const signals = buildSignals(congress, insiders, tokens, bot.signalMode === "both");
  log(`Signals: ${signals.length}`);
  for (const s of signals) {
    log(`  ${s.instId}  congress=[${s.congressBuyers.join(", ")}]  insiders=[${s.insiderBuyers.join(", ")}]`);
  }
  if (signals.length === 0) return;

  // 4. Skip what we already hold; respect position limits.
  const positions = rows(await run("swap_get_positions", { instType: "SWAP" }));
  const open = new Set(positions.filter((p) => Number(p.pos) !== 0).map((p) => String(p.instId)));
  const picks = pickTrades(signals, open, bot.maxOpenPositions, bot.maxNewTradesPerRun);
  log(`Open positions: ${open.size}/${bot.maxOpenPositions}. Buying now: ${picks.map((p) => p.instId).join(", ") || "none"}`);

  // 5. Place orders: 1x isolated (max loss = the margin), with stop-loss and take-profit attached.
  for (const pick of picks) {
    const ticker = rows(await run("market_get_ticker", { instId: pick.instId, demo }))[0];
    const last = Number(ticker?.last);
    if (!Number.isFinite(last) || last <= 0) {
      log(`  ${pick.instId}: no price, skipped`);
      continue;
    }
    const tick = tickSizes.get(pick.instId) ?? "";
    const sl = roundToTick(last * (1 - bot.stopLossPct / 100), tick);
    const tp = roundToTick(last * (1 + bot.takeProfitPct / 100), tick);
    const order = {
      instId: pick.instId,
      tdMode: "isolated",
      side: "buy",
      ordType: "market",
      sz: String(bot.tradeUsd),
      tgtCcy: "quote_ccy",
      clOrdId: clientOrderId(pick.ticker, today),
      slTriggerPx: sl,
      slOrdPx: "-1",
      tpTriggerPx: tp,
      tpOrdPx: "-1",
    };

    if (bot.dryRun) {
      log(`  [dry run] would buy $${bot.tradeUsd} ${pick.instId} @ ~${last}, SL ${sl}, TP ${tp}`);
      continue;
    }

    try {
      await run("swap_set_leverage", { instId: pick.instId, lever: "1", mgnMode: "isolated" });
      const res = rows(await run("swap_place_order", order))[0];
      if (res && res.sCode !== undefined && String(res.sCode) !== "0") {
        log(`  ${pick.instId}: order rejected (${res.sCode}) ${res.sMsg ?? ""}`);
        continue;
      }
      log(`  ${pick.instId}: bought $${bot.tradeUsd} @ ~${last}, SL ${sl}, TP ${tp} (ordId ${res?.ordId ?? "?"})`);
    } catch (err) {
      // One bad instrument shouldn't stop the rest.
      log(`  ${pick.instId}: failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
