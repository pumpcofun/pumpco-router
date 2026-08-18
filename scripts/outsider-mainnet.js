// The path where somebody who is not us uses the router.
//
// Everything else on mainnet has been driven by the authority or by a machine
// the authority registered. This registers a wallet that the authority has never
// touched, and checks the three things that are supposed to be different about
// it: the daily limit is clamped rather than granted, the fee rate is inherited
// from config rather than discounted, and it may raise its own ceiling because
// nobody else manages it.
//
// Usage: node scripts/outsider-mainnet.js <keyfile> [--send]
require("dotenv").config({ path: __dirname + "/../.env", quiet: true });
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

const RPC = process.env.SOLANA_RPC_URL;
const ROUTER = new PublicKey("PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp");

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

let pass = 0, fail = 0;
const eq = (l, got, want) => (String(got) === String(want)
  ? (console.log(`  ok    ${l} = ${got}`), pass++)
  : (console.log(`  FAIL  ${l}: expected ${want}, got ${got}`), fail++));

(async () => {
  const doSend = process.argv.includes("--send");
  const keyfile = process.argv[2];
  const c = new Connection(RPC, "confirmed");
  const outsider = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keyfile, "utf8"))));

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [agentAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), outsider.publicKey.toBuffer()], ROUTER);
  const cfg = (await c.getAccountInfo(config)).data;
  const configFee = cfg.readUInt16LE(104);
  const defaultDaily = Number(cfg.readBigUInt64LE(114));
  const totalRewardBefore = Number(cfg.readBigUInt64LE(122));

  console.log("outsider    :", outsider.publicKey.toBase58());
  console.log("its agent   :", agentAuth.toBase58());
  console.log("balance     :", ((await c.getBalance(outsider.publicKey)) / LAMPORTS_PER_SOL).toFixed(9), "SOL");
  console.log("config fee  :", configFee, "bps | default daily",
    (defaultDaily / LAMPORTS_PER_SOL).toFixed(3), "SOL\n");

  if (!doSend) { console.log("dry run. pass --send"); return; }

  // Ask for twenty times the ceiling, on purpose.
  const ASKED = 10 * LAMPORTS_PER_SOL;
  if (!(await c.getAccountInfo(agentAuth))) {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
      new TransactionInstruction({
        programId: ROUTER,
        keys: [m(config), m(outsider.publicKey, true, true), m(agentAuth, false, true),
               m(SystemProgram.programId)],
        data: Buffer.concat([disc("self_register"), u64(ASKED)]),
      }));
    console.log("self_register asking for 10 SOL/day");
    console.log("  ", await sendAndConfirmTransaction(c, tx, [outsider], { commitment: "confirmed" }), "\n");
  } else {
    console.log("already registered\n");
  }

  const a = (await c.getAccountInfo(agentAuth)).data;
  eq("wallet", new PublicKey(a.subarray(8, 40)).toBase58(), outsider.publicKey.toBase58());
  eq("daily_limit clamped to the ceiling", a.readBigUInt64LE(40).toString(), String(defaultDaily));
  eq("reward_bps, granted to nobody by default", a.readUInt16LE(64), 0);
  eq("fee_bps inherited from config", a.readUInt16LE(66), configFee);
  eq("enabled", a[68], 1);
  eq("authority_managed is false, it manages itself", a[69], 0);

  const cfgAfter = (await c.getAccountInfo(config)).data;
  eq("config.total_reward_bps unchanged", Number(cfgAfter.readBigUInt64LE(122)), totalRewardBefore);

  // It manages itself, so this must work where the clerk is refused.
  const LOWER = 0.1 * LAMPORTS_PER_SOL;
  const tx2 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
    new TransactionInstruction({
      programId: ROUTER,
      keys: [m(outsider.publicKey, true), m(agentAuth, false, true)],
      data: Buffer.concat([disc("set_own_limit"), u64(LOWER)]),
    }));
  console.log("\nset_own_limit to 0.1 SOL");
  console.log("  ", await sendAndConfirmTransaction(c, tx2, [outsider], { commitment: "confirmed" }));
  const a2 = (await c.getAccountInfo(agentAuth)).data;
  eq("daily_limit it set for itself", a2.readBigUInt64LE(40).toString(), String(LOWER));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(1); });
