import type { CongressTrade, InsiderTrade } from "./strategy.js";

const BASE_URL = "https://api.quiverquant.com/beta";

export class QuiverAccessError extends Error {}

type Row = Record<string, unknown>;

function str(row: Row, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

export class QuiverClient {
  private scheme: "Bearer" | "Token" = "Bearer";

  constructor(private readonly token: string) {}

  private async get(path: string, query: Record<string, string> = {}): Promise<Row[]> {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let res = await this.request(url);
    // Quiver has accepted both auth schemes over time; fall back once if the first is rejected.
    if (res.status === 401 && this.scheme === "Bearer") {
      this.scheme = "Token";
      res = await this.request(url);
    }
    if (res.status === 401 || res.status === 403) {
      throw new QuiverAccessError(
        `Quiver refused ${path} (HTTP ${res.status}). The token is invalid or your plan doesn't include this dataset.`,
      );
    }
    if (!res.ok) throw new Error(`Quiver ${path} failed: HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    return Array.isArray(body) ? (body as Row[]) : [];
  }

  private request(url: URL): Promise<Response> {
    return fetch(url, {
      headers: { Accept: "application/json", Authorization: `${this.scheme} ${this.token}` },
      signal: AbortSignal.timeout(30_000),
    });
  }

  async congressTrades(): Promise<CongressTrade[]> {
    const rows = await this.get("/live/congresstrading");
    return rows.map((r) => ({
      ticker: str(r, "Ticker", "ticker"),
      transaction: str(r, "Transaction", "transaction"),
      reportDate: str(r, "ReportDate", "Filed", "filed", "TransactionDate").slice(0, 10),
      representative: str(r, "Representative", "Name", "representative") || "unknown",
    }));
  }

  async insiderTrades(ticker: string): Promise<InsiderTrade[]> {
    const rows = await this.get("/live/insiders", { ticker });
    return rows.map((r) => ({
      ticker: str(r, "Ticker", "ticker") || ticker,
      code: str(r, "TransactionCode", "transaction_type"),
      date: str(r, "fileDate", "file_date", "uploaded", "Date", "date").slice(0, 10),
      name: str(r, "Name", "owner") || "unknown",
    }));
  }
}
