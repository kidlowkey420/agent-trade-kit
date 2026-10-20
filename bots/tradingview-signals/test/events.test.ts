import { test } from "node:test";
import assert from "node:assert/strict";
import {
  congressEvents,
  encodeEvents,
  insiderEvents,
  normalizeTicker,
  renderPine,
  selectEvents,
  withinWindow,
  type ChartEvent,
} from "../src/events.js";

const TODAY = "2026-10-20";

function ev(over: Partial<ChartEvent>): ChartEvent {
  return { ticker: "AAPL", date: "2026-10-10", side: "B", source: "C", who: "Jane Doe", detail: "", ...over };
}

test("normalizeTicker treats share-class punctuation as equal", () => {
  assert.equal(normalizeTicker("brk.b"), "BRKB");
  assert.equal(normalizeTicker("BRK-B"), "BRKB");
});

test("congressEvents reads connector and REST field names, drops exchanges and blank tickers", () => {
  const events = congressEvents([
    { ticker: "NVDA", transaction: "Purchase", filed: "2026-10-16", representative: "A", amount: "$1,001 - $15,000" },
    { Ticker: "MSFT", Transaction: "Sale (Partial)", ReportDate: "2026-10-15T00:00:00", Representative: "B" },
    { ticker: "T", transaction: "Exchange", filed: "2026-10-15", representative: "C" },
    { ticker: null, transaction: "Purchase", filed: "2026-10-15", representative: "D" },
  ]);
  assert.deepEqual(
    events.map((e) => [e.ticker, e.side, e.date, e.who]),
    [
      ["NVDA", "B", "2026-10-16", "A"],
      ["MSFT", "S", "2026-10-15", "B"],
    ],
  );
  assert.equal(events[0].detail, "$1,001 - $15,000");
});

test("insiderEvents keeps only open-market buys and sells, keyed by filing date", () => {
  const events = insiderEvents([
    { ticker: "CTY", transaction_type: "P", date: "2026-10-17", file_date: "2026-10-19", owner: "X", shares: 170000 },
    { ticker: "CTY", transaction_type: "S", file_date: "2026-10-19", owner: "Y" },
    { ticker: "CTY", transaction_type: "A", file_date: "2026-10-19", owner: "Z" },
    { ticker: "CTY", transaction_type: "M", file_date: "2026-10-19", owner: "Z" },
  ]);
  assert.deepEqual(
    events.map((e) => [e.side, e.date, e.who, e.detail]),
    [
      ["B", "2026-10-19", "X", "170,000 sh"],
      ["S", "2026-10-19", "Y", ""],
    ],
  );
});

test("withinWindow is inclusive and rejects future or malformed dates", () => {
  assert.equal(withinWindow("2026-10-20", TODAY, 0), true);
  assert.equal(withinWindow("2026-09-20", TODAY, 30), true);
  assert.equal(withinWindow("2026-09-19", TODAY, 30), false);
  assert.equal(withinWindow("2026-10-21", TODAY, 30), false);
  assert.equal(withinWindow("soon", TODAY, 30), false);
});

test("selectEvents dedupes, caps per ticker to the most recent, and sorts oldest first", () => {
  const events = [
    ev({ date: "2026-10-01" }),
    ev({ date: "2026-10-01" }),
    ev({ date: "2026-10-05" }),
    ev({ date: "2026-10-09" }),
    ev({ date: "2026-01-01" }),
  ];
  const out = selectEvents(events, { today: TODAY, lookbackDays: 90, maxTickers: 10, maxPerTicker: 2 });
  assert.deepEqual(out.get("AAPL")!.map((e) => e.date), ["2026-10-05", "2026-10-09"]);
});

test("selectEvents ranks busy tickers first but always keeps pinned ones", () => {
  const events = [ev({ ticker: "AAA" }), ev({ ticker: "AAA", who: "B" }), ev({ ticker: "BBB" }), ev({ ticker: "ZZZ" })];
  const out = selectEvents(events, { today: TODAY, lookbackDays: 90, maxTickers: 2, maxPerTicker: 10, pinned: ["zzz"] });
  assert.deepEqual([...out.keys()], ["AAA", "ZZZ"]);
});

test("encodeEvents strips characters that would break the Pine data string", () => {
  const s = encodeEvents([ev({ who: 'Smith; "Jr" | III\\', detail: "$1,001\n- $15,000" })]);
  assert.equal(s, "2026-10-10|B|C|Smith Jr III|$1,001 - $15,000");
  assert.equal(s.split(";").length, 1);
});

test("renderPine fills the template, including $ amounts verbatim", () => {
  const selected = new Map([["AAPL", [ev({ detail: "$1,001 - $15,000" })]]]);
  const pine = renderPine(selected, TODAY, "// {{AS_OF}} {{SUMMARY}}\n{{CASES}}\n");
  assert.equal(
    pine,
    '// 2026-10-20 1 tickers, 1 trades\n        "AAPL" => "2026-10-10|B|C|Jane Doe|$1,001 - $15,000"\n',
  );
});

test("renderPine fills every copy of a placeholder", () => {
  const pine = renderPine(new Map(), TODAY, '// {{AS_OF}}\nconst string AS_OF = "{{AS_OF}}"\n');
  assert.equal(pine, '// 2026-10-20\nconst string AS_OF = "2026-10-20"\n');
});
