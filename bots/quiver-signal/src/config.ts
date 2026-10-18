export interface BotConfig {
  quiverToken: string;
  signalMode: "both" | "congress";
  tradeUsd: number;
  lookbackDays: number;
  maxOpenPositions: number;
  maxNewTradesPerRun: number;
  stopLossPct: number;
  takeProfitPct: number;
}

function num(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max} (got "${raw}").`);
  }
  return n;
}

export function loadBotConfig(): BotConfig {
  const quiverToken = process.env.QUIVER_API_TOKEN?.trim();
  if (!quiverToken) throw new Error("QUIVER_API_TOKEN is not set.");

  const mode = (process.env.SIGNAL_MODE ?? "both").trim().toLowerCase();
  if (mode !== "both" && mode !== "congress") {
    throw new Error(`SIGNAL_MODE must be "both" or "congress" (got "${mode}").`);
  }

  return {
    quiverToken,
    signalMode: mode,
    // Liquid rejects orders under $15 of collateral; at 1x leverage that is the notional.
    tradeUsd: num("TRADE_USD", 100, 15, 10_000),
    lookbackDays: num("LOOKBACK_DAYS", 14, 1, 90),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 5, 1, 50),
    maxNewTradesPerRun: num("MAX_NEW_TRADES_PER_RUN", 2, 1, 20),
    stopLossPct: num("STOP_LOSS_PCT", 10, 1, 90),
    takeProfitPct: num("TAKE_PROFIT_PCT", 20, 1, 500),
  };
}
