// Prove the guards on the deployed program, against mainnet, for free.
//
// Each case takes one valid buy_amm and changes exactly one thing, then
// simulates. Simulation runs the real program on real accounts and costs
// nothing, so this is the cheapest honest evidence that the invariants hold on
// the binary that is actually deployed rather than on a local build.
//
// Usage: node scripts/guards-mainnet.js <mint>
require("dotenv").config({ path: __dirname + "/../.env", quiet: true });
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, LAMPORTS_PER_SOL, ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const swap = require("@pump-fun/pump-swap-sdk");
const crypto = require("crypto");
const fs = require("fs");

const RPC = process.env.SOLANA_RPC_URL;
const pk = (s) => new PublicKey(s);
const f = (x) => (x && x.publicKey ? x.publicKey : x);

const ROUTER = pk("PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp");
const AMM = pk("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const PUMP_CURVE = pk("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const FEE_PROGRAM = pk("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const WSOL = pk("So11111111111111111111111111111111111111112");
const FEE_VAULT = pk("AyxFYhVncAVRM6fHQsoQUyJmUCRtNAuk5UnzVm6anB4x");
const GLOBAL_CONFIG = pk("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const AMM_EVENT_AUTHORITY = pk("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
const AMM_FEE_CONFIG = pk("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
const GLOBAL_VOL = pk("C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw");

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

let pass = 0, fail = 0;
const ok = (l, why) => { console.log(`  ok    ${l}${why ? " -> " + why : ""}`); pass++; };
const bad = (l, why) => { console.log(`  FAIL  ${l}: ${why}`); fail++; };

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function readPool(pool) {
  const info = await rpc("getAccountInfo", [pool.toBase58(), { encoding: "base64" }]);
  if (!info?.value) throw new Error(`pool ${pool.toBase58()} does not exist`);
  const d = Buffer.from(info.value.data[0], "base64");
  let o = 8 + 1 + 2;
  o += 32;
  const baseMint = new PublicKey(d.subarray(o, o + 32)); o += 32;
  o += 32;
  const poolBase = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const poolQuote = new PublicKey(d.subarray(o, o + 32)); o += 32;
  o += 8;
  const coinCreator = new PublicKey(d.subarray(o, o + 32));
  return { baseMint, poolBase, poolQuote, coinCreator };
}

(async () => {
  const connection = new Connection(RPC, "confirmed");
  const mint = pk(process.argv[2] || "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump");
  const clerk = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.CLERK_KEY, "utf8"))));

  const pool = f(swap.canonicalPumpPoolPda(mint));
  const p = await readPool(pool);
  const poolV2 = f(swap.poolV2Pda(mint));
  const mintInfo = await rpc("getAccountInfo", [mint.toBase58(), { encoding: "base64" }]);
  const baseProgram = new PublicKey(mintInfo.value.owner);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [agentAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), clerk.publicKey.toBuffer()], ROUTER);
  const [userVol] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), clerk.publicKey.toBuffer()], AMM);
  const userBase = getAssociatedTokenAddressSync(mint, clerk.publicKey, true, baseProgram);
  const userQuote = getAssociatedTokenAddressSync(WSOL, clerk.publicKey, true, TOKEN_PROGRAM_ID);
  const creatorVaultAuth = f(swap.coinCreatorVaultAuthorityPda(p.coinCreator));
  const creatorVaultAta = getAssociatedTokenAddressSync(WSOL, creatorVaultAuth, true, TOKEN_PROGRAM_ID);

  const gcInfo = await rpc("getAccountInfo", [GLOBAL_CONFIG.toBase58(), { encoding: "base64" }]);
  const gc = Buffer.from(gcInfo.value.data[0], "base64");
  const feeRecipient = new PublicKey(gc.subarray(57, 89));
  const feeRecipientAta = getAssociatedTokenAddressSync(WSOL, feeRecipient, true, TOKEN_PROGRAM_ID);
  const buyback = new PublicKey(gc.subarray(643, 675));
  const buybackAta = getAssociatedTokenAddressSync(WSOL, buyback, true, TOKEN_PROGRAM_ID);

  const accounts = () => [
    m(config), m(agentAuth, false, true), m(clerk.publicKey, true, true),
    m(FEE_VAULT, false, true), m(AMM),
    m(pool, false, true), m(GLOBAL_CONFIG), m(mint), m(WSOL),
    m(userBase, false, true), m(userQuote, false, true),
    m(p.poolBase, false, true), m(p.poolQuote, false, true),
    m(feeRecipient), m(feeRecipientAta, false, true),
    m(baseProgram), m(TOKEN_PROGRAM_ID), m(ASSOCIATED_TOKEN_PROGRAM_ID),
    m(AMM_EVENT_AUTHORITY),
    m(creatorVaultAta, false, true), m(creatorVaultAuth),
    m(GLOBAL_VOL), m(userVol, false, true),
    m(AMM_FEE_CONFIG), m(FEE_PROGRAM), m(SystemProgram.programId),
    m(poolV2), m(buyback), m(buybackAta, false, true),
  ];

  const buyData = (baseOut, ceiling) =>
    Buffer.concat([disc("buy_amm"), u64(baseOut), u64(ceiling), Buffer.from([0])]);

  const sim = async (label, keys, data, expect) => {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      new TransactionInstruction({ programId: ROUTER, keys, data }));
    tx.feePayer = clerk.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const r = await connection.simulateTransaction(tx);
    const logs = (r.value.logs || []).join(" ");
    const hit = new RegExp(expect).test(logs);
    if (!r.value.err) return bad(label, `expected ${expect}, but it simulated clean`);
    if (hit) return ok(label, expect);
    const first = (r.value.logs || []).filter((l) => /Error|error/.test(l))[0] || JSON.stringify(r.value.err);
    bad(label, `expected ${expect}, got ${first.slice(0, 110)}`);
  };

  const CAP = 0.05 * LAMPORTS_PER_SOL;
  console.log(`guards on the deployed program, by simulation\nmint ${mint.toBase58()}\n`);

  // 1. per-trade cap
  await sim("buy above max_lamports_per_trade", accounts(), buyData(1, CAP + 1), "TradeTooLarge");

  // 2. fee redirected
  const k2 = accounts();
  k2[3] = m(Keypair.generate().publicKey, false, true);
  await sim("fee redirected to another vault", k2, buyData(1, 1000), "WrongFeeVault");

  // 3. CPI target swapped for the other pump.fun program
  const k3 = accounts();
  k3[4] = m(PUMP_CURVE);
  await sim("CPI target swapped to the curve program", k3, buyData(1, 1000), "WrongProgram");

  // 4. CPI target swapped for something unrelated
  const k4 = accounts();
  k4[4] = m(TOKEN_PROGRAM_ID);
  await sim("CPI target swapped to the token program", k4, buyData(1, 1000), "WrongProgram");

  // 5. someone else's budget
  const k5 = accounts();
  const [foreign] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), Keypair.generate().publicKey.toBuffer()], ROUTER);
  k5[1] = m(foreign, false, true);
  await sim("spending another agent's budget", k5, buyData(1, 1000), "ConstraintSeeds|AccountNotInitialized");

  // 6. zero size
  await sim("zero amount", accounts(), buyData(0, 0), "ZeroAmount|TradeTooLarge");

  // 7. the daily budget, which binds below the per-trade cap once spent
  await sim("buy inside the per-trade cap but past the daily budget",
    accounts(), buyData(1, 0.01 * LAMPORTS_PER_SOL), "DailyLimitExceeded");

  // 8. a config that is not the real one
  const k7 = accounts();
  k7[0] = m(Keypair.generate().publicKey);
  await sim("substituted config account", k7, buyData(1, 1000), "ConstraintSeeds|AccountNotInitialized|AccountOwnedByWrongProgram");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
