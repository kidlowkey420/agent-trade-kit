export interface BotConfig {
  quiverToken: string;
  signalMode: "both" | "congress";
  tradeUsd: number;
  lookbackDays: number;
  maxOpenPositions: number;
  maxNewTradesPerRun: number;
  stopLossPct: number;
  takeProfitPct: number;
  dryRun: boolean;
  allowLive: boolean;
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

function flag(name: string): boolean {
  return ["1", "true", "yes"].includes((process.env[name] ?? "").trim().toLowerCase());
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
    tradeUsd: num("TRADE_USD", 100, 5, 10_000),
    lookbackDays: num("LOOKBACK_DAYS", 14, 1, 90),
    maxOpenPositions: num("MAX_OPEN_POSITIONS", 5, 1, 50),
    maxNewTradesPerRun: num("MAX_NEW_TRADES_PER_RUN", 2, 1, 20),
    stopLossPct: num("STOP_LOSS_PCT", 10, 1, 90),
    takeProfitPct: num("TAKE_PROFIT_PCT", 20, 1, 500),
    dryRun: flag("DRY_RUN"),
    // Live trading needs this exact phrase so it can't be switched on by accident.
    allowLive: process.env.BOT_LIVE_TRADING?.trim() === "I_UNDERSTAND_THE_RISK",
  };
}
