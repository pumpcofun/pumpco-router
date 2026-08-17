// One-time mainnet setup: write the router config and register the clerk.
// Idempotent by inspection: skips whichever account already exists.
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
const ROUTER = new PublicKey("pumpcoEZJNNneH9KjrpBSVCKpADVgJpBbtkGvbtFbuy");
const FEE_VAULT = new PublicKey("AiQ1omzndapTLihh3xKKFvJzmycHAX6CN6r2YUuynRgA");
const TREASURY = FEE_VAULT;
const CLERK = new PublicKey("AYxrFQzbcwZxPUiTq7uxmKSj9vbxEf27fpgAvgh2yUbv");

// Agreed values. All changeable later with update_config / set_agent.
const FEE_BPS = 100;                                   // 1%
const MAX_PER_TRADE = 0.05 * LAMPORTS_PER_SOL;         // one bad decision
const DEFAULT_DAILY = 0.5 * LAMPORTS_PER_SOL;          // ceiling for self-registration
const CLERK_DAILY = 0.4 * LAMPORTS_PER_SOL;            // one bad day
const CLERK_REWARD_BPS = 5000;                         // half of creator rewards

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const authority = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.FUNDER_KEY || require("os").homedir() + "/.config/solana/id.json", "utf8"))));

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [agentAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), CLERK.toBuffer()], ROUTER);
  const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator")], ROUTER);

  console.log("authority    :", authority.publicKey.toBase58());
  console.log("config       :", config.toBase58());
  console.log("clerk auth   :", agentAuth.toBase58());
  console.log("creator vault:", creatorVault.toBase58());
  console.log("");

  const steps = [
    {
      name: "initialize",
      account: config,
      ix: new TransactionInstruction({
        programId: ROUTER,
        keys: [m(config, false, true), m(authority.publicKey, true, true),
               m(FEE_VAULT), m(TREASURY), m(SystemProgram.programId)],
        data: Buffer.concat([disc("initialize"), u16(FEE_BPS), u64(MAX_PER_TRADE), u64(DEFAULT_DAILY)]),
      }),
    },
    {
      name: "init_creator_vault",
      account: creatorVault,
      ix: new TransactionInstruction({
        programId: ROUTER,
        keys: [m(config), m(authority.publicKey, true, true),
               m(creatorVault, false, true), m(SystemProgram.programId)],
        data: disc("init_creator_vault"),
      }),
    },
    {
      name: "register_agent (clerk)",
      account: agentAuth,
      ix: new TransactionInstruction({
        programId: ROUTER,
        keys: [m(config), m(authority.publicKey, true, true), m(CLERK),
               m(agentAuth, false, true), m(SystemProgram.programId)],
        data: Buffer.concat([disc("register_agent"), u64(CLERK_DAILY), u16(CLERK_REWARD_BPS)]),
      }),
    },
  ];

  for (const step of steps) {
    if (await connection.getAccountInfo(step.account, "confirmed")) {
      console.log(`SKIP ${step.name} (already exists)`);
      continue;
    }
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
      step.ix);
    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" });
      console.log(`OK   ${step.name}`);
      console.log(`     https://solscan.io/tx/${sig}`);
    } catch (e) {
      console.log(`FAIL ${step.name}: ${e.message.split("\n")[0]}`);
      const logs = e.logs || (e.getLogs ? await e.getLogs().catch(() => null) : null);
      if (logs) logs.filter((l) => /Error|failed/.test(l)).slice(-4).forEach((l) => console.log("     |", l.trim()));
      process.exit(1);
    }
  }

  console.log("\nconfig:");
  console.log(`  fee            ${FEE_BPS / 100}%`);
  console.log(`  per trade      ${MAX_PER_TRADE / LAMPORTS_PER_SOL} SOL`);
  console.log(`  clerk daily    ${CLERK_DAILY / LAMPORTS_PER_SOL} SOL`);
  console.log(`  clerk rewards  ${CLERK_REWARD_BPS / 100}% of creator fees`);
  console.log(`  fee vault      ${FEE_VAULT.toBase58()}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
