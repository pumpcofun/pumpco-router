// Prove the creator reward path on mainnet, end to end, before the token exists.
//
// After graduation pump.fun pays creator fees as wrapped SOL into a token
// account owned by the creator. Nothing in this repo had ever seen that happen
// with real money, because no token names our creator PDA yet. So this stages
// it: park wrapped SOL in the vault's own token account exactly as pump.fun
// would, then run the two instructions that are supposed to turn it into agent
// funding.
//
// The money does not leave the system. It ends up split between the clerk and
// the treasury, both ours, so the only real cost is transaction fees.
//
// Usage: node scripts/creator-path-mainnet.js [--send]
require("dotenv").config({ path: __dirname + "/../.env", quiet: true });
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
} = require("@solana/spl-token");
const crypto = require("crypto");
const fs = require("fs");

const RPC = process.env.SOLANA_RPC_URL;
const pk = (s) => new PublicKey(s);
const ROUTER = pk("PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp");
const WSOL = pk("So11111111111111111111111111111111111111112");
const TREASURY = pk("AyxFYhVncAVRM6fHQsoQUyJmUCRtNAuk5UnzVm6anB4x");
const CLERK = pk("CLeRK5GLfvRN6QeTv9Wi3Ma76SDeTpQB8ZXuoEvpnS6d");

const STAGE = 0.005 * LAMPORTS_PER_SOL;

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const sol = (n) => (n / LAMPORTS_PER_SOL).toFixed(9);

(async () => {
  const doSend = process.argv.includes("--send");
  const connection = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.CLERK_KEY, "utf8"))));

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [vault] = PublicKey.findProgramAddressSync([Buffer.from("creator")], ROUTER);
  const [clerkAuth] = PublicKey.findProgramAddressSync(
    [Buffer.from("agent"), CLERK.toBuffer()], ROUTER);
  // The vault's own wrapped SOL account: an ATA of a PDA, so off curve.
  const vaultWsol = getAssociatedTokenAddressSync(WSOL, vault, true, TOKEN_PROGRAM_ID);

  console.log("creator vault :", vault.toBase58());
  console.log("its wSOL ata  :", vaultWsol.toBase58());
  console.log("clerk         :", CLERK.toBase58());
  console.log("treasury      :", TREASURY.toBase58(), "\n");

  const bal = async (a) => connection.getBalance(a);
  const before = {
    vault: await bal(vault), clerk: await bal(CLERK), treasury: await bal(TREASURY),
  };
  console.log("before  vault", sol(before.vault), "| clerk", sol(before.clerk), "| treasury", sol(before.treasury));

  if (!doSend) { console.log("\ndry run. pass --send to stage and sweep"); return; }

  // --- 1. stage wrapped SOL in the vault's token account, as pump.fun would
  const stageTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey, vaultWsol, vault, WSOL, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vaultWsol, lamports: STAGE }),
    createSyncNativeInstruction(vaultWsol, TOKEN_PROGRAM_ID));
  const s1 = await sendAndConfirmTransaction(connection, stageTx, [payer], { commitment: "confirmed" });
  const staged = (await connection.getTokenAccountBalance(vaultWsol)).value.amount;
  console.log(`\nstaged        : ${sol(Number(staged))} wSOL in the vault's token account`);
  console.log("  ", s1);

  // --- 2. unwrap: permissionless, and can only land in the vault
  const unwrapTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
    new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config), m(vault, false, true), m(vaultWsol, false, true), m(TOKEN_PROGRAM_ID)],
      data: disc("unwrap_creator_fees"),
    }));
  const s2 = await sendAndConfirmTransaction(connection, unwrapTx, [payer], { commitment: "confirmed" });
  const afterUnwrap = await bal(vault);
  console.log(`\nunwrapped     : vault ${sol(before.vault)} -> ${sol(afterUnwrap)}`);
  console.log("  ", s2);
  const gone = await connection.getAccountInfo(vaultWsol);
  console.log("  token account closed:", gone === null);

  // --- 3. distribute: the clerk holds the only reward share, 5000 bps
  const distTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
    new TransactionInstruction({
      programId: ROUTER,
      keys: [m(config), m(vault, false, true), m(TREASURY, false, true),
             m(clerkAuth, false, true), m(CLERK, false, true)],
      data: disc("distribute_rewards"),
    }));
  const s3 = await sendAndConfirmTransaction(connection, distTx, [payer], { commitment: "confirmed" });
  const after = {
    vault: await bal(vault), clerk: await bal(CLERK), treasury: await bal(TREASURY),
  };
  console.log(`\ndistributed   :`);
  console.log("  ", s3);
  console.log("   vault    ", sol(afterUnwrap), "->", sol(after.vault));
  console.log("   clerk    +", sol(after.clerk - before.clerk), "(net of fees it paid)");
  console.log("   treasury +", sol(after.treasury - before.treasury));

  const rent = await connection.getMinimumBalanceForRentExemption(9);
  console.log("\n   vault left rent exempt:", after.vault >= rent, `(needs ${sol(rent)})`);
  const distributed = afterUnwrap - after.vault;
  const toTreasury = after.treasury - before.treasury;
  console.log("   moved out of vault :", sol(distributed));
  console.log("   treasury share     :", sol(toTreasury),
    `= ${((toTreasury / distributed) * 100).toFixed(2)}% (expected 50.00%)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
