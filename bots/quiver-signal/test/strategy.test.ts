import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSignals,
  congressBuys,
  heldSymbols,
  idempotencyKey,
  insiderBuys,
  mapLiquidMarkets,
  marketSymbolsFrom,
  normalizeTicker,
  pickTrades,
  withinWindow,
} from "../src/strategy.js";

const TODAY = "2026-10-10";

test("normalizeTicker treats share-class punctuation as equal", () => {
  assert.equal(normalizeTicker("brk.b"), "BRKB");
  assert.equal(normalizeTicker("BRK-B"), "BRKB");
});

test("mapLiquidMarkets keys by ticker and prefers the xyz venue on duplicates", () => {
  const map = mapLiquidMarkets(["para:STX", "xyz:AAPL", "xyz:BRK.B", "para:AAPL", "io:IONQ"]);
  assert.equal(map.get("AAPL"), "xyz:AAPL");
  assert.equal(map.get("STX"), "para:STX");
  assert.equal(map.get("BRKB"), "xyz:BRK.B");
  assert.equal(map.get("IONQ"), "io:IONQ");
  assert.equal(map.size, 4);
});

test("marketSymbolsFrom reads the market search response in any of its shapes", () => {
  const rows = [{ symbol: "xyz:AAPL", displayName: "AAPL" }, { symbol: "" }, { displayName: "x" }];
  assert.deepEqual(marketSymbolsFrom({ markets: rows }), ["xyz:AAPL"]);
  assert.deepEqual(marketSymbolsFrom(rows), ["xyz:AAPL"]);
  assert.deepEqual(marketSymbolsFrom(["xyz:TSLA", 3]), ["xyz:TSLA"]);
  assert.deepEqual(marketSymbolsFrom(null), []);
});

test("heldSymbols matches positions given with or without a venue prefix", () => {
  const markets = mapLiquidMarkets(["xyz:AAPL", "xyz:TSLA"]);
  assert.deepEqual([...heldSymbols(["AAPL", " xyz:TSLA", "", "BTC"], markets)], ["xyz:AAPL", "xyz:TSLA", "BTC"]);
});

test("withinWindow rejects future, stale and malformed dates", () => {
  assert.equal(withinWindow("2026-10-10", TODAY, 14), true);
  assert.equal(withinWindow("2026-09-26", TODAY, 14), true);
  assert.equal(withinWindow("2026-09-25", TODAY, 14), false);
  assert.equal(withinWindow("2033-11-18", TODAY, 14), false);
  assert.equal(withinWindow("", TODAY, 14), false);
});

test("congressBuys keeps recent purchases only, deduping buyers", () => {
  const out = congressBuys(
    [
      { ticker: "AAPL", transaction: "Purchase", reportDate: "2026-10-07", representative: "A" },
      { ticker: "AAPL", transaction: "Purchase", reportDate: "2026-10-08", representative: "A" },
      { ticker: "AAPL", transaction: "Purchase", reportDate: "2026-10-08", representative: "B" },
      { ticker: "MSFT", transaction: "Sale (Full)", reportDate: "2026-10-08", representative: "C" },
      { ticker: "NVDA", transaction: "Purchase", reportDate: "2026-08-01", representative: "D" },
    ],
    TODAY,
    14,
  );
  assert.deepEqual([...out.keys()], ["AAPL"]);
  assert.equal(out.get("AAPL")!.size, 2);
});

test("insiderBuys keeps open-market purchases (code P) only", () => {
  const out = insiderBuys(
    [
      { ticker: "AAPL", code: "P", date: "2026-10-09", name: "CEO" },
      { ticker: "AAPL", code: "S", date: "2026-10-09", name: "CFO" },
      { ticker: "TSLA", code: "A", date: "2026-10-09", name: "Dir" },
    ],
    TODAY,
    14,
  );
  assert.deepEqual([...out.keys()], ["AAPL"]);
});

test("buildSignals in both-mode requires an insider buy and a Liquid market", () => {
  const congress = new Map([
    ["AAPL", new Set(["A"])],
    ["TSLA", new Set(["B", "C"])],
    ["ZZZZ", new Set(["D"])],
  ]);
  const insiders = new Map([["AAPL", new Set(["CEO"])]]);
  const markets = mapLiquidMarkets(["xyz:AAPL", "xyz:TSLA"]);

  const both = buildSignals(congress, insiders, markets, true);
  assert.deepEqual(both.map((s) => s.symbol), ["xyz:AAPL"]);

  const congressOnly = buildSignals(congress, insiders, markets, false);
  // TSLA has 2 buyers, AAPL has 1 congress + 1 insider: tie broken alphabetically.
  assert.deepEqual(congressOnly.map((s) => s.symbol), ["xyz:AAPL", "xyz:TSLA"]);
});

test("pickTrades skips held markets and respects both limits", () => {
  const sig = (t: string) => ({ ticker: t, symbol: `xyz:${t}`, congressBuyers: [], insiderBuyers: [] });
  const signals = [sig("A"), sig("B"), sig("C"), sig("D")];

  assert.deepEqual(pickTrades(signals, new Set(["xyz:A"]), 5, 2).map((s) => s.ticker), ["B", "C"]);
  assert.deepEqual(pickTrades(signals, new Set(["X", "Y", "Z", "W"]), 5, 2).map((s) => s.ticker), ["A"]);
  assert.deepEqual(pickTrades(signals, new Set(["X", "Y", "Z", "W", "V"]), 5, 2), []);
});

test("idempotencyKey is stable per ticker per day", () => {
  assert.equal(idempotencyKey("brk.b", TODAY), "quiver-BRKB-20261010");
  assert.equal(idempotencyKey("BRK-B", TODAY), idempotencyKey("brk.b", TODAY));
});
