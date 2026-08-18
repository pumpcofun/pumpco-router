// Attacks the policy gate. Each case is something a poisoned model might try to
// get the key to sign. All of them must be refused.
const {
  PublicKey, SystemProgram, TransactionInstruction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createCloseAccountInstruction,
  createSyncNativeInstruction,
} = require("@solana/spl-token");
const crypto = require("crypto");
const { assertOnlyPumpcoTrade, PolicyError, ROUTER, WSOL } = require("./policy");
const { parseIntent, IntentError } = require("./intent");

const AGENT = new PublicKey("CLeRK5GLfvRN6QeTv9Wi3Ma76SDeTpQB8ZXuoEvpnS6d");
const ATTACKER = new PublicKey("HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH");
const MINT = new PublicKey("3eY3fYwqwrLxFWqvw8xiurre6qg7U5YmvDanS3Lj1VoT");
const ownWsol = getAssociatedTokenAddressSync(WSOL, AGENT, true, TOKEN_PROGRAM_ID);
const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);

const routerTrade = (name = "buy_amm") =>
  new TransactionInstruction({
    programId: ROUTER,
    keys: [{ pubkey: AGENT, isSigner: true, isWritable: true }],
    data: Buffer.concat([disc(name), Buffer.alloc(16)]),
  });

let pass = 0, fail = 0;
const expectReject = (label, fn) => {
  try { fn(); console.log(`  FAIL  ${label}  <-- WAS ALLOWED`); fail++; }
  catch (e) {
    if (e instanceof PolicyError || e instanceof IntentError) { console.log(`  ok    ${label}`); pass++; }
    else { console.log(`  FAIL  ${label}  (wrong error: ${e.message})`); fail++; }
  }
};
const expectAllow = (label, fn) => {
  try { fn(); console.log(`  ok    ${label}`); pass++; }
  catch (e) { console.log(`  FAIL  ${label}  <-- REJECTED: ${e.message}`); fail++; }
};

console.log("\nintents the model must not be able to express:");
expectReject("a destination field at all", () =>
  parseIntent({ action: "buy", mint: MINT.toBase58(), sol: 0.01, to: ATTACKER.toBase58() }));
expectReject("action 'transfer'", () =>
  parseIntent({ action: "transfer", mint: MINT.toBase58(), sol: 0.01 }));
// A wallet-as-mint is caught by assertIsMint against the chain, not offline:
// real mints are on-curve too, so there is no offline test that separates them.
expectReject("size above the per-trade cap", () =>
  parseIntent({ action: "buy", mint: MINT.toBase58(), sol: 5 }, { maxSolPerTrade: 0.05 }));
expectAllow("a normal buy", () =>
  parseIntent({ action: "buy", mint: MINT.toBase58(), sol: 0.01 }, { maxSolPerTrade: 0.05 }));

console.log("\ntransactions the key must refuse to sign:");
expectReject("bare SOL transfer to an attacker", () =>
  assertOnlyPumpcoTrade([
    SystemProgram.transfer({ fromPubkey: AGENT, toPubkey: ATTACKER, lamports: 1e9 }),
  ], AGENT));

expectReject("drain smuggled alongside a real trade", () =>
  assertOnlyPumpcoTrade([
    routerTrade(),
    SystemProgram.transfer({ fromPubkey: AGENT, toPubkey: ATTACKER, lamports: 1e9 }),
  ], AGENT));

expectReject("wrap that funds someone else's wSOL account", () =>
  assertOnlyPumpcoTrade([
    routerTrade(),
    SystemProgram.transfer({
      fromPubkey: AGENT,
      toPubkey: getAssociatedTokenAddressSync(WSOL, ATTACKER, true, TOKEN_PROGRAM_ID),
      lamports: 1e9,
    }),
  ], AGENT));

expectReject("closeAccount paying out to an attacker", () =>
  assertOnlyPumpcoTrade([
    routerTrade(),
    createCloseAccountInstruction(ownWsol, ATTACKER, AGENT, [], TOKEN_PROGRAM_ID),
  ], AGENT));

expectReject("calling an unknown program", () =>
  assertOnlyPumpcoTrade([
    routerTrade(),
    new TransactionInstruction({ programId: ATTACKER, keys: [], data: Buffer.alloc(0) }),
  ], AGENT));

expectReject("a router instruction that is not a trade", () =>
  assertOnlyPumpcoTrade([routerTrade("update_config")], AGENT));

expectReject("no trade at all, just a transfer to self's wSOL", () =>
  assertOnlyPumpcoTrade([
    SystemProgram.transfer({ fromPubkey: AGENT, toPubkey: ownWsol, lamports: 1e9 }),
  ], AGENT));

expectReject("two trades in one transaction", () =>
  assertOnlyPumpcoTrade([routerTrade(), routerTrade()], AGENT));

expectAllow("the real shape: budget, wrap, sync, trade, unwrap", () =>
  assertOnlyPumpcoTrade([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }),
    SystemProgram.transfer({ fromPubkey: AGENT, toPubkey: ownWsol, lamports: 5_000_000 }),
    createSyncNativeInstruction(ownWsol, TOKEN_PROGRAM_ID),
    routerTrade(),
    createCloseAccountInstruction(ownWsol, AGENT, AGENT, [], TOKEN_PROGRAM_ID),
  ], AGENT));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
