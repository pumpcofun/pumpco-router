// One CLI over `client/trade.js`, for either venue.
//
// Replaces trade-mainnet.js and trade-curve-mainnet.js, which each carried their
// own copy of the account derivation. Two copies of that is two things to keep
// correct, and the layouts are the part of this codebase most likely to bite.
//
// Every trade goes through the same signer policy gate the automated loop will
// use, so running this by hand exercises the real path rather than a shortcut.
//
//   node scripts/trade.js buy  <mint> <sol> [--send]
//   node scripts/trade.js sell <mint> [--send]
require("dotenv").config({ path: __dirname + "/../.env", quiet: true });
const {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const fs = require("fs");
const { buildTrade } = require("../client/trade");
const { assertOnlyPumpcoTrade } = require("../signer/policy");

(async () => {
  const side = process.argv[2] === "sell" ? "sell" : "buy";
  const mint = new PublicKey(process.argv[3]);
  const sol = parseFloat(process.argv[4]) || 0.006;
  const doSend = process.argv.includes("--send");

  const connection = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
  const agent = Keypair.fromSecretKey(Uint8Array.from(
    JSON.parse(fs.readFileSync(process.env.CLERK_KEY, "utf8"))));

  const { prep, trade, meta } = await buildTrade({
    connection, agent: agent.publicKey, mint, side, sol,
  });

  console.log("agent   :", agent.publicKey.toBase58());
  console.log("mint    :", mint.toBase58());
  console.log("venue   :", meta.venue);
  console.log("side    :", side, side === "buy" ? `${sol} SOL` : "(whole position)");
  const before = await connection.getBalance(agent.publicKey);
  console.log("balance :", (before / LAMPORTS_PER_SOL).toFixed(9), "SOL");

  // The gate assumes the builder is wrong and checks anyway. Setup is exempt
  // because it carries no trade, and is built by code the model cannot reach.
  assertOnlyPumpcoTrade(trade, agent.publicKey);
  console.log("\npolicy  : accepted");

  if (prep.length && !doSend) {
    console.log(`setup   : ${prep.length} instruction(s) needed first; rerun with --send`);
    return;
  }
  if (prep.length) {
    const sig = await sendAndConfirmTransaction(
      connection, new Transaction().add(...prep), [agent], { commitment: "confirmed" });
    console.log("setup   :", sig);
  }

  const tx = new Transaction().add(...trade);
  tx.feePayer = agent.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    console.error("\nsimulation failed:", JSON.stringify(sim.value.err));
    (sim.value.logs || []).slice(-12).forEach((l) => console.error("  ", l));
    process.exit(1);
  }
  console.log("sim     : ok,", sim.value.unitsConsumed, "compute units");
  if (!doSend) { console.log("\ndry run. pass --send to submit"); return; }

  const sig = await sendAndConfirmTransaction(connection, tx, [agent], { commitment: "confirmed" });
  const after = await connection.getBalance(agent.publicKey);
  console.log("\nSENT");
  console.log(`https://solscan.io/tx/${sig}`);
  console.log("delta   :", ((after - before) / LAMPORTS_PER_SOL).toFixed(9), "SOL");
})().catch((e) => { console.error(e.message); process.exit(1); });
