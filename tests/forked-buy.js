// Exercise the pumpco router against pump.fun's real program on a forked local
// validator. Every pump.fun account below is taken from a known-good mainnet buy.
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

const RPC = "http://127.0.0.1:8899";
const pk = (s) => new PublicKey(s);

const ROUTER = pk("pumpcoEZJNNneH9KjrpBSVCKpADVgJpBbtkGvbtFbuy");
const PUMP = pk("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const FEE_PROGRAM = pk("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const TOKEN_2022 = pk("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA_PROGRAM = pk("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

const GLOBAL = pk("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const FEE_RECIPIENT = pk("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
const MINT = pk("4JzHAN3MgpRK7dgKg1SXuXcLiyH88GEQQsFE12XEpump");
const BONDING_CURVE = pk("454nCttsWVwQcGiFDvYGeYrsSDnzdAZtX8nqUKoMaGuW");
const ASSOC_BONDING_CURVE = pk("GfPehpw1Ve62Zo2bYLMTbu73Fv6tyHKq9Z7uPTFoP7Hw");
const CREATOR_VAULT = pk("7ciFAiGp4rtzEcMUHor5N1Nk1qG84NcjTVwpsbbKRp2F");
const EVENT_AUTHORITY = pk("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const GLOBAL_VOL = pk("Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y");
const FEE_CONFIG = pk("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");
const EXTRA_1 = pk("BdJ7Nc4G2vxr7R1QgMJq3Frg4BdG27MDfFuzAB7jVc6o");
const EXTRA_2 = pk("A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW");

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

async function send(connection, ixs, signers, label) {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs);
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
    console.log(`  OK   ${label}`);
    return sig;
  } catch (e) {
    console.log(`  FAIL ${label}: ${e.message}`);
    const logs = e.logs || (e.getLogs ? await e.getLogs().catch(() => null) : null);
    if (logs) logs.slice(-22).forEach((l) => console.log("       |", l));
    return null;
  }
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const authority = Keypair.generate();
  const agent = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(process.env.AGENT_KEY, "utf8"))));
  const feeVault = Keypair.generate();
  // Nothing here distributes creator rewards, but initialize still records one.
  const treasury = Keypair.generate();

  // The validator pre-funds the CLI default keypair; airdrops are rate limited.
  const funder = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.FUNDER_KEY || require("os").homedir() + "/.config/solana/id.json", "utf8"))));
  await sendAndConfirmTransaction(connection, new Transaction().add(
    ...[authority.publicKey, agent.publicKey].map((to) =>
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports: 20 * LAMPORTS_PER_SOL })),
    // The vault must already be rent exempt. A fee smaller than the rent
    // minimum landing in an empty account fails the whole transaction.
    SystemProgram.transfer({
      fromPubkey: funder.publicKey, toPubkey: feeVault.publicKey,
      lamports: await connection.getMinimumBalanceForRentExemption(0),
    })
  ), [funder], { commitment: "confirmed" });
  console.log("agent    :", agent.publicKey.toBase58());
  console.log("feeVault :", feeVault.publicKey.toBase58(), "\n");

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [agentAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agent.publicKey.toBuffer()], ROUTER);
  const [userVol] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), agent.publicKey.toBuffer()], PUMP);
  const [agentAta] = PublicKey.findProgramAddressSync(
    [agent.publicKey.toBuffer(), TOKEN_2022.toBuffer(), MINT.toBuffer()], ATA_PROGRAM);

  console.log("--- setup ---");
  await send(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true, true),
           m(feeVault.publicKey), m(treasury.publicKey), m(SystemProgram.programId)],
    data: Buffer.concat([disc("initialize"), u16(100), u64(LAMPORTS_PER_SOL), u64(5 * LAMPORTS_PER_SOL)]),
  })], [authority], "initialize (1% fee, 1 SOL per-trade cap)");

  await send(connection, [new TransactionInstruction({
    programId: ROUTER,
    // config is writable: registering an agent adds to its total_reward_bps.
    keys: [m(config, false, true), m(authority.publicKey, true, true), m(agent.publicKey),
           m(agentAuth, false, true), m(SystemProgram.programId)],
    // No reward share, billed at the config rate, which is what the fee
    // assertions below expect.
    data: Buffer.concat([disc("register_agent"), u64(0.6 * LAMPORTS_PER_SOL), u16(0), u16(100)]),
  })], [authority], "register_agent (0.6 SOL daily budget)");

  // Idempotent ATA create (instruction 1).
  await send(connection, [new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [m(agent.publicKey, true, true), m(agentAta, false, true), m(agent.publicKey),
           m(MINT), m(SystemProgram.programId), m(TOKEN_2022)],
    data: Buffer.from([1]),
  })], [agent], "create agent ATA (Token-2022)");

  // pump.fun tracks per-user volume in a PDA that must already exist.
  await send(connection, [new TransactionInstruction({
    programId: PUMP,
    keys: [m(agent.publicKey, true, true), m(agent.publicKey), m(userVol, false, true),
           m(SystemProgram.programId), m(EVENT_AUTHORITY), m(PUMP)],
    data: disc("init_user_volume_accumulator"),
  })], [agent], "init_user_volume_accumulator");

  const tradeAccounts = [
    m(config), m(agentAuth, false, true), m(agent.publicKey, true, true),
    m(feeVault.publicKey, false, true), m(PUMP),
    m(GLOBAL), m(FEE_RECIPIENT, false, true), m(MINT),
    m(BONDING_CURVE, false, true), m(ASSOC_BONDING_CURVE, false, true),
    m(agentAta, false, true), m(CREATOR_VAULT, false, true),
    m(EVENT_AUTHORITY), m(GLOBAL_VOL), m(userVol, false, true),
    m(FEE_CONFIG), m(FEE_PROGRAM), m(TOKEN_2022), m(SystemProgram.programId),
    // trailing accounts the real mainnet buy carries
    m(EXTRA_1, false, true), m(EXTRA_2, false, true),
  ];

  console.log("\n--- the actual trade ---");
  const before = await connection.getBalance(agent.publicKey);
  const sig = await send(connection, [new TransactionInstruction({
    programId: ROUTER, keys: tradeAccounts,
    data: Buffer.concat([disc("buy"), u64(1_000_000_000), u64(0.05 * LAMPORTS_PER_SOL)]),
  })], [agent], "router buy -> pump.fun CPI");

  if (sig) {
    const after = await connection.getBalance(agent.publicKey);
    const vault = await connection.getBalance(feeVault.publicKey);
    let tokens = "0";
    try {
      tokens = (await connection.getTokenAccountBalance(agentAta)).value.uiAmountString;
    } catch {}
    console.log(`\n  agent spent : ${((before - after) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`  fee vault   : ${(vault / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`  tokens held : ${tokens}`);
    const tx = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    console.log("\n  CPI trace:");
    (tx?.meta?.logMessages || []).filter((l) => /invoke \[|Instruction: /.test(l))
      .forEach((l) => console.log("   ", l.trim()));
  }

  // A trade big enough that a 1% fee is clearly visible.
  console.log("\n--- larger buy, to verify the fee is really taken ---");
  const vaultBefore = await connection.getBalance(feeVault.publicKey);
  const agentBefore = await connection.getBalance(agent.publicKey);
  if (await send(connection, [new TransactionInstruction({
    programId: ROUTER, keys: tradeAccounts,
    data: Buffer.concat([disc("buy"), u64(4_000_000_000_000), u64(0.5 * LAMPORTS_PER_SOL)]),
  })], [agent], "buy ~0.2 SOL of tokens")) {
    const vaultAfter = await connection.getBalance(feeVault.publicKey);
    const agentAfter = await connection.getBalance(agent.publicKey);
    const spent = (agentBefore - agentAfter) / LAMPORTS_PER_SOL;
    const fee = (vaultAfter - vaultBefore) / LAMPORTS_PER_SOL;
    console.log(`    agent spent : ${spent.toFixed(6)} SOL`);
    console.log(`    fee taken   : ${fee.toFixed(6)} SOL`);
    console.log(`    implied rate: ${((fee / (spent - fee)) * 100).toFixed(3)}%  (configured 1.000%)`);
  }

  console.log("\n--- guards must actually bite ---");
  await send(connection, [new TransactionInstruction({
    programId: ROUTER, keys: tradeAccounts,
    data: Buffer.concat([disc("buy"), u64(1_000_000_000), u64(2 * LAMPORTS_PER_SOL)]),
  })], [agent], "over per-trade cap (MUST FAIL)");

  // Same trade, but the fee is redirected to an attacker-controlled account.
  const attacker = Keypair.generate();
  const stolen = [...tradeAccounts];
  stolen[3] = m(attacker.publicKey, false, true);
  await send(connection, [new TransactionInstruction({
    programId: ROUTER, keys: stolen,
    data: Buffer.concat([disc("buy"), u64(1_000_000), u64(0.01 * LAMPORTS_PER_SOL)]),
  })], [agent], "fee redirected to attacker (MUST FAIL)");

  // Same trade, but the CPI is pointed at a program that is not pump.fun.
  const hijack = [...tradeAccounts];
  hijack[4] = m(SystemProgram.programId);
  await send(connection, [new TransactionInstruction({
    programId: ROUTER, keys: hijack,
    data: Buffer.concat([disc("buy"), u64(1_000_000), u64(0.01 * LAMPORTS_PER_SOL)]),
  })], [agent], "CPI target swapped (MUST FAIL)");

  // 0.05 + 0.5 is already reserved against a 0.6 SOL budget, so 0.1 must trip it.
  console.log("\n--- daily budget ---");
  await send(connection, [new TransactionInstruction({
    programId: ROUTER, keys: tradeAccounts,
    data: Buffer.concat([disc("buy"), u64(1_000_000), u64(0.04 * LAMPORTS_PER_SOL)]),
  })], [agent], "0.04 SOL, still inside the budget (must pass)");

  await send(connection, [new TransactionInstruction({
    programId: ROUTER, keys: tradeAccounts,
    data: Buffer.concat([disc("buy"), u64(1_000_000), u64(0.1 * LAMPORTS_PER_SOL)]),
  })], [agent], "0.1 SOL, past the budget (MUST FAIL)");
}

main().catch((e) => { console.error(e); process.exit(1); });
