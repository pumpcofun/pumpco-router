// One-time repair. Config and AgentAuth were written before 5b4ca36 added a
// field to each, so the deployed program cannot deserialize them and every
// instruction fails. This grows both records into the current layout.
//
// The program will not collect the extra rent itself, so the top-ups ride
// ahead of it in the same transaction.
//
//   node scripts/migrate-mainnet.js          <- simulate only
//   node scripts/migrate-mainnet.js --send
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

const ROUTER = new PublicKey("pumpcoEZJNNneH9KjrpBSVCKpADVgJpBbtkGvbtFbuy");
const CLERK = new PublicKey("AYxrFQzbcwZxPUiTq7uxmKSj9vbxEf27fpgAvgh2yUbv");

// The clerk is the only registered agent, so its 50% share is the whole total.
// Its fee rate matches what config already charges, so the repair does not
// quietly change what the router bills.
const TOTAL_REWARD_BPS = 5000;
const AGENT_FEE_BPS = 100;

const NEW_CONFIG_LEN = 132;
const NEW_AGENT_LEN = 71;

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

(async () => {
  const connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(require("os").homedir() + "/.config/solana/id.json", "utf8"))));

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [agentAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), CLERK.toBuffer()], ROUTER);

  const before = {
    config: await connection.getAccountInfo(config),
    agent: await connection.getAccountInfo(agentAuth),
  };
  console.log(`config ${config.toBase58()}  ${before.config.data.length} bytes -> ${NEW_CONFIG_LEN}`);
  console.log(`agent  ${agentAuth.toBase58()}  ${before.agent.data.length} bytes -> ${NEW_AGENT_LEN}`);
  if (before.config.data.length === NEW_CONFIG_LEN && before.agent.data.length === NEW_AGENT_LEN) {
    console.log("\nboth records are already migrated, nothing to do");
    return;
  }

  const short = async (account, len) =>
    Math.max(0, (await connection.getMinimumBalanceForRentExemption(len)) - account.lamports);
  const configShort = await short(before.config, NEW_CONFIG_LEN);
  const agentShort = await short(before.agent, NEW_AGENT_LEN);
  console.log(`\nrent to add: config ${configShort}, agent ${agentShort} lamports`);

  const ixs = [];
  const topUp = (to, lamports) => ixs.push(SystemProgram.transfer({
    fromPubkey: authority.publicKey, toPubkey: to, lamports,
  }));
  if (configShort > 0) topUp(config, configShort);
  if (agentShort > 0) topUp(agentAuth, agentShort);
  ixs.push(new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(CLERK), m(agentAuth, false, true), m(authority.publicKey, true)],
    data: Buffer.concat([disc("migrate"), u64(TOTAL_REWARD_BPS), u16(AGENT_FEE_BPS)]),
  }));

  const tx = new Transaction().add(...ixs);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.error("\nsimulation failed:", JSON.stringify(sim.value.err));
    (sim.value.logs || []).forEach((l) => console.error("  ", l));
    process.exit(1);
  }
  console.log("\nsimulation clean");

  if (!process.argv.includes("--send")) {
    console.log("dry run. pass --send to submit");
    return;
  }

  const sig = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
  console.log(`\nsent: ${sig}`);

  const cfg = (await connection.getAccountInfo(config)).data;
  const agt = (await connection.getAccountInfo(agentAuth)).data;
  console.log(`\nconfig now ${cfg.length} bytes, agent now ${agt.length} bytes`);
  console.log("  config.fee_bps            ", cfg.readUInt16LE(104));
  console.log("  config.max_lamports/trade ", cfg.readBigUInt64LE(106).toString());
  console.log("  config.default_daily_limit", cfg.readBigUInt64LE(114).toString());
  console.log("  config.total_reward_bps   ", cfg.readBigUInt64LE(122).toString());
  console.log("  config.paused             ", cfg[130]);
  console.log("  agent.daily_limit         ", agt.readBigUInt64LE(40).toString());
  console.log("  agent.reward_bps          ", agt.readUInt16LE(64));
  console.log("  agent.fee_bps             ", agt.readUInt16LE(66));
  console.log("  agent.enabled             ", agt[68]);
})().catch((e) => { console.error(e.message); process.exit(1); });
