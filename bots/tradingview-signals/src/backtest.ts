/**
 * Build the TradingView backtest strategy from saved Quiver history.
 *
 *   npx tsx bots/tradingview-signals/src/backtest.ts <dir> [from] [asOf]
 *
 * <dir> holds one <TICKER>.json per stock: { "congress": [...], "insiders": [...] }, in Quiver
 * REST or connector field names. Writes pine/quiver-strategy.pine next to the template.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { congressEvents, insiderEvents, normalizeTicker, renderStrategy, type ChartEvent } from "./events.js";

const PINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pine");

type Row = Record<string, unknown>;

const [dir, from = "2024-10-01", asOf = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
if (!dir) {
  console.error("Usage: backtest.ts <dir> [from] [asOf]");
  process.exit(1);
}

const selected = new Map<string, ChartEvent[]>();
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const data = JSON.parse(readFileSync(join(dir, file), "utf8")) as { congress?: Row[]; insiders?: Row[] };
  const ticker = normalizeTicker(file.replace(/\.json$/, ""));
  const events = [...congressEvents(data.congress ?? []), ...insiderEvents(data.insiders ?? [])]
    // Quiver sometimes returns rows for other share classes; keep only this ticker, inside the window.
    // Insider sells are left out: routine selling is noisy and the history pulled is incomplete.
    .filter((e) => e.ticker === ticker && e.date >= from && e.date <= asOf && !(e.source === "I" && e.side === "S"))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (events.length) selected.set(ticker, events);
}

const template = readFileSync(join(PINE_DIR, "strategy-template.pine"), "utf8");
const out = join(PINE_DIR, "quiver-strategy.pine");
writeFileSync(out, renderStrategy(selected, asOf, from, template));
const total = [...selected.values()].reduce((n, l) => n + l.length, 0);
console.log(`Wrote ${out}: ${selected.size} tickers, ${total} trades, ${from} to ${asOf}.`);
