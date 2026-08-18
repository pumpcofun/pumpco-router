// The last gate before a signature.
//
// Everything above this is intent parsing and instruction building, and both
// could in principle have a bug. This function looks at the finished
// transaction, instruction by instruction, and refuses to let the key touch
// anything that is not a pumpco trade. It assumes the builder is wrong and
// checks anyway.
//
// The dangerous instruction is a plain SOL transfer, because that is exactly
// what a drain looks like. Wrapping SOL for an AMM trade needs one, so the rule
// is not "no transfers" but "transfers may only fund the signer's own wrapped
// SOL account".

const { PublicKey, SystemProgram } = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} = require("@solana/spl-token");

const ROUTER = new PublicKey("PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp");
const PUMP_AMM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** Anchor discriminators for the four trade instructions, nothing else. */
const crypto = require("crypto");
const discriminator = (name) =>
  crypto.createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const TRADE_DISCRIMINATORS = ["buy", "sell", "buy_amm", "sell_amm"].map(discriminator);

const SYSTEM_TRANSFER = 2;
const TOKEN_SYNC_NATIVE = 17;
const TOKEN_CLOSE_ACCOUNT = 9;

class PolicyError extends Error {}

/**
 * @param instructions TransactionInstruction[] about to be signed
 * @param signer       the agent whose key will sign
 */
function assertOnlyPumpcoTrade(instructions, signer) {
  const ownWsol = getAssociatedTokenAddressSync(WSOL, signer, true, TOKEN_PROGRAM_ID);
  let tradeCount = 0;

  for (const [i, ix] of instructions.entries()) {
    const p = ix.programId;
    const at = `instruction ${i}`;

    if (p.equals(COMPUTE_BUDGET) || p.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) continue;

    if (p.equals(ROUTER)) {
      const disc = Buffer.from(ix.data.subarray(0, 8));
      if (!TRADE_DISCRIMINATORS.some((d) => d.equals(disc))) {
        throw new PolicyError(`${at}: router instruction is not a trade`);
      }
      // The signer must be the agent itself, never a third party.
      const isSigner = ix.keys.some((k) => k.isSigner && k.pubkey.equals(signer));
      if (!isSigner) throw new PolicyError(`${at}: trade does not sign as this agent`);
      tradeCount++;
      continue;
    }

    // Only ever to create the per-user volume accumulator a buy requires.
    if (p.equals(PUMP_AMM)) {
      const disc = Buffer.from(ix.data.subarray(0, 8));
      if (!disc.equals(discriminator("init_user_volume_accumulator"))) {
        throw new PolicyError(`${at}: direct AMM call that is not accumulator init`);
      }
      continue;
    }

    if (p.equals(TOKEN_PROGRAM_ID) || p.equals(TOKEN_2022)) {
      const tag = ix.data[0];
      if (tag !== TOKEN_SYNC_NATIVE && tag !== TOKEN_CLOSE_ACCOUNT) {
        throw new PolicyError(`${at}: token instruction ${tag} is not allowed`);
      }
      // Closing must return the lamports to the agent, not to anyone else.
      if (tag === TOKEN_CLOSE_ACCOUNT) {
        const dest = ix.keys[1]?.pubkey;
        if (!dest || !dest.equals(signer)) {
          throw new PolicyError(`${at}: closeAccount pays out to ${dest?.toBase58()}`);
        }
      }
      continue;
    }

    // This is the drain vector. A transfer is permitted only when it funds the
    // agent's own wrapped SOL account, which is the one legitimate reason a
    // trade needs one.
    if (p.equals(SystemProgram.programId)) {
      const kind = ix.data.readUInt32LE(0);
      if (kind !== SYSTEM_TRANSFER) {
        throw new PolicyError(`${at}: system instruction ${kind} is not allowed`);
      }
      const to = ix.keys[1]?.pubkey;
      if (!to || !to.equals(ownWsol)) {
        throw new PolicyError(
          `${at}: SOL transfer to ${to?.toBase58()}, only the agent's own wSOL account is allowed`
        );
      }
      continue;
    }

    throw new PolicyError(`${at}: program ${p.toBase58()} is not on the allowlist`);
  }

  if (tradeCount !== 1) {
    throw new PolicyError(`expected exactly one router trade, found ${tradeCount}`);
  }
}

module.exports = { assertOnlyPumpcoTrade, PolicyError, ROUTER, PUMP_AMM, WSOL };
