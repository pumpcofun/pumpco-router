// The bonding curve leg, which had never run on mainnet.
//
// Everything is derived from chain rather than transcribed: the fee recipient
// comes out of pump.fun's Global account, the curve and its vaults are PDAs, and
// the mint's own token program is read rather than assumed.
//
// Usage: node scripts/trade-curve-mainnet.js buy  <mint> <sol> [--send]
//        node scripts/trade-curve-mainnet.js sell <mint> [--send]
require("dotenv").config({ path: __dirname + "/../.env", quiet: true });
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} = require("@solana/spl-token");
const crypto = require("crypto");
const fs = require("fs");

const RPC = process.env.SOLANA_RPC_URL;
const pk = (s) => new PublicKey(s);
const ROUTER = pk("PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp");
const PUMP = pk("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const FEE_PROGRAM = pk("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const GLOBAL = pk("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const FEE_VAULT = pk("AyxFYhVncAVRM6fHQsoQUyJmUCRtNAuk5UnzVm6anB4x");

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const pda = (seeds, prog) => PublicKey.findProgramAddressSync(seeds, prog)[0];

(async () => {
  const side = process.argv[2] === "sell" ? "sell" : "buy";
  const mint = pk(process.argv[3]);
  const spendSol = parseFloat(process.argv[4]) || 0.01;
  const doSend = process.argv.includes("--send");

  const connection = new Connection(RPC, "confirmed");
  const clerk = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.CLERK_KEY, "utf8"))));

  const mintInfo = await connection.getAccountInfo(mint);
  const tokenProgram = mintInfo.owner;

  const curve = pda([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP);
  const ci = await connection.getAccountInfo(curve);
  if (!ci) throw new Error("no bonding curve for this mint");
  const vTokens = ci.data.readBigUInt64LE(8);
  const vSol = ci.data.readBigUInt64LE(16);
  const complete = ci.data[48] === 1;
  const creator = new PublicKey(ci.data.subarray(49, 81));
  if (complete) throw new Error("this curve has graduated; use the AMM path");

  const gi = await connection.getAccountInfo(GLOBAL);
  const feeRecipient = new PublicKey(gi.data.subarray(41, 73));
  // Global also carries eight buyback recipients, at 741 stepping by 32. A buy
  // that omits one fails with BuybackFeeRecipientMissing.
  const buybacks = Array.from({ length: 8 }, (_, i) =>
    new PublicKey(gi.data.subarray(741 + i * 32, 773 + i * 32)));
  const buyback = buybacks[Math.floor(Math.random() * buybacks.length)];
  // The curve's answer to poolV2: usually absent on chain, and passed anyway.
  // What matters is that it comes first among the trailing accounts.
  const curveV2 = pda([Buffer.from("bonding-curve-v2"), mint.toBuffer()], PUMP);

  const assocCurve = getAssociatedTokenAddressSync(mint, curve, true, tokenProgram);
  const assocUser = getAssociatedTokenAddressSync(mint, clerk.publicKey, true, tokenProgram);
  const creatorVault = pda([Buffer.from("creator-vault"), creator.toBuffer()], PUMP);
  const eventAuthority = pda([Buffer.from("__event_authority")], PUMP);
  const globalVol = pda([Buffer.from("global_volume_accumulator")], PUMP);
  const userVol = pda([Buffer.from("user_volume_accumulator"), clerk.publicKey.toBuffer()], PUMP);
  const feeConfig = pda([Buffer.from("fee_config"), PUMP.toBuffer()], FEE_PROGRAM);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [agentAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), clerk.publicKey.toBuffer()], ROUTER);

  console.log("clerk        :", clerk.publicKey.toBase58());
  console.log("mint         :", mint.toBase58());
  console.log("curve        :", curve.toBase58(), "| complete", complete);
  console.log("reserves     :", (Number(vSol) / LAMPORTS_PER_SOL).toFixed(3), "vSOL");
  console.log("creator      :", creator.toBase58());
  console.log("fee recipient:", feeRecipient.toBase58());

  const keys = [
    m(config), m(agentAuth, false, true), m(clerk.publicKey, true, true),
    m(FEE_VAULT, false, true), m(PUMP),
    m(GLOBAL), m(feeRecipient, false, true), m(mint),
    m(curve, false, true), m(assocCurve, false, true),
    m(assocUser, false, true), m(creatorVault, false, true),
    m(eventAuthority), m(globalVol), m(userVol, false, true),
    m(feeConfig), m(FEE_PROGRAM), m(tokenProgram), m(SystemProgram.programId),
    m(curveV2, false, true), m(buyback, false, true),
  ];

  let data;
  if (side === "sell") {
    const held = BigInt((await connection.getTokenAccountBalance(assocUser)).value.amount);
    if (held === 0n) throw new Error("nothing held to sell");
    console.log("selling      :", held.toString(), "base units");
    data = Buffer.concat([disc("sell"), u64(held), u64(0)]);
  } else {
    const spend = BigInt(Math.floor(spendSol * LAMPORTS_PER_SOL));
    const out = (vTokens * spend) / (vSol + spend) / 2n;
    console.log("buying       : ~" + out.toString(), "base units for up to", spendSol, "SOL");
    data = Buffer.concat([disc("buy"), u64(out), u64(spend)]);
  }

  const prep = [];
  if (!(await connection.getAccountInfo(userVol))) {
    prep.push(new TransactionInstruction({
      programId: PUMP,
      keys: [m(clerk.publicKey, true, true), m(clerk.publicKey), m(userVol, false, true),
             m(SystemProgram.programId), m(eventAuthority), m(PUMP)],
      data: disc("init_user_volume_accumulator"),
    }));
  }
  if (side === "buy" && !(await connection.getAccountInfo(assocUser))) {
    prep.push(createAssociatedTokenAccountIdempotentInstruction(
      clerk.publicKey, assocUser, clerk.publicKey, mint, tokenProgram));
  }

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }),
    new TransactionInstruction({ programId: ROUTER, keys, data }));
  tx.feePayer = clerk.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  if (prep.length) {
    if (!doSend) { console.log(`\nsetup        : ${prep.length} instruction(s) needed first; rerun with --send`); }
    else {
      const ptx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }), ...prep);
      console.log("\nsetup        :", await sendAndConfirmTransaction(connection, ptx, [clerk], { commitment: "confirmed" }));
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    }
  }

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.error("\nsimulation failed:", JSON.stringify(sim.value.err));
    (sim.value.logs || []).slice(-14).forEach((l) => console.error("  ", l));
    process.exit(1);
  }
  console.log("\nsimulation OK, compute units:", sim.value.unitsConsumed);
  if (!doSend) { console.log("dry run. pass --send to submit"); return; }

  const before = await connection.getBalance(clerk.publicKey);
  const sig = await sendAndConfirmTransaction(connection, tx, [clerk], { commitment: "confirmed" });
  const after = await connection.getBalance(clerk.publicKey);
  console.log("\nSENT");
  console.log(`https://solscan.io/tx/${sig}`);
  console.log("clerk delta  :", ((after - before) / LAMPORTS_PER_SOL).toFixed(9), "SOL");
})().catch((e) => { console.error(e.message); process.exit(1); });
