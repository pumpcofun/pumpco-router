// Exercise buy_amm and sell_amm against PumpSwap's real program, using a
// graduated pool cloned from mainnet.
//
// The AMM differs from the curve in the one way that matters: the quote asset is
// WSOL, and PumpSwap does not wrap for you. So the client wraps, trades, and
// unwraps, and the router measures the fee from the WSOL account rather than
// from the agent's lamports.
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
  TOKEN_2022_PROGRAM_ID,
} = require("@solana/spl-token");
const crypto = require("crypto");
const fs = require("fs");

const RPC = "http://127.0.0.1:8899";
const pk = (s) => new PublicKey(s);

const ROUTER = pk("pumpcoEZJNNneH9KjrpBSVCKpADVgJpBbtkGvbtFbuy");
const AMM = pk("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const FEE_PROGRAM = pk("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const WSOL = pk("So11111111111111111111111111111111111111112");

const POOL = pk("EuobJ9jJaJhW6EJDTi5Wjw7NkQqznCkrW9Ly8vuy3D93");
const GLOBAL_CONFIG = pk("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const BASE_MINT = pk("EvWwHE1zjYv4gJjDCvtbdjUK6vsqSXyu9R5w2Lvhpump");
const POOL_BASE = pk("DKdMJ241FK3W57RiUeNWvFmxQUvrQDcoSDF5rZFtDG9T");
const POOL_QUOTE = pk("GHsbvCJcWoEnxYRJFGnLgzbgHj3Yv7d63u2VpF3ivgyP");
const FEE_RECIPIENT = pk("62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV");
const FEE_RECIPIENT_ATA = pk("94qWNrtmfn42h3ZjUZwWvK1MEo9uVmmrBPd2hpNjYDjb");
const AMM_EVENT_AUTHORITY = pk("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
const AMM_FEE_CONFIG = pk("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
const GLOBAL_VOL = pk("C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw");
const CREATOR_VAULT_AUTH = pk("5qCBGXF6FExpxNJWgFLSwzwW3B8gaKsPKuAHd5d4UZk6");
const CREATOR_VAULT_ATA = pk("2N4nFkvSj13gJyXwUy4nbrxVWFMCJzrW356rK2UTzJcS");
const POOL_V2 = pk("4RBFvMn8pLDAe95W16S2RB2GbzSY4dJ1K3TaaRHwHvCr");

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

async function send(connection, ixs, signers, label) {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    console.log(`  OK   ${label}`);
    return sig;
  } catch (e) {
    console.log(`  FAIL ${label}`);
    const logs = e.logs || (e.getLogs ? await e.getLogs().catch(() => null) : null);
    if (logs) {
      logs.filter((l) => /Error|error|failed|Instruction:/.test(l)).slice(-8)
        .forEach((l) => console.log("       |", l.trim()));
    } else {
      console.log("       |", e.message.split("\n")[0]);
    }
    return null;
  }
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const funder = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync("C:/Users/offic/.config/solana/id.json", "utf8"))));
  const authority = Keypair.generate();
  const agent = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.AGENT_KEY, "utf8"))));
  const feeVault = Keypair.generate();
  const treasury = Keypair.generate();

  const rentMin = await connection.getMinimumBalanceForRentExemption(0);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: authority.publicKey, lamports: 20 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: agent.publicKey, lamports: 20 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: feeVault.publicKey, lamports: rentMin }),
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: treasury.publicKey, lamports: rentMin })
  ), [funder], { commitment: "confirmed" });

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [agentAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agent.publicKey.toBuffer()], ROUTER);
  const [userVol] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), agent.publicKey.toBuffer()], AMM);

  const userBase = getAssociatedTokenAddressSync(BASE_MINT, agent.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const userQuote = getAssociatedTokenAddressSync(WSOL, agent.publicKey, true, TOKEN_PROGRAM_ID);

  console.log("agent    :", agent.publicKey.toBase58());
  console.log("pool     :", POOL.toBase58(), "\n");

  console.log("--- setup ---");
  await send(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true, true),
           m(feeVault.publicKey), m(treasury.publicKey), m(SystemProgram.programId)],
    data: Buffer.concat([disc("initialize"), u16(100), u64(LAMPORTS_PER_SOL), u64(5 * LAMPORTS_PER_SOL)]),
  })], [authority], "initialize (1% fee)");

  await send(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config), m(authority.publicKey, true, true), m(agent.publicKey),
           m(agentAuth, false, true), m(SystemProgram.programId)],
    data: Buffer.concat([disc("register_agent"), u64(5 * LAMPORTS_PER_SOL), u16(0)]),
  })], [authority], "register_agent");

  // PumpSwap tracks per-user volume in a PDA that must already exist.
  await send(connection, [new TransactionInstruction({
    programId: AMM,
    keys: [m(agent.publicKey, true, true), m(agent.publicKey), m(userVol, false, true),
           m(SystemProgram.programId), m(AMM_EVENT_AUTHORITY), m(AMM)],
    data: disc("init_user_volume_accumulator"),
  })], [agent], "init_user_volume_accumulator (AMM)");

  // The wrap the program will not do for us.
  const WRAP = BigInt(0.05 * LAMPORTS_PER_SOL);
  await send(connection, [
    createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, userBase, agent.publicKey, BASE_MINT, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(agent.publicKey, userQuote, agent.publicKey, WSOL, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: userQuote, lamports: WRAP }),
    createSyncNativeInstruction(userQuote, TOKEN_PROGRAM_ID),
  ], [agent], `wrap ${Number(WRAP) / LAMPORTS_PER_SOL} SOL into WSOL`);

  const tradeAccounts = [
    m(config), m(agentAuth, false, true), m(agent.publicKey, true, true),
    m(feeVault.publicKey, false, true), m(AMM),
    m(POOL, false, true), m(GLOBAL_CONFIG), m(BASE_MINT), m(WSOL),
    m(userBase, false, true), m(userQuote, false, true),
    m(POOL_BASE, false, true), m(POOL_QUOTE, false, true),
    m(FEE_RECIPIENT), m(FEE_RECIPIENT_ATA, false, true),
    m(TOKEN_2022_PROGRAM_ID), m(TOKEN_PROGRAM_ID), m(ASSOCIATED_TOKEN_PROGRAM_ID),
    m(AMM_EVENT_AUTHORITY),
    m(CREATOR_VAULT_ATA, false, true), m(CREATOR_VAULT_AUTH),
    m(GLOBAL_VOL), m(userVol, false, true),
    m(AMM_FEE_CONFIG), m(FEE_PROGRAM), m(SystemProgram.programId),
    // trailing accounts live PumpSwap trades carry beyond the IDL's 23
    m(POOL_V2), m(pk("5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD")), m(pk("CASRL2zkwDnppxEFQ4LgdwgR9pdz5Q8R8nEMKVZ9QoLp"), false, true),
  ];

  // Size the buy off real reserves so the slippage ceiling is realistic.
  const [baseRes, quoteRes] = await Promise.all([
    connection.getTokenAccountBalance(POOL_BASE),
    connection.getTokenAccountBalance(POOL_QUOTE),
  ]);
  const bRes = BigInt(baseRes.value.amount), qRes = BigInt(quoteRes.value.amount);
  const spend = BigInt(0.01 * LAMPORTS_PER_SOL);
  const baseOut = (bRes * spend) / (qRes + spend) / 2n; // half the naive quote, well inside slippage
  console.log(`\n  pool: ${Number(bRes) / 1e6} base / ${Number(qRes) / LAMPORTS_PER_SOL} SOL`);
  console.log(`  buying ${Number(baseOut) / 1e6} base, ceiling 0.03 SOL`);

  console.log("\n--- buy_amm ---");
  const qBefore = BigInt((await connection.getTokenAccountBalance(userQuote)).value.amount);
  const vBefore = await connection.getBalance(feeVault.publicKey);

  const buySig = await send(connection, [new TransactionInstruction({
    programId: ROUTER, keys: tradeAccounts,
    data: Buffer.concat([disc("buy_amm"), u64(baseOut), u64(0.03 * LAMPORTS_PER_SOL), Buffer.from([0])]),
  })], [agent], "router buy_amm -> PumpSwap CPI");

  if (buySig) {
    const qAfter = BigInt((await connection.getTokenAccountBalance(userQuote)).value.amount);
    const vAfter = await connection.getBalance(feeVault.publicKey);
    const held = (await connection.getTokenAccountBalance(userBase)).value.uiAmountString;
    const spentQuote = Number(qBefore - qAfter) / LAMPORTS_PER_SOL;
    const fee = (vAfter - vBefore) / LAMPORTS_PER_SOL;
    console.log(`    WSOL spent  : ${spentQuote.toFixed(6)}`);
    console.log(`    fee taken   : ${fee.toFixed(6)} SOL`);
    console.log(`    implied rate: ${((fee / spentQuote) * 100).toFixed(3)}%  (configured 1.000%)`);
    console.log(`    base held   : ${held}`);

    const tx = await connection.getTransaction(buySig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log("\n  CPI trace:");
    (tx?.meta?.logMessages || []).filter((l) => /invoke \[|Instruction: /.test(l))
      .forEach((l) => console.log("   ", l.trim()));

    console.log("\n--- sell_amm ---");
    const sellAmount = BigInt((await connection.getTokenAccountBalance(userBase)).value.amount);
    await send(connection, [new TransactionInstruction({
      programId: ROUTER, keys: tradeAccounts,
      data: Buffer.concat([disc("sell_amm"), u64(sellAmount), u64(0)]),
    })], [agent], `sell_amm all ${Number(sellAmount) / 1e6} base back`);

    const qEnd = BigInt((await connection.getTokenAccountBalance(userQuote)).value.amount);
    console.log(`    WSOL recovered: ${Number(qEnd - qAfter) / LAMPORTS_PER_SOL}`);

    await send(connection, [createCloseAccountInstruction(userQuote, agent.publicKey, agent.publicKey, [], TOKEN_PROGRAM_ID)],
      [agent], "unwrap (closeAccount returns native SOL)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
