// One entry point for building a router trade, on either venue.
//
// The account layouts here are not derived from documentation. Each one was
// read off a real mainnet transaction and then confirmed by executing both legs
// on both venues, because the published IDLs are incomplete in ways that fail
// silently: PumpSwap's has no `pool_v2` and no error 6062, and the fee
// recipients live in two different arrays inside the same account, where using
// the wrong one gives an error that names neither.
//
//   const { prep, trade, meta } = await buildTrade({ connection, agent, mint, side, sol });
//
// `prep` creates accounts the venue insists already exist. It rides in its own
// transaction: with the ATA creates and the volume accumulator inline, a buy
// comes to 1237 bytes against a 1232 byte limit.
//
// `trade` is the transaction the signer's policy gate inspects. Keep them
// separate. The gate demands exactly one router trade, so it would reject a
// setup transaction outright, and setup must be built by code the model never
// influences.

const {
  PublicKey, SystemProgram, TransactionInstruction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction,
  createCloseAccountInstruction,
} = require("@solana/spl-token");
const swap = require("@pump-fun/pump-swap-sdk");
const crypto = require("crypto");

const {
  PUMP_PROGRAM, PUMP_AMM_PROGRAM, FEE_PROGRAM, WSOL, ROUTER, routerPdas,
  resolveVenue, first,
} = require("./venue");
const { readLimits, assertWithinBudget, maxBuy } = require("./sizing");

const pk = (s) => new PublicKey(s);

// PumpSwap fixtures. Constant across every pool.
const AMM_GLOBAL_CONFIG = pk("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
const AMM_EVENT_AUTHORITY = pk("GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR");
const AMM_FEE_CONFIG = pk("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
const AMM_GLOBAL_VOL = pk("C2aFPdENg4A2HQsmrd5rTw5TaYBX5Ku887cWjbFKtZpw");

// The bonding curve's equivalent.
const CURVE_GLOBAL = pk("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");

// Where the recipient arrays sit inside each program's global account. Both
// carry two distinct sets and picking the wrong one fails with an error that
// mentions neither offset.
const AMM_PROTOCOL_RECIPIENTS_AT = 57;
const AMM_BUYBACK_RECIPIENTS_AT = 643;
const CURVE_FEE_RECIPIENT_AT = 41;
const CURVE_BUYBACK_RECIPIENTS_AT = 741;
const RECIPIENT_COUNT = 8;

const disc = (n) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const m = (pubkey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0];

const readAt = (buf, offset) => new PublicKey(buf.subarray(offset, offset + 32));
const readArray = (buf, offset) =>
  Array.from({ length: RECIPIENT_COUNT }, (_, i) => readAt(buf, offset + i * 32));
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * Constant-product output for `spend`, less the slippage tolerance. Both venues
 * take an exact output plus a ceiling on what may be spent to get it, so asking
 * for less than the quote is what creates room for the price to move.
 */
function quoteOut(baseReserve, quoteReserve, spend, slippageBps) {
  const expected = (baseReserve * spend) / (quoteReserve + spend);
  return (expected * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** PumpSwap's Pool, read positionally because the SDK's decoder disagrees. */
function decodePool(data) {
  let o = 8;
  o += 1 + 2;                        // bump, index
  o += 32;                           // creator, the pool authority
  const baseMint = readAt(data, o); o += 32;
  const quoteMint = readAt(data, o); o += 32;
  o += 32;                           // lpMint
  const poolBase = readAt(data, o); o += 32;
  const poolQuote = readAt(data, o); o += 32;
  o += 8;                            // lpSupply
  return { baseMint, quoteMint, poolBase, poolQuote, coinCreator: readAt(data, o) };
}

async function buildAmm({ connection, agent, mint, side, lamports, slippageBps, poolAddress }) {
  const poolInfo = await connection.getAccountInfo(poolAddress, "confirmed");
  const p = decodePool(poolInfo.data);
  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  const baseProgram = mintInfo.owner;

  const userBase = getAssociatedTokenAddressSync(mint, agent, true, baseProgram);
  const userQuote = getAssociatedTokenAddressSync(WSOL, agent, true, TOKEN_PROGRAM_ID);
  const userVol = pda(
    [Buffer.from("user_volume_accumulator"), agent.toBuffer()], PUMP_AMM_PROGRAM);

  // The vault's token account is an ATA of the vault *authority*, not of the
  // coin creator. Deriving it from the creator gives an address PumpSwap has
  // never heard of, and it fails with a bare "account missing".
  const creatorVaultAuth = first(swap.coinCreatorVaultAuthorityPda(p.coinCreator));
  const creatorVaultAta = getAssociatedTokenAddressSync(
    WSOL, creatorVaultAuth, true, TOKEN_PROGRAM_ID);

  const gc = (await connection.getAccountInfo(AMM_GLOBAL_CONFIG, "confirmed")).data;
  const feeRecipient = pick(readArray(gc, AMM_PROTOCOL_RECIPIENTS_AT));
  const buyback = pick(readArray(gc, AMM_BUYBACK_RECIPIENTS_AT));

  const [baseBal, quoteBal] = await Promise.all([
    connection.getTokenAccountBalance(p.poolBase),
    connection.getTokenAccountBalance(p.poolQuote),
  ]);
  const bRes = BigInt(baseBal.value.amount);
  const qRes = BigInt(quoteBal.value.amount);

  const keys = [
    m(routerPdas.config()), m(routerPdas.agent(agent), false, true), m(agent, true, true),
    m(await feeVault(connection), false, true), m(PUMP_AMM_PROGRAM),
    m(poolAddress, false, true), m(AMM_GLOBAL_CONFIG), m(mint), m(WSOL),
    m(userBase, false, true), m(userQuote, false, true),
    m(p.poolBase, false, true), m(p.poolQuote, false, true),
    m(feeRecipient),
    m(getAssociatedTokenAddressSync(WSOL, feeRecipient, true, TOKEN_PROGRAM_ID), false, true),
    m(baseProgram), m(TOKEN_PROGRAM_ID), m(ASSOCIATED_TOKEN_PROGRAM_ID),
    m(AMM_EVENT_AUTHORITY),
    m(creatorVaultAta, false, true), m(creatorVaultAuth),
    m(AMM_GLOBAL_VOL), m(userVol, false, true),
    m(AMM_FEE_CONFIG), m(FEE_PROGRAM), m(SystemProgram.programId),
    // pool_v2 goes first among the trailing accounts and usually does not exist
    // on chain. Its position is what matters, not its existence.
    m(first(swap.poolV2Pda(mint))), m(buyback),
    m(getAssociatedTokenAddressSync(WSOL, buyback, true, TOKEN_PROGRAM_ID), false, true),
  ];

  const prep = [];
  if (!(await connection.getAccountInfo(userVol))) {
    prep.push(new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM,
      keys: [m(agent, true, true), m(agent), m(userVol, false, true),
             m(SystemProgram.programId), m(AMM_EVENT_AUTHORITY), m(PUMP_AMM_PROGRAM)],
      data: disc("init_user_volume_accumulator"),
    }));
  }
  if (side === "buy" && !(await connection.getAccountInfo(userBase))) {
    prep.push(createAssociatedTokenAccountIdempotentInstruction(
      agent, userBase, agent, mint, baseProgram));
  }
  if (!(await connection.getAccountInfo(userQuote))) {
    prep.push(createAssociatedTokenAccountIdempotentInstruction(
      agent, userQuote, agent, WSOL, TOKEN_PROGRAM_ID));
  }

  const trade = [];
  let data;
  if (side === "sell") {
    const held = BigInt((await connection.getTokenAccountBalance(userBase)).value.amount);
    if (held === 0n) throw new Error("nothing held to sell");
    data = Buffer.concat([disc("sell_amm"), u64(held), u64(0)]);
  } else {
    // Ask for what the reserves say the money buys, less the slippage
    // tolerance, and let `lamports` be the ceiling. Halving the output instead
    // would spend about half the size asked for while still charging the full
    // ceiling against the daily budget.
    const baseOut = quoteOut(bRes, qRes, lamports, slippageBps);
    data = Buffer.concat([disc("buy_amm"), u64(baseOut), u64(lamports), Buffer.from([0])]);
    // PumpSwap does not wrap for you.
    trade.push(
      SystemProgram.transfer({ fromPubkey: agent, toPubkey: userQuote, lamports: Number(lamports) }),
      createSyncNativeInstruction(userQuote, TOKEN_PROGRAM_ID));
  }

  trade.push(new TransactionInstruction({ programId: ROUTER, keys, data }));
  // Returns unspent slippage and the account rent as native SOL.
  trade.push(createCloseAccountInstruction(userQuote, agent, agent, [], TOKEN_PROGRAM_ID));

  return { prep, trade, meta: { venue: "amm", pool: poolAddress, baseReserve: bRes, quoteReserve: qRes } };
}

async function buildCurve({ connection, agent, mint, side, lamports, slippageBps, bondingCurve }) {
  const ci = await connection.getAccountInfo(bondingCurve, "confirmed");
  const vTokens = ci.data.readBigUInt64LE(8);
  const vSol = ci.data.readBigUInt64LE(16);
  const creator = readAt(ci.data, 49);

  const mintInfo = await connection.getAccountInfo(mint, "confirmed");
  const tokenProgram = mintInfo.owner;

  const g = (await connection.getAccountInfo(CURVE_GLOBAL, "confirmed")).data;
  const feeRecipient = readAt(g, CURVE_FEE_RECIPIENT_AT);
  const buyback = pick(readArray(g, CURVE_BUYBACK_RECIPIENTS_AT));

  const assocCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true, tokenProgram);
  const assocUser = getAssociatedTokenAddressSync(mint, agent, true, tokenProgram);
  const eventAuthority = pda([Buffer.from("__event_authority")], PUMP_PROGRAM);
  const userVol = pda(
    [Buffer.from("user_volume_accumulator"), agent.toBuffer()], PUMP_PROGRAM);

  const keys = [
    m(routerPdas.config()), m(routerPdas.agent(agent), false, true), m(agent, true, true),
    m(await feeVault(connection), false, true), m(PUMP_PROGRAM),
    m(CURVE_GLOBAL), m(feeRecipient, false, true), m(mint),
    m(bondingCurve, false, true), m(assocCurve, false, true),
    m(assocUser, false, true),
    m(pda([Buffer.from("creator-vault"), creator.toBuffer()], PUMP_PROGRAM), false, true),
    m(eventAuthority),
    m(pda([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM)),
    m(userVol, false, true),
    m(pda([Buffer.from("fee_config"), PUMP_PROGRAM.toBuffer()], FEE_PROGRAM)),
    m(FEE_PROGRAM), m(tokenProgram), m(SystemProgram.programId),
    // The curve's answer to pool_v2, and a buyback recipient. Omitting the
    // second fails with BuybackFeeRecipientMissing.
    m(pda([Buffer.from("bonding-curve-v2"), mint.toBuffer()], PUMP_PROGRAM), false, true),
    m(buyback, false, true),
  ];

  const prep = [];
  if (!(await connection.getAccountInfo(userVol))) {
    prep.push(new TransactionInstruction({
      programId: PUMP_PROGRAM,
      keys: [m(agent, true, true), m(agent), m(userVol, false, true),
             m(SystemProgram.programId), m(eventAuthority), m(PUMP_PROGRAM)],
      data: disc("init_user_volume_accumulator"),
    }));
  }
  if (side === "buy" && !(await connection.getAccountInfo(assocUser))) {
    prep.push(createAssociatedTokenAccountIdempotentInstruction(
      agent, assocUser, agent, mint, tokenProgram));
  }

  let data;
  if (side === "sell") {
    const held = BigInt((await connection.getTokenAccountBalance(assocUser)).value.amount);
    if (held === 0n) throw new Error("nothing held to sell");
    data = Buffer.concat([disc("sell"), u64(held), u64(0)]);
  } else {
    const out = quoteOut(vTokens, vSol, lamports, slippageBps);
    data = Buffer.concat([disc("buy"), u64(out), u64(lamports)]);
  }

  // The curve settles in native SOL, so there is nothing to wrap or unwrap.
  return {
    prep,
    trade: [new TransactionInstruction({ programId: ROUTER, keys, data })],
    meta: { venue: "curve", bondingCurve, virtualSol: vSol, creator },
  };
}

let cachedFeeVault = null;
/** Read from config rather than hardcoded, so update_config is honoured. */
async function feeVault(connection) {
  if (cachedFeeVault) return cachedFeeVault;
  const cfg = await connection.getAccountInfo(routerPdas.config(), "confirmed");
  if (!cfg) throw new Error("router config does not exist; run init first");
  cachedFeeVault = readAt(cfg.data, 8 + 32 + 32);
  return cachedFeeVault;
}

/**
 * @param side         "buy" or "sell"
 * @param sol          size of a buy, in SOL. Ignored on a sell, which always
 *                     closes the whole position.
 * @param slippageBps  tolerance on a buy. 100 is 1%, which suits a deep
 *                     graduated pool. A fresh curve wants 500 to 1500: too
 *                     tight and the trade simply fails, which on an exit means
 *                     a stop-loss that never fires.
 * @param sizing       overrides for the balance-relative ceilings in sizing.js.
 *                     A buy is refused before it is built if it breaches them.
 *                     Sells are never refused here: the chain does not bound
 *                     them either, and blocking an exit is the worse failure.
 */
async function buildTrade({ connection, agent, mint, side, sol = 0, slippageBps = 100, sizing = {} }) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`slippageBps out of range: ${slippageBps}`);
  }
  if (side !== "buy" && side !== "sell") throw new Error(`unknown side ${side}`);
  const lamports = BigInt(Math.floor(sol * 1e9));
  if (side === "buy" && lamports <= 0n) throw new Error("a buy needs a positive size");

  if (side === "buy") {
    const limits = await readLimits(connection, agent);
    assertWithinBudget(limits, lamports, sizing);
  }

  const v = await resolveVenue(connection, mint);
  if (v.needsExtend) {
    throw new Error(`${mint.toBase58()}: the venue account needs extend_account first`);
  }

  const built = v.venue === "curve"
    ? await buildCurve({ connection, agent, mint, side, lamports, slippageBps, bondingCurve: v.bondingCurve })
    : await buildAmm({ connection, agent, mint, side, lamports, slippageBps, poolAddress: v.pool });

  // Compute budget belongs on the trade, never on prep, so the gate sees the
  // same shape every time.
  built.trade.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }));
  return built;
}

module.exports = { buildTrade, decodePool, feeVault, quoteOut };
