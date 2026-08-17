// PumpSwap settles in wrapped SOL and does not wrap or unwrap for you.
//
// Confirmed three ways: the IDL only ever touches a WSOL *token account*, the
// official SDK synthesizes the wrap itself, and a sweep of live PumpSwap trades
// shows the program emitting `transferChecked` between existing token accounts
// and never a `syncNative` or `initializeAccount` of its own.
//
// The closing `closeAccount` is not just tidying. It is how unspent slippage
// comes back as native SOL, so it belongs on buys as much as on sells.

const { PublicKey, SystemProgram, TransactionInstruction } = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const { WSOL } = require("./venue");

/** WSOL is always classic SPL Token, even when the base mint is Token-2022. */
function wsolAccount(owner) {
  return getAssociatedTokenAddressSync(WSOL, owner, true, TOKEN_PROGRAM_ID);
}

/**
 * Instructions to run before an AMM trade. `lamports` is how much native SOL to
 * wrap, which is zero for a sell because the pool pays WSOL in.
 */
function wrapInstructions(owner, lamports) {
  const ata = wsolAccount(owner);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, WSOL, TOKEN_PROGRAM_ID),
  ];

  if (lamports > 0n) {
    ixs.push(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
      createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID)
    );
  }

  return ixs;
}

/** Always run after the trade: returns the balance and the rent as native SOL. */
function unwrapInstruction(owner) {
  return createCloseAccountInstruction(wsolAccount(owner), owner, owner, [], TOKEN_PROGRAM_ID);
}

/** The base-mint token account, whose program follows the mint's owner. */
function baseAccount(owner, mint, tokenProgram) {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
}

function createBaseAccountInstruction(owner, mint, tokenProgram) {
  return createAssociatedTokenAccountIdempotentInstruction(
    owner,
    baseAccount(owner, mint, tokenProgram),
    owner,
    mint,
    tokenProgram
  );
}

/**
 * Read the mint's owning program instead of assuming. pump.fun's `create_v2`
 * mints are Token-2022 and the classic assumption silently derives the wrong
 * associated account.
 */
async function tokenProgramOf(connection, mint) {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`mint ${mint.toBase58()} not found`);
  return info.owner;
}

module.exports = {
  wsolAccount,
  wrapInstructions,
  unwrapInstruction,
  baseAccount,
  createBaseAccountInstruction,
  tokenProgramOf,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
};
