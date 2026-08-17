// Everything the trading tests never touched: creator reward distribution, the
// self-registration path copy trading depends on, and the authority guards.
//
// None of these need pump.fun, so this runs against a bare validator.
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction,
  TransactionInstruction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const crypto = require("crypto");
const fs = require("fs");

const RPC = "http://127.0.0.1:8899";
const ROUTER = new PublicKey("pumpcoEZJNNneH9KjrpBSVCKpADVgJpBbtkGvbtFbuy");

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

let pass = 0, fail = 0;
const ok = (label) => { console.log(`  ok    ${label}`); pass++; };
const bad = (label, why) => { console.log(`  FAIL  ${label}: ${why}`); fail++; };

async function send(connection, ixs, signers) {
  // The local validator stalls issuing blockhashes under a fast burst.
  await new Promise((r) => setTimeout(r, 400));
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs);
  return sendAndConfirmTransaction(connection, tx, signers, { commitment: "confirmed" });
}
async function expectOk(connection, ixs, signers, label) {
  try { await send(connection, ixs, signers); ok(label); return true; }
  catch (e) {
    const logs = e.logs || (e.getLogs ? await e.getLogs().catch(() => null) : null);
    const err = (logs || []).find((l) => /Error Code/.test(l)) || e.message.split("\n")[0];
    bad(label, err); return false;
  }
}
async function expectFail(connection, ixs, signers, label, code) {
  try { await send(connection, ixs, signers); bad(label, "was allowed"); }
  catch (e) {
    const logs = e.logs || (e.getLogs ? await e.getLogs().catch(() => null) : null);
    const line = (logs || []).find((l) => l.includes("Error Code"));
    if (!code || (line && line.includes(code))) ok(`${label} -> ${code || "rejected"}`);
    else bad(label, line || e.message.split("\n")[0]);
  }
}

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const funder = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.FUNDER_KEY, "utf8"))));
  const authority = Keypair.generate();
  const outsider = Keypair.generate();
  const agentA = Keypair.generate();
  const agentB = Keypair.generate();
  const feeVault = Keypair.generate();
  const treasury = Keypair.generate();

  const rent = await connection.getMinimumBalanceForRentExemption(0);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    ...[authority, outsider, agentA, agentB].map((k) =>
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: k.publicKey, lamports: 5 * LAMPORTS_PER_SOL })),
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: feeVault.publicKey, lamports: rent }),
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: treasury.publicKey, lamports: rent })
  ), [funder], { commitment: "confirmed" });

  const [config] = PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER);
  const [creatorVault] = PublicKey.findProgramAddressSync([Buffer.from("creator")], ROUTER);
  const authOf = (w) => PublicKey.findProgramAddressSync([Buffer.from("agent"), w.toBuffer()], ROUTER)[0];

  console.log("\n--- setup ---");
  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true, true),
           m(feeVault.publicKey), m(treasury.publicKey), m(SystemProgram.programId)],
    data: Buffer.concat([disc("initialize"), u16(100), u64(LAMPORTS_PER_SOL), u64(0.5 * LAMPORTS_PER_SOL)]),
  })], [authority], "initialize");

  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config), m(authority.publicKey, true, true), m(creatorVault, false, true), m(SystemProgram.programId)],
    data: disc("init_creator_vault"),
  })], [authority], "init_creator_vault");

  console.log("\n--- authority guards ---");
  await expectFail(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(outsider.publicKey, true, true),
           m(feeVault.publicKey), m(treasury.publicKey)],
    data: Buffer.concat([disc("update_config"), u16(100), u64(LAMPORTS_PER_SOL), u64(LAMPORTS_PER_SOL)]),
  })], [outsider], "outsider updates config", "Unauthorized");

  await expectFail(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true, true),
           m(feeVault.publicKey), m(treasury.publicKey)],
    data: Buffer.concat([disc("update_config"), u16(9999), u64(LAMPORTS_PER_SOL), u64(LAMPORTS_PER_SOL)]),
  })], [authority], "fee above the 3% ceiling", "FeeTooHigh");

  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true, true),
           m(feeVault.publicKey), m(treasury.publicKey)],
    data: Buffer.concat([disc("set_paused"), Buffer.from([1])]),
  })], [authority], "set_paused on");
  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true, true),
           m(feeVault.publicKey), m(treasury.publicKey)],
    data: Buffer.concat([disc("set_paused"), Buffer.from([0])]),
  })], [authority], "set_paused off");

  console.log("\n--- registration ---");
  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true, true), m(agentA.publicKey),
           m(authOf(agentA.publicKey), false, true), m(SystemProgram.programId)],
    data: Buffer.concat([disc("register_agent"), u64(LAMPORTS_PER_SOL), u16(5000), u16(0)]),
  })], [authority], "register_agent A at 50% rewards");

  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config, false, true), m(authority.publicKey, true, true), m(agentB.publicKey),
           m(authOf(agentB.publicKey), false, true), m(SystemProgram.programId)],
    data: Buffer.concat([disc("register_agent"), u64(LAMPORTS_PER_SOL), u16(2500), u16(100)]),
  })], [authority], "register_agent B at 25% rewards");

  // The path copy trading depends on: an outsider registers itself.
  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config), m(outsider.publicKey, true, true),
           m(authOf(outsider.publicKey), false, true), m(SystemProgram.programId)],
    data: Buffer.concat([disc("self_register"), u64(10 * LAMPORTS_PER_SOL)]),
  })], [outsider], "self_register asking for 10 SOL/day");

  const selfAuth = await connection.getAccountInfo(authOf(outsider.publicKey));
  const dailyLimit = selfAuth.data.readBigUInt64LE(8 + 32);
  // disc 8, wallet 32, daily 8, spent 8, day 8, reward_bps 2, fee_bps 2, enabled 1
  const AUTHORITY_MANAGED_OFFSET = 8 + 32 + 8 + 8 + 8 + 2 + 2 + 1;
  const managed = selfAuth.data[AUTHORITY_MANAGED_OFFSET];
  const feeBps = selfAuth.data.readUInt16LE(8 + 32 + 8 + 8 + 8 + 2);
  if (feeBps === 100) ok("  inherited the config fee rate of 1%");
  else bad("fee_bps", `got ${feeBps}`);
  if (dailyLimit === BigInt(0.5 * LAMPORTS_PER_SOL)) ok("  clamped to the 0.5 SOL ceiling");
  else bad("clamp", `got ${Number(dailyLimit) / LAMPORTS_PER_SOL} SOL`);
  if (managed === 0) ok("  marked self managed, not authority managed");
  else bad("authority_managed", "should be false for self registration");

  // A self-registered wallet may raise its own ceiling; a company agent may not.
  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(outsider.publicKey, true, false), m(authOf(outsider.publicKey), false, true)],
    data: Buffer.concat([disc("set_own_limit"), u64(0.2 * LAMPORTS_PER_SOL)]),
  })], [outsider], "self registered wallet sets its own limit");

  await expectFail(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(agentA.publicKey, true, false), m(authOf(agentA.publicKey), false, true)],
    data: Buffer.concat([disc("set_own_limit"), u64(99 * LAMPORTS_PER_SOL)]),
  })], [agentA], "company agent raises its own limit", "AuthorityManaged");

  console.log("\n--- creator rewards, never run before today ---");
  const POT = 1 * LAMPORTS_PER_SOL;
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: creatorVault, lamports: POT })
  ), [funder], { commitment: "confirmed" });
  ok(`pot of ${POT / LAMPORTS_PER_SOL} SOL sent to the creator vault`);

  const before = {
    a: await connection.getBalance(agentA.publicKey),
    b: await connection.getBalance(agentB.publicKey),
    t: await connection.getBalance(treasury.publicKey),
  };

  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [
      m(config), m(creatorVault, false, true), m(treasury.publicKey, false, true),
      // remaining accounts: (agent authority, wallet) pairs
      m(authOf(agentA.publicKey), false, true), m(agentA.publicKey, false, true),
      m(authOf(agentB.publicKey), false, true), m(agentB.publicKey, false, true),
    ],
    data: disc("distribute_rewards"),
  })], [authority], "distribute_rewards (permissionless)");

  const gotA = (await connection.getBalance(agentA.publicKey)) - before.a;
  const gotB = (await connection.getBalance(agentB.publicKey)) - before.b;
  const gotT = (await connection.getBalance(treasury.publicKey)) - before.t;
  const vaultLeft = await connection.getBalance(creatorVault);
  const rentMin = await connection.getMinimumBalanceForRentExemption(9);

  console.log(`    agent A  ${(gotA / LAMPORTS_PER_SOL).toFixed(4)} SOL  (expected 0.5000)`);
  console.log(`    agent B  ${(gotB / LAMPORTS_PER_SOL).toFixed(4)} SOL  (expected 0.2500)`);
  console.log(`    treasury ${(gotT / LAMPORTS_PER_SOL).toFixed(4)} SOL  (expected 0.2500)`);

  if (gotA === POT / 2) ok("  A received exactly 50%"); else bad("A share", gotA);
  if (gotB === POT / 4) ok("  B received exactly 25%"); else bad("B share", gotB);
  if (gotA + gotB + gotT === POT) ok("  every lamport accounted for"); else bad("conservation", gotA + gotB + gotT);
  if (vaultLeft >= rentMin) ok("  vault left rent exempt"); else bad("vault rent", vaultLeft);

  await expectFail(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config), m(creatorVault, false, true), m(treasury.publicKey, false, true)],
    data: disc("distribute_rewards"),
  })], [authority], "distribute again with an empty vault", "NothingToDistribute");

  // The hole: a caller naming nobody used to send the whole pot to treasury.
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: creatorVault, lamports: POT })
  ), [funder], { commitment: "confirmed" });
  await expectFail(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [m(config), m(creatorVault, false, true), m(treasury.publicKey, false, true)],
    data: disc("distribute_rewards"),
  })], [outsider], "distribute naming NO agents", "IncompletePayees");

  await expectFail(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [
      m(config), m(creatorVault, false, true), m(treasury.publicKey, false, true),
      m(authOf(agentA.publicKey), false, true), m(agentA.publicKey, false, true),
      m(authOf(agentA.publicKey), false, true), m(agentA.publicKey, false, true),
    ],
    data: disc("distribute_rewards"),
  })], [outsider], "same agent listed twice", "DuplicatePayee");

  // Someone pairing an authority with the wrong wallet to redirect a payout.
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: creatorVault, lamports: POT })
  ), [funder], { commitment: "confirmed" });
  await expectFail(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [
      m(config), m(creatorVault, false, true), m(treasury.publicKey, false, true),
      m(authOf(agentA.publicKey), false, true), m(outsider.publicKey, false, true),
    ],
    data: disc("distribute_rewards"),
  })], [outsider], "payout redirected to a different wallet", "MalformedPayees");

  // --- unwrapping creator fees that arrived as wrapped SOL -----------------
  // After a mint graduates, pump.fun pays creator fees into a token account
  // rather than as lamports, and distribute_rewards can only move lamports.
  console.log("\nunwrapping wrapped SOL:");

  const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
  const WRAPPED = 0.3 * LAMPORTS_PER_SOL;

  const wsolAccount = Keypair.generate();
  const tokenRent = await connection.getMinimumBalanceForRentExemption(165);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: funder.publicKey,
      newAccountPubkey: wsolAccount.publicKey,
      lamports: tokenRent + WRAPPED,
      space: 165,
      programId: TOKEN_PROGRAM,
    }),
    // InitializeAccount3, so the owner is an argument and no rent sysvar is needed.
    new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      keys: [m(wsolAccount.publicKey, false, true), m(WSOL)],
      data: Buffer.concat([Buffer.from([18]), creatorVault.toBuffer()]),
    }),
    // SyncNative, which is what turns the bare lamports into a wSOL balance.
    new TransactionInstruction({
      programId: TOKEN_PROGRAM,
      keys: [m(wsolAccount.publicKey, false, true)],
      data: Buffer.from([17]),
    }),
  ), [funder, wsolAccount], { commitment: "confirmed" });
  ok(`${WRAPPED / LAMPORTS_PER_SOL} wSOL parked in an account the vault owns`);

  const vaultBefore = await connection.getBalance(creatorVault);
  const unwrapKeys = (tokenProgram) => [
    m(config), m(creatorVault, false, true),
    m(wsolAccount.publicKey, false, true), m(tokenProgram),
  ];

  // A fake token program here would be invoked with the creator PDA signing.
  await expectFail(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: unwrapKeys(outsider.publicKey),
    data: disc("unwrap_creator_fees"),
  })], [outsider], "unwrap through an impostor token program", "WrongProgram");

  // Permissionless on purpose: an outsider signs, and the value can only move
  // into the vault.
  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: unwrapKeys(TOKEN_PROGRAM),
    data: disc("unwrap_creator_fees"),
  })], [outsider], "an outsider unwrapped the vault's wSOL");

  const vaultAfter = await connection.getBalance(creatorVault);
  const gained = vaultAfter - vaultBefore;
  if (gained === WRAPPED + tokenRent) ok("  balance and rent both landed in the vault");
  else bad("unwrap amount", `expected ${WRAPPED + tokenRent}, got ${gained}`);
  if ((await connection.getAccountInfo(wsolAccount.publicKey)) === null) ok("  the token account is gone");
  else bad("close", "the wSOL account still exists");

  // The point of the whole instruction: distribute can now reach that money.
  await expectOk(connection, [new TransactionInstruction({
    programId: ROUTER,
    keys: [
      m(config), m(creatorVault, false, true), m(treasury.publicKey, false, true),
      m(authOf(agentA.publicKey), false, true), m(agentA.publicKey, false, true),
      m(authOf(agentB.publicKey), false, true), m(agentB.publicKey, false, true),
    ],
    data: disc("distribute_rewards"),
  })], [outsider], "  graduated fees then distributed normally");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
