/**
 * Build the TradingView indicator from Quiver Quant data.
 *
 *   QUIVER_API_TOKEN=... npx tsx bots/tradingview-signals/src/main.ts
 *   npx tsx bots/tradingview-signals/src/main.ts --input snapshot.json
 *
 * --input reads a saved snapshot ({ "congress": [...], "insiders": [...] }) instead of calling Quiver.
 * Writes pine/quiver-signals.pine next to the template; paste that file into TradingView's Pine Editor.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { congressEvents, insiderEvents, renderPine, selectEvents } from "./events.js";

const BASE_URL = "https://api.quiverquant.com/beta";
const PINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "pine");

type Row = Record<string, unknown>;

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function quiver(token: string, path: string, query: Record<string, string> = {}): Promise<Row[]> {
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  // Quiver has accepted both auth schemes over time; fall back once if the first is rejected.
  for (const scheme of ["Bearer", "Token"]) {
    const res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `${scheme} ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 && scheme === "Bearer") continue;
    if (!res.ok) throw new Error(`Quiver ${path} failed: HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as Row[]) : [];
  }
  throw new Error(`Quiver refused ${path}: check QUIVER_API_TOKEN and that your plan includes this dataset.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const inputIdx = args.indexOf("--input");
  const pinned = (process.env.TICKERS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const today = process.env.AS_OF ?? new Date().toISOString().slice(0, 10);

  let congress: Row[];
  let insiders: Row[];
  if (inputIdx !== -1) {
    const snapshot = JSON.parse(readFileSync(args[inputIdx + 1], "utf8")) as { congress?: Row[]; insiders?: Row[] };
    congress = snapshot.congress ?? [];
    insiders = snapshot.insiders ?? [];
  } else {
    const token = process.env.QUIVER_API_TOKEN;
    if (!token) throw new Error("Set QUIVER_API_TOKEN, or pass --input <snapshot.json>.");
    congress = await quiver(token, "/live/congresstrading");
    insiders = await quiver(token, "/live/insiders");
    for (const ticker of pinned) insiders.push(...(await quiver(token, "/live/insiders", { ticker })));
  }

  const selected = selectEvents([...congressEvents(congress), ...insiderEvents(insiders)], {
    today,
    lookbackDays: envInt("LOOKBACK_DAYS", 90),
    maxTickers: envInt("MAX_TICKERS", 300),
    maxPerTicker: envInt("MAX_PER_TICKER", 40),
    pinned,
  });

  const template = readFileSync(join(PINE_DIR, "template.pine"), "utf8");
  const out = join(PINE_DIR, "quiver-signals.pine");
  writeFileSync(out, renderPine(selected, today, template));
  const total = [...selected.values()].reduce((n, l) => n + l.length, 0);
  console.log(`Wrote ${out}: ${selected.size} tickers, ${total} trades, as of ${today}.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
