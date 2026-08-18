// The clerk's first real trade, routed through the pumpco router on mainnet.
// Simulates first and refuses to send unless the simulation succeeds.
//
// Usage: node scripts/trade-mainnet.js buy  <mint> <sol-to-spend> [--send]
//        node scripts/trade-mainnet.js sell <mint> [--send]
require("dotenv").config({ path: __dirname + "/../.env", quiet: true });
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const swap = require("@pump-fun/pump-swap-sdk");
const crypto = require("crypto");
const fs = require("fs");

const RPC = process.env.SOLANA_RPC_URL;
const pk = (s) => new PublicKey(s);
const f = (v) => (Array.isArray(v) ? v[0] : v);

const ROUTER = pk("PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp");
const AMM = pk("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const FEE_PROGRAM = pk("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const WSOL = pk("So11111111111111111111111111111111111111112");
const FEE_VAULT = pk("AyxFYhVncAVRM6fHQsoQUyJmUCRtNAuk5UnzVm6anB4x");
const GLOBAL_CONFIG = pk("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const AMM_EVENT_AUTHORITY = pk("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
const AMM_FEE_CONFIG = pk("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
const GLOBAL_VOL = pk("C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw");
const PROTOCOL_FEE_RECIPIENT = pk("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD");

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result;
}

async function readPool(pool) {
  const info = await rpc("getAccountInfo", [pool.toBase58(), { encoding: "base64" }]);
  if (!info?.value) throw new Error(`pool ${pool.toBase58()} does not exist`);
  const d = Buffer.from(info.value.data[0], "base64");
  let o = 8;
  o += 1 + 2;                       // bump, index
  o += 32;                          // creator (the pool authority)
  const baseMint = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const quoteMint = new PublicKey(d.subarray(o, o + 32)); o += 32;
  o += 32;                          // lpMint
  const poolBase = new PublicKey(d.subarray(o, o + 32)); o += 32;
  const poolQuote = new PublicKey(d.subarray(o, o + 32)); o += 32;
  o += 8;                           // lpSupply
  const coinCreator = new PublicKey(d.subarray(o, o + 32));
  return { baseMint, quoteMint, poolBase, poolQuote, coinCreator };
}

async function main() {
  const side = process.argv[2] === "sell" ? "sell" : "buy";
  const mint = pk(process.argv[3]);
  const spendSol = parseFloat(process.argv[4]) || 0.005;
  const doSend = process.argv.includes("--send");
  if (!RPC) throw new Error("SOLANA_RPC_URL not set");

  const connection = new Connection(RPC, "confirmed");
  const clerk = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.CLERK_KEY, "utf8"))));

  const pool = f(swap.canonicalPumpPoolPda(mint));
  const p = await readPool(pool);
  const poolV2 = f(swap.poolV2Pda(mint));

  // The base mint's own program, never assumed.
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
  // The vault's token account is a plain ATA of the vault *authority*, not of
  // the coin creator. Deriving it from the creator gives an address PumpSwap
  // has never heard of, and it fails with a bare "account missing".
  const creatorVaultAta = getAssociatedTokenAddressSync(
    WSOL, creatorVaultAuth, true, TOKEN_PROGRAM_ID);
  // Read the live recipient set rather than hardcoding. GlobalConfig holds
  // eight of them starting at offset 57, and passing one that is not in that
  // array fails with InvalidProtocolFeeRecipient.
  const gcInfo = await rpc("getAccountInfo", [GLOBAL_CONFIG.toBase58(), { encoding: "base64" }]);
  const gc = Buffer.from(gcInfo.value.data[0], "base64");
  const recipients = Array.from({ length: 8 }, (_, i) =>
    new PublicKey(gc.subarray(57 + i * 32, 57 + (i + 1) * 32)));
  // Spread load across them the way the official client does.
  const feeRecipient = recipients[Math.floor(Math.random() * recipients.length)];
  const feeRecipientAta = getAssociatedTokenAddressSync(
    WSOL, feeRecipient, true, TOKEN_PROGRAM_ID);

  // GlobalConfig carries a SECOND, different set at offset 643: the buyback
  // recipients. The trailing accounts on a buy come from here, and using one
  // of the protocol recipients instead fails BuybackFeeRecipientNotAuthorized.
  const buybacks = Array.from({ length: 8 }, (_, i) =>
    new PublicKey(gc.subarray(643 + i * 32, 643 + (i + 1) * 32)));
  const buyback = buybacks[Math.floor(Math.random() * buybacks.length)];
  const buybackAta = getAssociatedTokenAddressSync(WSOL, buyback, true, TOKEN_PROGRAM_ID);

  // Quote off live reserves, then halve it so the ceiling is never the binding
  // constraint on a first run.
  const [baseBal, quoteBal] = await Promise.all([
    rpc("getTokenAccountBalance", [p.poolBase.toBase58()]),
    rpc("getTokenAccountBalance", [p.poolQuote.toBase58()]),
  ]);
  const bRes = BigInt(baseBal.value.amount), qRes = BigInt(quoteBal.value.amount);
  const spend = BigInt(Math.floor(spendSol * LAMPORTS_PER_SOL));
  const baseOut = (bRes * spend) / (qRes + spend) / 2n;
  const ceiling = spend;

  console.log("clerk       :", clerk.publicKey.toBase58());
  console.log("mint        :", mint.toBase58(), "(" + baseProgram.toBase58().slice(0, 8) + "...)");
  console.log("pool        :", pool.toBase58());
  console.log("reserves    :", (Number(bRes) / 1e6).toFixed(0), "base /", (Number(qRes) / LAMPORTS_PER_SOL).toFixed(2), "SOL");
  console.log("spending    :", spendSol, "SOL for ~" + (Number(baseOut) / 1e6).toFixed(2), "tokens");
  console.log("balance     :", (await connection.getBalance(clerk.publicKey)) / LAMPORTS_PER_SOL, "SOL\n");

  const accounts = [
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
    // trailing accounts live PumpSwap buys carry
    m(poolV2), m(buyback), m(buybackAta, false, true),
  ];

  // A sell carries five trailing accounts where a buy carries three, and the
  // first two are the volume accumulator and its own WSOL account. Taken from a
  // live mainnet sell rather than derived, because the shape is undocumented.
  // A sell takes the same three trailing accounts as a buy, in the same order.
  // pool_v2 does not exist on chain for most pools and is passed regardless;
  // what fails is putting it anywhere other than first.
  const sellTrailing = [m(poolV2), m(buyback), m(buybackAta, false, true)];

  // Setup rides in its own transaction. With both ATA creates and the
  // accumulator inline, a buy comes to 1237 bytes against a 1232 limit.
  const prep = [];
  if (!(await connection.getAccountInfo(userVol))) {
    prep.push(new TransactionInstruction({
      programId: AMM,
      keys: [m(clerk.publicKey, true, true), m(clerk.publicKey), m(userVol, false, true),
             m(SystemProgram.programId), m(AMM_EVENT_AUTHORITY), m(AMM)],
      data: disc("init_user_volume_accumulator"),
    }));
  }
  if (side === "buy" && !(await connection.getAccountInfo(userBase))) {
    prep.push(createAssociatedTokenAccountIdempotentInstruction(
      clerk.publicKey, userBase, clerk.publicKey, mint, baseProgram));
  }
  if (!(await connection.getAccountInfo(userQuote))) {
    prep.push(createAssociatedTokenAccountIdempotentInstruction(
      clerk.publicKey, userQuote, clerk.publicKey, WSOL, TOKEN_PROGRAM_ID));
  }
  if (prep.length) {
    if (!doSend) {
      console.log(`
setup       : ${prep.length} instruction(s) needed first; rerun with --send`);
      return;
    }
    const ptx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }), ...prep);
    const psig = await sendAndConfirmTransaction(connection, ptx, [clerk], { commitment: "confirmed" });
    console.log("setup       :", psig);
  }

  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }),
  ];

  if (side === "sell") {
    const held = BigInt((await rpc("getTokenAccountBalance", [userBase.toBase58()])).value.amount);
    if (held === 0n) throw new Error("nothing held to sell");
    console.log("selling     :", (Number(held) / 1e6).toFixed(6), "tokens");
    ixs.push(
      new TransactionInstruction({
        programId: ROUTER,
        keys: accounts.slice(0, 26).concat(sellTrailing),
        data: Buffer.concat([disc("sell_amm"), u64(held), u64(0)]),
      }),
      createCloseAccountInstruction(userQuote, clerk.publicKey, clerk.publicKey, [], TOKEN_PROGRAM_ID)
    );
  } else {
  ixs.push(
    SystemProgram.transfer({ fromPubkey: clerk.publicKey, toPubkey: userQuote, lamports: spend }),
    createSyncNativeInstruction(userQuote, TOKEN_PROGRAM_ID),
    new TransactionInstruction({
      programId: ROUTER, keys: accounts,
      data: Buffer.concat([disc("buy_amm"), u64(baseOut), u64(ceiling), Buffer.from([0])]),
    }),
    // Returns unspent slippage and the account rent as native SOL.
    createCloseAccountInstruction(userQuote, clerk.publicKey, clerk.publicKey, [], TOKEN_PROGRAM_ID)
  );
  }

  const tx = new Transaction().add(...ixs);
  tx.feePayer = clerk.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(clerk);

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.log("SIMULATION FAILED:", JSON.stringify(sim.value.err));
    (sim.value.logs || []).slice(-18).forEach((l) => console.log("  |", l));
    process.exit(1);
  }
  console.log("simulation OK, compute units:", sim.value.unitsConsumed);

  if (!doSend) {
    console.log("\ndry run. re-run with --send to broadcast.");
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [clerk], { commitment: "confirmed" });
  console.log("\nSENT");
  console.log("https://solscan.io/tx/" + sig);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
