import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSignals,
  clientOrderId,
  congressBuys,
  insiderBuys,
  mapStockTokens,
  normalizeTicker,
  pickTrades,
  roundToTick,
  withinWindow,
} from "../src/strategy.js";

const TODAY = "2026-10-10";

test("normalizeTicker treats share-class punctuation as equal", () => {
  assert.equal(normalizeTicker("brk.b"), "BRKB");
  assert.equal(normalizeTicker("BRK-B"), "BRKB");
});

test("mapStockTokens keys by base ticker", () => {
  const map = mapStockTokens(["AAPL-USDT-SWAP", "TSLA-USDT-SWAP"]);
  assert.equal(map.get("AAPL"), "AAPL-USDT-SWAP");
  assert.equal(map.size, 2);
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

test("buildSignals in both-mode requires an insider buy and an OKX token", () => {
  const congress = new Map([
    ["AAPL", new Set(["A"])],
    ["TSLA", new Set(["B", "C"])],
    ["ZZZZ", new Set(["D"])],
  ]);
  const insiders = new Map([["AAPL", new Set(["CEO"])]]);
  const tokens = mapStockTokens(["AAPL-USDT-SWAP", "TSLA-USDT-SWAP"]);

  const both = buildSignals(congress, insiders, tokens, true);
  assert.deepEqual(both.map((s) => s.instId), ["AAPL-USDT-SWAP"]);

  const congressOnly = buildSignals(congress, insiders, tokens, false);
  // TSLA has 2 buyers, AAPL has 1 congress + 1 insider: tie broken alphabetically.
  assert.deepEqual(congressOnly.map((s) => s.instId), ["AAPL-USDT-SWAP", "TSLA-USDT-SWAP"]);
});

test("pickTrades skips held instruments and respects both limits", () => {
  const sig = (t: string) => ({ ticker: t, instId: `${t}-USDT-SWAP`, congressBuyers: [], insiderBuyers: [] });
  const signals = [sig("A"), sig("B"), sig("C"), sig("D")];

  assert.deepEqual(pickTrades(signals, new Set(["A-USDT-SWAP"]), 5, 2).map((s) => s.ticker), ["B", "C"]);
  assert.deepEqual(pickTrades(signals, new Set(["X", "Y", "Z", "W"]), 5, 2).map((s) => s.ticker), ["A"]);
  assert.deepEqual(pickTrades(signals, new Set(["X", "Y", "Z", "W", "V"]), 5, 2), []);
});

test("clientOrderId is stable per ticker per day and within OKX limits", () => {
  const id = clientOrderId("brk.b", TODAY);
  assert.equal(id, "qbBRKB20261010");
  assert.match(id, /^[A-Za-z0-9]{1,32}$/);
});

test("roundToTick snaps to the instrument tick size", () => {
  assert.equal(roundToTick(123.456, "0.01"), "123.46");
  assert.equal(roundToTick(123.456, "0.5"), "123.5");
  assert.equal(roundToTick(123.456, ""), "123.456");
});
