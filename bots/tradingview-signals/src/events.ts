/**
 * Pure logic: Quiver rows -> chart events -> Pine Script source. No network, no clock.
 */

export type Side = "B" | "S";
export type Source = "C" | "I";

export interface ChartEvent {
  /** Normalized ticker, e.g. "BRKB". Matched against TradingView's syminfo.ticker. */
  ticker: string;
  /** Disclosure (filing) date, YYYY-MM-DD: the day the trade became public. */
  date: string;
  side: Side;
  /** C = member of Congress, I = corporate insider (SEC Form 4). */
  source: Source;
  who: string;
  /** Amount range or share count, shown in the tooltip. */
  detail: string;
}

type Row = Record<string, unknown>;

function str(row: Row, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return "";
}

/** Normalize tickers so "BRK.B", "BRK-B" and "BRKB" compare equal. */
export function normalizeTicker(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Congress rows from either Quiver's REST API (Ticker, Transaction, ReportDate)
 * or the Quiver connector (ticker, transaction, filed). Exchanges and rows without a ticker are dropped.
 */
export function congressEvents(rows: Row[]): ChartEvent[] {
  const out: ChartEvent[] = [];
  for (const r of rows) {
    const ticker = normalizeTicker(str(r, "Ticker", "ticker"));
    const tx = str(r, "Transaction", "transaction");
    const date = str(r, "ReportDate", "Filed", "filed", "TransactionDate", "traded").slice(0, 10);
    const side: Side | null = /purchase/i.test(tx) ? "B" : /sale/i.test(tx) ? "S" : null;
    if (!ticker || !side || !DATE_RE.test(date)) continue;
    out.push({
      ticker,
      date,
      side,
      source: "C",
      who: str(r, "Representative", "representative", "Name") || "unknown",
      detail: str(r, "Range", "Amount", "amount"),
    });
  }
  return out;
}

/** SEC Form 4 rows. Only open-market purchases (P) and sales (S) count; grants and exercises are noise. */
export function insiderEvents(rows: Row[]): ChartEvent[] {
  const out: ChartEvent[] = [];
  for (const r of rows) {
    const ticker = normalizeTicker(str(r, "Ticker", "ticker"));
    const code = str(r, "TransactionCode", "transaction_type").toUpperCase();
    const date = str(r, "fileDate", "file_date", "uploaded", "Date", "date").slice(0, 10);
    const side: Side | null = code === "P" ? "B" : code === "S" ? "S" : null;
    if (!ticker || !side || !DATE_RE.test(date)) continue;
    const shares = Number(str(r, "Shares", "shares"));
    out.push({
      ticker,
      date,
      side,
      source: "I",
      who: str(r, "Name", "owner") || "unknown",
      detail: Number.isFinite(shares) && shares > 0 ? `${Math.round(shares).toLocaleString("en-US")} sh` : "",
    });
  }
  return out;
}

/** Inclusive window [today - lookbackDays, today]. Rejects future and malformed dates. */
export function withinWindow(date: string, today: string, lookbackDays: number): boolean {
  const d = Date.parse(date);
  const t = Date.parse(today);
  if (Number.isNaN(d) || Number.isNaN(t)) return false;
  const ageDays = (t - d) / 86_400_000;
  return ageDays >= 0 && ageDays <= lookbackDays;
}

export interface SelectOptions {
  today: string;
  lookbackDays: number;
  /** Keep at most this many tickers, ranked by number of events. */
  maxTickers: number;
  /** Keep at most this many events per ticker, most recent first. Keeps each Pine string literal small. */
  maxPerTicker: number;
  /** Tickers always kept (e.g. your watchlist), even if they rank low. */
  pinned?: string[];
}

/** Window, dedupe, rank and cap. Returns ticker -> events sorted oldest first (the order Pine walks them). */
export function selectEvents(events: ChartEvent[], opts: SelectOptions): Map<string, ChartEvent[]> {
  const seen = new Set<string>();
  const byTicker = new Map<string, ChartEvent[]>();
  for (const e of events) {
    if (!withinWindow(e.date, opts.today, opts.lookbackDays)) continue;
    const key = [e.ticker, e.date, e.side, e.source, e.who].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byTicker.has(e.ticker)) byTicker.set(e.ticker, []);
    byTicker.get(e.ticker)!.push(e);
  }

  const pinned = new Set((opts.pinned ?? []).map(normalizeTicker));
  const ranked = [...byTicker.entries()].sort(
    ([a, ea], [b, eb]) =>
      Number(pinned.has(b)) - Number(pinned.has(a)) || eb.length - ea.length || a.localeCompare(b),
  );

  const out = new Map<string, ChartEvent[]>();
  for (const [ticker, list] of ranked.slice(0, opts.maxTickers)) {
    const recent = [...list].sort((a, b) => b.date.localeCompare(a.date)).slice(0, opts.maxPerTicker);
    out.set(ticker, recent.sort((a, b) => a.date.localeCompare(b.date)));
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** Strip the record separators and anything that would break a Pine string literal. */
function clean(s: string, max: number): string {
  return s.replace(/[|;"\\\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** One record per event: date|side|source|who|detail, records joined by ";". */
export function encodeEvents(events: ChartEvent[]): string {
  return events
    .map((e) => [e.date, e.side, e.source, clean(e.who, 40), clean(e.detail, 30)].join("|"))
    .join(";");
}

export function renderPine(selected: Map<string, ChartEvent[]>, asOf: string, template: string): string {
  const cases = [...selected.entries()]
    .map(([ticker, events]) => `        "${ticker}" => "${encodeEvents(events)}"`)
    .join("\n");
  const total = [...selected.values()].reduce((n, l) => n + l.length, 0);
  return template
    .replaceAll("{{AS_OF}}", () => asOf)
    .replace("{{SUMMARY}}", () => `${selected.size} tickers, ${total} trades`)
    .replace("{{CASES}}", () => cases);
}
