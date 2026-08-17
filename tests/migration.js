// The test whose absence took the router down.
//
// Every other suite creates its accounts fresh with the program under test, so
// none of them can see a record written by an older build. This one deploys the
// old program, writes real accounts with it, upgrades, and then migrates, which
// is the exact sequence mainnet went through.
//
// Run in two phases around an upgrade:
//   node tests/migration.js before   <- old program deployed
//   solana program deploy ...        <- new program
//   node tests/migration.js after
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

const RPC = process.env.RPC || "http://127.0.0.1:8899";
const ROUTER = new PublicKey("pumpcoEZJNNneH9KjrpBSVCKpADVgJpBbtkGvbtFbuy");
const STATE = process.env.MIGRATION_STATE || "./.migration-state.json";

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

let pass = 0, fail = 0;
const ok = (l) => { console.log(`  ok    ${l}`); pass++; };
const bad = (l, why) => { console.log(`  FAIL  ${l}: ${why}`); fail++; };
const eq = (l, got, want) => (String(got) === String(want) ? ok(`${l} = ${got}`) : bad(l, `expected ${want}, got ${got}`));

const OLD_CONFIG_LEN = 124, NEW_CONFIG_LEN = 132;
const OLD_AGENT_LEN = 69, NEW_AGENT_LEN = 71;

// What the records are set to before the upgrade, and must still say after.
const FEE_BPS = 100;
const MAX_PER_TRADE = 0.05 * LAMPORTS_PER_SOL;
const DEFAULT_DAILY = 0.5 * LAMPORTS_PER_SOL;
const AGENT_DAILY = 0.4 * LAMPORTS_PER_SOL;
const AGENT_REWARD_BPS = 5000;
// Supplied to the migration, so they should appear only afterwards.
const TOTAL_REWARD_BPS = 5000;
const AGENT_FEE_BPS = 100;

const send = (connection, ixs, signers) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

async function before(connection) {
  const funder = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.FUNDER_KEY, "utf8"))));
  const authority = Keypair.generate();
  const agent = Keypair.generate();
  const feeVault = Keypair.generate();
  const treasury = Keypair.generate();

  const rentMin = await connection.getMinimumBalanceForRentExemption(0);
  await send(connection, [
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: authority.publicKey, lamports: 5 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: feeVault.publicKey, lamports: rentMin }),
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: treasury.publicKey, lamports: rentMin }),
  ], [funder]);

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [agentAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), agent.publicKey.toBuffer()], ROUTER);

  console.log("writing records with the OLD program:");
  await send(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true, true),
           m(feeVault.publicKey), m(treasury.publicKey), m(SystemProgram.programId)],
    data: Buffer.concat([disc("initialize"), u16(FEE_BPS), u64(MAX_PER_TRADE), u64(DEFAULT_DAILY)]),
  })], [authority]);
  ok("initialize");

  await send(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config), m(authority.publicKey, true, true), m(agent.publicKey),
           m(agentAuth, false, true), m(SystemProgram.programId)],
    data: Buffer.concat([disc("register_agent"), u64(AGENT_DAILY), u16(AGENT_REWARD_BPS)]),
  })], [authority]);
  ok("register_agent");

  eq("config length", (await connection.getAccountInfo(config)).data.length, OLD_CONFIG_LEN);
  eq("agent length", (await connection.getAccountInfo(agentAuth)).data.length, OLD_AGENT_LEN);

  fs.writeFileSync(STATE, JSON.stringify({
    authority: Array.from(authority.secretKey),
    funder: Array.from(funder.secretKey),
    agentWallet: agent.publicKey.toBase58(),
  }));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

async function after(connection) {
  const s = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const authority = Keypair.fromSecretKey(Uint8Array.from(s.authority));
  const funder = Keypair.fromSecretKey(Uint8Array.from(s.funder));
  const wallet = new PublicKey(s.agentWallet);
  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [agentAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), wallet.toBuffer()], ROUTER);

  // The whole point: the new program cannot read the old records.
  const probe = new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true),
           m(authority.publicKey), m(authority.publicKey)],
    data: Buffer.concat([disc("set_paused"), Buffer.from([1])]),
  });
  try {
    await send(connection, [probe], [authority]);
    bad("old records are unreadable before migrating", "an instruction succeeded");
  } catch (e) {
    const logs = (e.logs || []).join(" ");
    if (/AccountDidNotDeserialize/.test(logs)) ok("old records are unreadable before migrating");
    else bad("unreadable check", logs.slice(0, 120) || e.message);
  }

  const migrateIx = new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(wallet), m(agentAuth, false, true), m(authority.publicKey, true)],
    data: Buffer.concat([disc("migrate"), u64(TOTAL_REWARD_BPS), u16(AGENT_FEE_BPS)]),
  });

  // Without the rent top-up it must refuse rather than leave the account short.
  try {
    await send(connection, [migrateIx], [authority]);
    bad("migrate without extra rent", "it succeeded");
  } catch (e) {
    const logs = (e.logs || []).join(" ");
    if (/NotRentExempt/.test(logs)) ok("migrate without extra rent -> NotRentExempt");
    else bad("rent guard", logs.slice(0, 160) || e.message);
  }

  const topUp = (to, lamports) =>
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: to, lamports });
  const rentFor = async (n) => connection.getMinimumBalanceForRentExemption(n);
  const configShort = (await rentFor(NEW_CONFIG_LEN)) - (await connection.getBalance(config));
  const agentShort = (await rentFor(NEW_AGENT_LEN)) - (await connection.getBalance(agentAuth));

  // An outsider must not be able to migrate, even paying for it themselves.
  const outsider = Keypair.generate();
  await send(connection, [topUp(outsider.publicKey, LAMPORTS_PER_SOL)], [funder]);
  try {
    await send(connection, [new TransactionInstruction({
      ...migrateIx,
      keys: [m(config, false, true), m(wallet), m(agentAuth, false, true), m(outsider.publicKey, true)],
    })], [outsider]);
    bad("outsider migrates", "it succeeded");
  } catch (e) {
    const logs = (e.logs || []).join(" ");
    if (/Unauthorized/.test(logs)) ok("an outsider migrating -> Unauthorized");
    else bad("authority guard", logs.slice(0, 160) || e.message);
  }

  await send(connection, [
    topUp(config, configShort), topUp(agentAuth, agentShort), migrateIx,
  ], [funder, authority]);
  ok("migrate");

  const cfg = (await connection.getAccountInfo(config)).data;
  const agt = (await connection.getAccountInfo(agentAuth)).data;
  eq("config length", cfg.length, NEW_CONFIG_LEN);
  eq("agent length", agt.length, NEW_AGENT_LEN);

  console.log("\n  fields that existed before must be unchanged:");
  eq("  config.authority", new PublicKey(cfg.subarray(8, 40)).toBase58(), authority.publicKey.toBase58());
  eq("  config.fee_bps", cfg.readUInt16LE(104), FEE_BPS);
  eq("  config.max_lamports_per_trade", cfg.readBigUInt64LE(106), MAX_PER_TRADE);
  eq("  config.default_daily_limit", cfg.readBigUInt64LE(114), DEFAULT_DAILY);
  eq("  config.paused", cfg[130], 0);
  eq("  agent.wallet", new PublicKey(agt.subarray(8, 40)).toBase58(), wallet.toBase58());
  eq("  agent.daily_limit", agt.readBigUInt64LE(40), AGENT_DAILY);
  eq("  agent.reward_bps", agt.readUInt16LE(64), AGENT_REWARD_BPS);
  eq("  agent.enabled", agt[68], 1);
  eq("  agent.authority_managed", agt[69], 1);

  console.log("\n  fields the migration introduced:");
  eq("  config.total_reward_bps", cfg.readBigUInt64LE(122), TOTAL_REWARD_BPS);
  eq("  agent.fee_bps", agt.readUInt16LE(66), AGENT_FEE_BPS);

  // The bumps have to survive, or every seeded lookup breaks afterwards.
  const [, configBump] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [, agentBump] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), wallet.toBuffer()], ROUTER);
  eq("  config.bump", cfg[131], configBump);
  eq("  agent.bump", agt[70], agentBump);

  console.log("\n  the program works again:");
  await send(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true),
           m(authority.publicKey), m(authority.publicKey)],
    data: Buffer.concat([disc("set_paused"), Buffer.from([1])]),
  })], [authority]);
  ok("set_paused, which reads Config, now succeeds");

  try {
    await send(connection, [migrateIx], [authority]);
    bad("migrate twice", "it succeeded");
  } catch (e) {
    const logs = (e.logs || []).join(" ");
    if (/AlreadyMigrated/.test(logs)) ok("migrating again -> AlreadyMigrated");
    else bad("idempotency", logs.slice(0, 160) || e.message);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

(async () => {
  const connection = new Connection(RPC, "confirmed");
  const phase = process.argv[2];
  if (phase === "before") return before(connection);
  if (phase === "after") return after(connection);
  console.error("usage: migration.js before|after");
  process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
