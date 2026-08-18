// Which venue a mint trades on, and the accounts each one needs.
//
// Derivations come from the official SDKs rather than being hand written. The
// pool seed in particular is widely documented wrong: several guides say it is
// keyed on the token creator. It is keyed on the pool-authority PDA. Verified
// against mainnet: mint 7LSsEoJG…pump resolves to pool GseMAnND…d77J, which
// exists and is owned by PumpSwap.

const { PublicKey } = require("@solana/web3.js");
const pump = require("@pump-fun/pump-sdk");
const swap = require("@pump-fun/pump-swap-sdk");

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_AMM_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const ROUTER = new PublicKey("PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp");

/** Anchor account sizes below these need an `extend_account` before trading. */
const BONDING_CURVE_MIN_SIZE = 150;
const POOL_MIN_SIZE = 300;

const first = (v) => (Array.isArray(v) ? v[0] : v);

const routerPdas = {
  config: () => PublicKey.findProgramAddressSync([Buffer.from("config")], ROUTER)[0],
  creator: () => PublicKey.findProgramAddressSync([Buffer.from("creator")], ROUTER)[0],
  agent: (wallet) =>
    PublicKey.findProgramAddressSync([Buffer.from("agent"), wallet.toBuffer()], ROUTER)[0],
};

/**
 * A mint is on the curve until `complete` flips, then on PumpSwap. Migration is
 * permissionless, so there is a window where the curve is complete but the pool
 * does not exist yet. Check for the pool rather than assuming it followed.
 */
async function resolveVenue(connection, mint) {
  const bondingCurve = first(pump.bondingCurvePda(mint));
  const info = await connection.getAccountInfo(bondingCurve, "confirmed");

  if (info) {
    // `complete` sits after the five u64 reserve fields.
    const complete = info.data[8 + 8 * 5] === 1;
    if (!complete) {
      return {
        venue: "curve",
        bondingCurve,
        needsExtend: info.data.length < BONDING_CURVE_MIN_SIZE,
      };
    }
  }

  const pool = first(swap.canonicalPumpPoolPda(mint));
  const poolInfo = await connection.getAccountInfo(pool, "confirmed");
  if (!poolInfo) {
    throw new Error(
      `${mint.toBase58()} has left the curve but its pool does not exist yet. ` +
        `Migration is permissionless and has not been called.`
    );
  }

  return {
    venue: "amm",
    pool,
    needsExtend: poolInfo.data.length < POOL_MIN_SIZE,
  };
}

module.exports = {
  PUMP_PROGRAM,
  PUMP_AMM_PROGRAM,
  FEE_PROGRAM,
  WSOL,
  ROUTER,
  BONDING_CURVE_MIN_SIZE,
  POOL_MIN_SIZE,
  routerPdas,
  resolveVenue,
  first,
};
