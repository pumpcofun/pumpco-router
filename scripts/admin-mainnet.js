// Drive the admin instructions on mainnet, one subcommand at a time, so the
// sequence is visible in the shell rather than buried in a script that pauses
// the router and then dies holding the switch.
//
//   node scripts/admin-mainnet.js read
//   node scripts/admin-mainnet.js pause on|off
//   node scripts/admin-mainnet.js fee <bps>            config fee, via update_config
//   node scripts/admin-mainnet.js agent-fee <bps>      the clerk's own rate
//   node scripts/admin-mainnet.js guards               simulation only, free
//   node scripts/admin-mainnet.js rotate-noop          set_authority to itself
require("dotenv").config({ path: __dirname + "/../.env", quiet: true });
const {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

const RPC = process.env.SOLANA_RPC_URL;
const pk = (s) => new PublicKey(s);
const ROUTER = pk("PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp");
const VAULT = pk("AyxFYhVncAVRM6fHQsoQUyJmUCRtNAuk5UnzVm6anB4x");
const CLERK = pk("CLeRK5GLfvRN6QeTv9Wi3Ma76SDeTpQB8ZXuoEvpnS6d");

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
const [clerkAuth] = PublicKey.findProgramAddressSync(
  [Buffer.from("agent"), CLERK.toBuffer()], ROUTER);

const authority = () => Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(process.env.FUNDER_KEY, "utf8"))));

async function readState(c) {
  const cfg = (await c.getAccountInfo(config)).data;
  const agt = (await c.getAccountInfo(clerkAuth)).data;
  return {
    feeBps: cfg.readUInt16LE(104),
    maxPerTrade: Number(cfg.readBigUInt64LE(106)),
    defaultDaily: Number(cfg.readBigUInt64LE(114)),
    totalRewardBps: Number(cfg.readBigUInt64LE(122)),
    paused: cfg[130] === 1,
    agentDaily: Number(agt.readBigUInt64LE(40)),
    agentSpent: Number(agt.readBigUInt64LE(48)),
    agentRewardBps: agt.readUInt16LE(64),
    agentFeeBps: agt.readUInt16LE(66),
    enabled: agt[68] === 1,
    managed: agt[69] === 1,
  };
}

const send = async (c, kp, ix, label) => {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ix);
  const sig = await sendAndConfirmTransaction(c, tx, [kp], { commitment: "confirmed" });
  console.log(`  ${label}\n     ${sig}`);
  return sig;
};

(async () => {
  const c = new Connection(RPC, "confirmed");
  const cmd = process.argv[2];
  const arg = process.argv[3];

  if (cmd === "read") {
    const s = await readState(c);
    console.log("config  fee", s.feeBps, "bps | cap", (s.maxPerTrade / LAMPORTS_PER_SOL).toFixed(3),
      "SOL | default daily", (s.defaultDaily / LAMPORTS_PER_SOL).toFixed(3),
      "SOL | total_reward", s.totalRewardBps, "| paused", s.paused);
    console.log("clerk   daily", (s.agentDaily / LAMPORTS_PER_SOL).toFixed(3),
      "SOL | spent today", (s.agentSpent / LAMPORTS_PER_SOL).toFixed(6),
      "SOL | reward", s.agentRewardBps, "bps | fee", s.agentFeeBps,
      "bps | enabled", s.enabled, "| authority_managed", s.managed);
    console.log("fee vault", ((await c.getBalance(VAULT)) / LAMPORTS_PER_SOL).toFixed(9), "SOL");
    return;
  }

  if (cmd === "pause") {
    const on = arg === "on";
    await send(c, authority(), new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config, false, true), m(authority().publicKey, true), m(VAULT), m(VAULT)],
      data: Buffer.concat([disc("set_paused"), Buffer.from([on ? 1 : 0])]),
    }), `set_paused ${on}`);
    console.log("     paused is now", (await readState(c)).paused);
    return;
  }

  if (cmd === "fee") {
    const s = await readState(c);
    await send(c, authority(), new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config, false, true), m(authority().publicKey, true), m(VAULT), m(VAULT)],
      data: Buffer.concat([disc("update_config"), u16(Number(arg)),
                           u64(s.maxPerTrade), u64(s.defaultDaily)]),
    }), `update_config fee -> ${arg} bps`);
    console.log("     config fee is now", (await readState(c)).feeBps, "bps");
    return;
  }

  if (cmd === "agent-fee") {
    const s = await readState(c);
    await send(c, authority(), new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config, false, true), m(authority().publicKey, true), m(clerkAuth, false, true)],
      data: Buffer.concat([disc("set_agent"), Buffer.from([s.enabled ? 1 : 0]),
                           u64(s.agentDaily), u16(s.agentRewardBps), u16(Number(arg))]),
    }), `set_agent clerk fee -> ${arg} bps`);
    const after = await readState(c);
    console.log("     clerk fee is now", after.agentFeeBps, "bps | reward still",
      after.agentRewardBps, "| total_reward still", after.totalRewardBps);
    return;
  }

  if (cmd === "rotate-noop") {
    const a = authority();
    await send(c, a, new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config, false, true), m(a.publicKey, true), m(a.publicKey)],
      data: disc("set_authority"),
    }), "set_authority to the same key");
    const cfg = (await c.getAccountInfo(config)).data;
    console.log("     authority is still", new PublicKey(cfg.subarray(8, 40)).toBase58());
    return;
  }

  if (cmd === "guards") {
    let pass = 0, fail = 0;
    const expect = async (label, ix, signer, pattern) => {
      const tx = new Transaction().add(ix);
      tx.feePayer = signer.publicKey;
      tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
      const r = await c.simulateTransaction(tx);
      const logs = (r.value.logs || []).join(" ");
      if (!r.value.err) { console.log(`  FAIL  ${label}: simulated clean`); fail++; return; }
      if (new RegExp(pattern).test(logs)) { console.log(`  ok    ${label} -> ${pattern}`); pass++; return; }
      const first = (r.value.logs || []).filter((l) => /Error/.test(l))[0] || JSON.stringify(r.value.err);
      console.log(`  FAIL  ${label}: got ${first.slice(0, 110)}`); fail++;
    };
    const clerk = Keypair.fromSecretKey(Uint8Array.from(
      JSON.parse(fs.readFileSync(process.env.CLERK_KEY, "utf8"))));
    const outsider = clerk;
    const s = await readState(c);

    // an authority-managed machine may not raise its own ceiling
    await expect("clerk raising its own limit", new TransactionInstruction({
      programId: ROUTER,
      keys: [m(clerk.publicKey, true), m(clerkAuth, false, true)],
      data: Buffer.concat([disc("set_own_limit"), u64(10 * LAMPORTS_PER_SOL)]),
    }), clerk, "AuthorityManaged");

    // only the authority may touch config
    await expect("outsider calling update_config", new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config, false, true), m(outsider.publicKey, true), m(VAULT), m(VAULT)],
      data: Buffer.concat([disc("update_config"), u16(0), u64(s.maxPerTrade), u64(s.defaultDaily)]),
    }), outsider, "Unauthorized|ConstraintHasOne");

    // the fee ceiling is enforced, not advisory
    await expect("config fee above the 3% ceiling", new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config, false, true), m(authority().publicKey, true), m(VAULT), m(VAULT)],
      data: Buffer.concat([disc("update_config"), u16(400), u64(s.maxPerTrade), u64(s.defaultDaily)]),
    }), authority(), "FeeTooHigh");

    // an agent fee above the ceiling is refused too
    await expect("agent fee above the 3% ceiling", new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config, false, true), m(authority().publicKey, true), m(clerkAuth, false, true)],
      data: Buffer.concat([disc("set_agent"), Buffer.from([1]), u64(s.agentDaily), u16(s.agentRewardBps), u16(400)]),
    }), authority(), "FeeTooHigh");

    // a reward share over 100% cannot be granted
    await expect("agent reward share above 100%", new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config, false, true), m(authority().publicKey, true), m(clerkAuth, false, true)],
      data: Buffer.concat([disc("set_agent"), Buffer.from([1]), u64(s.agentDaily), u16(10001), u16(0)]),
    }), authority(), "RewardSharesTooHigh");

    // distribute naming nobody must not drain to the treasury
    await expect("distribute naming no agents", new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config), m(PublicKey.findProgramAddressSync([Buffer.from("creator")], ROUTER)[0], false, true),
             m(VAULT, false, true)],
      data: disc("distribute_rewards"),
    }), clerk, "IncompletePayees|NothingToDistribute");

    console.log(`\n  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }

  console.error("unknown command");
  process.exit(1);
})().catch((e) => { console.error(e.message); process.exit(1); });
