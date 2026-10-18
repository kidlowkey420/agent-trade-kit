/**
 * Pure signal logic: no network, no clock. Everything here is unit-tested.
 */

export interface CongressTrade {
  ticker: string;
  transaction: string;
  /** Disclosure (filing) date, YYYY-MM-DD. */
  reportDate: string;
  representative: string;
}

export interface InsiderTrade {
  ticker: string;
  /** SEC transaction code: P = open-market purchase. */
  code: string;
  /** Filing date if known, else transaction date, YYYY-MM-DD. */
  date: string;
  name: string;
}

export interface Signal {
  ticker: string;
  /** Liquid market symbol, e.g. "xyz:AAPL". */
  symbol: string;
  congressBuyers: string[];
  insiderBuyers: string[];
}

/** Normalize tickers so "BRK.B", "BRK-B" and "BRKB" compare equal. */
export function normalizeTicker(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Market venues on Liquid, most preferred first, when one ticker is listed more than once. */
const VENUE_PREFERENCE = ["xyz"];

/**
 * Map normalized ticker -> Liquid market symbol, e.g. AAPL -> xyz:AAPL.
 * Takes the symbols from Liquid's stock market search ("xyz:AAPL", "para:STX").
 */
export function mapLiquidMarkets(symbols: string[]): Map<string, string> {
  const rank = (symbol: string) => {
    const i = VENUE_PREFERENCE.indexOf(symbol.split(":")[0]);
    return i === -1 ? VENUE_PREFERENCE.length : i;
  };
  const map = new Map<string, string>();
  for (const symbol of symbols) {
    const base = symbol.includes(":") ? symbol.slice(symbol.indexOf(":") + 1) : symbol;
    const key = normalizeTicker(base);
    if (!key) continue;
    const existing = map.get(key);
    if (!existing || rank(symbol) < rank(existing)) map.set(key, symbol);
  }
  return map;
}

/** Inclusive window [today - lookbackDays, today]. Rejects future and malformed dates. */
export function withinWindow(date: string, today: string, lookbackDays: number): boolean {
  const d = Date.parse(date.slice(0, 10));
  const t = Date.parse(today);
  if (Number.isNaN(d) || Number.isNaN(t)) return false;
  const ageDays = (t - d) / 86_400_000;
  return ageDays >= 0 && ageDays <= lookbackDays;
}

/** Recent congressional purchases grouped by normalized ticker -> distinct buyers. */
export function congressBuys(
  trades: CongressTrade[],
  today: string,
  lookbackDays: number,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of trades) {
    if (!t.ticker || !/purchase/i.test(t.transaction)) continue;
    if (!withinWindow(t.reportDate, today, lookbackDays)) continue;
    const key = normalizeTicker(t.ticker);
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(t.representative);
  }
  return out;
}

/** Recent open-market insider purchases grouped by normalized ticker -> distinct buyers. */
export function insiderBuys(
  trades: InsiderTrade[],
  today: string,
  lookbackDays: number,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const t of trades) {
    if (!t.ticker || t.code.toUpperCase() !== "P") continue;
    if (!withinWindow(t.date, today, lookbackDays)) continue;
    const key = normalizeTicker(t.ticker);
    if (!out.has(key)) out.set(key, new Set());
    out.get(key)!.add(t.name);
  }
  return out;
}

/**
 * Build ranked signals. With `requireInsider`, a ticker needs both a congressional
 * and an insider purchase. Only tickers tradeable on Liquid are returned.
 * Ranked by total distinct buyers, most first; ties broken alphabetically.
 */
export function buildSignals(
  congress: Map<string, Set<string>>,
  insiders: Map<string, Set<string>>,
  markets: Map<string, string>,
  requireInsider: boolean,
): Signal[] {
  const signals: Signal[] = [];
  for (const [ticker, buyers] of congress) {
    const symbol = markets.get(ticker);
    if (!symbol) continue;
    const insiderSet = insiders.get(ticker);
    if (requireInsider && !insiderSet?.size) continue;
    signals.push({
      ticker,
      symbol,
      congressBuyers: [...buyers].sort(),
      insiderBuyers: [...(insiderSet ?? [])].sort(),
    });
  }
  const score = (s: Signal) => s.congressBuyers.length + s.insiderBuyers.length;
  return signals.sort((a, b) => score(b) - score(a) || a.ticker.localeCompare(b.ticker));
}

/** Choose which signals to act on given open positions and limits. */
export function pickTrades(
  signals: Signal[],
  openSymbols: Set<string>,
  maxOpenPositions: number,
  maxNewTrades: number,
): Signal[] {
  const slots = Math.max(0, Math.min(maxNewTrades, maxOpenPositions - openSymbols.size));
  return signals.filter((s) => !openSymbols.has(s.symbol)).slice(0, slots);
}

/** Deterministic idempotency key, so a retried order for the same ticker on the same day is not placed twice. */
export function idempotencyKey(ticker: string, today: string): string {
  return `quiver-${normalizeTicker(ticker)}-${today.replace(/-/g, "")}`;
}

/**
 * Pull market symbols out of Liquid's market search result. Accepts the raw
 * `{ markets: [{ symbol }] }` response, a bare array of those rows, or an array of symbol strings.
 */
export function marketSymbolsFrom(data: unknown): string[] {
  const list = Array.isArray(data) ? data : (data as { markets?: unknown } | null)?.markets;
  if (!Array.isArray(list)) return [];
  return list
    .map((m) => (typeof m === "string" ? m : (m as { symbol?: unknown } | null)?.symbol))
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .map((s) => s.trim());
}

/** Resolve held positions (as "xyz:AAPL" or plain "AAPL") to Liquid market symbols. */
export function heldSymbols(held: string[], markets: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const raw of held) {
    const h = raw.trim();
    if (!h) continue;
    const base = h.includes(":") ? h.slice(h.indexOf(":") + 1) : h;
    out.add(markets.get(normalizeTicker(base)) ?? h);
  }
  return out;
}
