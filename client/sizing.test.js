// The sizing arithmetic, offline. No chain, no keys.
//
// This is the control that decides how much of the wallet a single bad decision
// can cost, so it is worth checking the edges rather than trusting that the
// smallest of four numbers is obviously right.

const { maxBuy, assertWithinBudget, DEFAULT_TRADE_BPS } = require("./sizing");

let pass = 0, fail = 0;
const ok = (l) => { console.log(`  ok    ${l}`); pass++; };
const bad = (l, why) => { console.log(`  FAIL  ${l}: ${why}`); fail++; };
const eq = (l, got, want) =>
  (String(got) === String(want) ? ok(`${l} = ${got}`) : bad(l, `expected ${want}, got ${got}`));

const SOL = (n) => BigInt(Math.round(n * 1e9));
const limits = (balanceSol, spentSol = 0, capSol = 0.05, dailySol = 0.4) => ({
  balance: SOL(balanceSol),
  absoluteCap: SOL(capSol),
  dailyCap: SOL(dailySol),
  spentToday: SOL(spentSol),
});
// The 0.02 SOL reserve is the default; these expectations assume it.
const RESERVE = 0.02;

console.log("\nthe cap tracks the balance:");
eq("0.227 SOL wallet", maxBuy(limits(0.227)), SOL((0.227 - RESERVE) * 0.02));
eq("1 SOL wallet", maxBuy(limits(1)), SOL((1 - RESERVE) * 0.02));

// Past about 2.5 SOL the chain's own 0.05 cap becomes the tighter of the two,
// which is the point at which update_config is worth calling.
eq("5 SOL wallet is bounded by the chain cap", maxBuy(limits(5)), SOL(0.05));
eq("50 SOL wallet is still bounded by the chain cap", maxBuy(limits(50)), SOL(0.05));

console.log("\nit fails safe as the wallet empties:");
eq("balance at the reserve", maxBuy(limits(RESERVE)), 0n);
eq("balance below the reserve", maxBuy(limits(0.001)), 0n);

console.log("\nthe daily budget binds too:");
// 10% of (1 - 0.02) is 0.098; spending 0.09 leaves 0.008, below the 0.0196
// per-trade share, so the day is what binds.
eq("most of the day's risk already spent", maxBuy(limits(1, 0.09)), SOL(0.098) - SOL(0.09));
eq("the whole day's risk spent", maxBuy(limits(1, 0.2)), 0n);

// The chain's fixed 0.4 SOL daily limit is meaningless on a small wallet and
// restrictive on a large one, so whichever is tighter has to win.
eq("chain daily binds on a very large wallet",
  maxBuy(limits(100, 0.399)), SOL(0.4) - SOL(0.399));

console.log("\nrefusals name what bound them:");
const says = (l, fn, needle) => {
  try { fn(); bad(l, "it was allowed"); }
  catch (e) {
    if (e.message.includes(needle)) ok(`${l} -> "${needle}"`);
    else bad(l, `message was "${e.message}"`);
  }
};
says("over the share of balance", () => assertWithinBudget(limits(1), SOL(0.03)),
  "2% of the 0.980000 SOL tradable balance");
says("over the chain cap on a funded wallet", () => assertWithinBudget(limits(10), SOL(0.06)),
  "the chain's per-trade cap");
says("over what is left today", () => assertWithinBudget(limits(1, 0.09), SOL(0.015)),
  "what is left of today's budget");
says("wallet at the reserve", () => assertWithinBudget(limits(RESERVE), SOL(0.001)),
  "at or below the");

console.log("\ntuning is explicit:");
eq("1% instead of the 2% default",
  maxBuy(limits(1), { tradeBps: 100 }), SOL((1 - RESERVE) * 0.01));
eq("a larger reserve leaves less tradable",
  maxBuy(limits(1), { reserveLamports: Number(SOL(0.5)) }), SOL(0.5 * 0.02));
eq("the default is 2%", DEFAULT_TRADE_BPS, 200);

const allowed = maxBuy(limits(1));
try { assertWithinBudget(limits(1), allowed); ok("exactly the allowed amount passes"); }
catch (e) { bad("exactly the allowed amount", e.message); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
