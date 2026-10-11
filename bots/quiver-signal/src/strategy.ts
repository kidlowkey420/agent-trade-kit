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
  instId: string;
  congressBuyers: string[];
  insiderBuyers: string[];
}

/** Normalize tickers so "BRK.B", "BRK-B" and "BRKB" compare equal. */
export function normalizeTicker(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Map normalized ticker -> OKX instId, e.g. AAPL -> AAPL-USDT-SWAP. */
export function mapStockTokens(instIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const instId of instIds) {
    const base = instId.split("-")[0];
    if (base) map.set(normalizeTicker(base), instId);
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
 * and an insider purchase. Only tickers tradeable on OKX are returned.
 * Ranked by total distinct buyers, most first; ties broken alphabetically.
 */
export function buildSignals(
  congress: Map<string, Set<string>>,
  insiders: Map<string, Set<string>>,
  tokens: Map<string, string>,
  requireInsider: boolean,
): Signal[] {
  const signals: Signal[] = [];
  for (const [ticker, buyers] of congress) {
    const instId = tokens.get(ticker);
    if (!instId) continue;
    const insiderSet = insiders.get(ticker);
    if (requireInsider && !insiderSet?.size) continue;
    signals.push({
      ticker,
      instId,
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
  openInstIds: Set<string>,
  maxOpenPositions: number,
  maxNewTrades: number,
): Signal[] {
  const slots = Math.max(0, Math.min(maxNewTrades, maxOpenPositions - openInstIds.size));
  return signals.filter((s) => !openInstIds.has(s.instId)).slice(0, slots);
}

/** Deterministic client order id (alphanumeric, <= 32 chars) so a rerun on the same day can't double-buy. */
export function clientOrderId(ticker: string, today: string): string {
  return `qb${normalizeTicker(ticker)}${today.replace(/-/g, "")}`.slice(0, 32);
}

/** Round a price to the instrument's tick size. */
export function roundToTick(price: number, tickSz: string): string {
  const tick = Number(tickSz);
  if (!Number.isFinite(tick) || tick <= 0) return String(price);
  const decimals = (tickSz.split(".")[1] ?? "").length;
  return (Math.round(price / tick) * tick).toFixed(decimals);
}
