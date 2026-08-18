// How large a trade is allowed to be, as a share of what the agent actually
// holds rather than a number written down once.
//
// The on-chain cap is absolute: 0.05 SOL, set at initialize. That was fine when
// the clerk was funded by hand and its balance barely moved. Once creator
// rewards start arriving the balance changes on its own, and a fixed cap drifts
// from meaning "a small bet" to meaning "most of the wallet", or the reverse.
//
// This lives off chain deliberately. A relative cap is money management, not a
// security control: the chain's absolute cap already bounds a poisoned agent to
// 0.05 SOL whatever this file believes. Putting it here costs nothing and can be
// tuned without an upgrade, where the on-chain version needs a program account
// extension, a buffer, and a migration.
//
// It fails safe in the direction that matters. As the balance falls the cap
// falls with it on the next trade, so a losing run shrinks its own position size
// instead of compounding at a size the wallet can no longer carry.

const { PublicKey } = require("@solana/web3.js");
const { routerPdas } = require("./venue");

/** Every source converges on 1-2% of the stack per position. */
const DEFAULT_TRADE_BPS = 200;
/** A day's worth of risk, roughly five positions at the default size. */
const DEFAULT_DAILY_BPS = 1_000;
/**
 * Never trade the wallet to zero. Transaction fees, the wrapped SOL account's
 * rent and a token account per position all come out of the same balance, and a
 * wallet that cannot pay a fee cannot exit a position either.
 */
const DEFAULT_RESERVE_LAMPORTS = 20_000_000;

const BPS = 10_000n;

/** Offsets into Config and AgentAuth. Both are checked by tests/admin-and-rewards. */
const CONFIG_MAX_PER_TRADE_AT = 104 + 2;
const AGENT_DAILY_LIMIT_AT = 40;
const AGENT_SPENT_TODAY_AT = 48;
const AGENT_DAY_AT = 56;

const min = (a, b) => (a < b ? a : b);
const clampZero = (v) => (v < 0n ? 0n : v);

/**
 * Read the live picture: what the chain permits, what the agent holds, and what
 * it has already committed today.
 */
async function readLimits(connection, agent) {
  const configPda = routerPdas.config();
  const agentPda = routerPdas.agent(agent);
  const [cfg, agt, balance] = await Promise.all([
    connection.getAccountInfo(configPda, "confirmed"),
    connection.getAccountInfo(agentPda, "confirmed"),
    connection.getBalance(agent, "confirmed"),
  ]);
  if (!cfg) throw new Error("router config does not exist");
  if (!agt) throw new Error(`${agent.toBase58()} is not a registered agent`);

  // The chain rolls the budget by unix day, arithmetically rather than on a
  // schedule, so a stale `spent_today` from yesterday reads as zero here too.
  const today = BigInt(Math.floor(Date.now() / 1000 / 86_400));
  const day = agt.data.readBigInt64LE(AGENT_DAY_AT);
  const spentToday = day === today ? agt.data.readBigUInt64LE(AGENT_SPENT_TODAY_AT) : 0n;

  return {
    balance: BigInt(balance),
    absoluteCap: cfg.data.readBigUInt64LE(CONFIG_MAX_PER_TRADE_AT),
    dailyCap: agt.data.readBigUInt64LE(AGENT_DAILY_LIMIT_AT),
    spentToday,
  };
}

/**
 * The largest buy allowed right now, in lamports. Zero means do not trade.
 *
 * Four ceilings, and the smallest wins:
 *   - the chain's absolute per-trade cap
 *   - a share of the tradable balance
 *   - what is left of the chain's daily budget
 *   - a share of the balance as a daily budget
 *
 * The last one matters most as the balance grows: the on-chain daily limit is a
 * fixed 0.4 SOL, which is 176% of the clerk's balance today and would be 8% of
 * it after a 5 SOL reward. Whichever is tighter should bind.
 */
function maxBuy(limits, opts = {}) {
  const tradeBps = BigInt(opts.tradeBps ?? DEFAULT_TRADE_BPS);
  const dailyBps = BigInt(opts.dailyBps ?? DEFAULT_DAILY_BPS);
  const reserve = BigInt(opts.reserveLamports ?? DEFAULT_RESERVE_LAMPORTS);

  const tradable = clampZero(limits.balance - reserve);
  const perTrade = (tradable * tradeBps) / BPS;
  const dailyAllowance = (tradable * dailyBps) / BPS;

  const chainDailyLeft = clampZero(limits.dailyCap - limits.spentToday);
  const ourDailyLeft = clampZero(dailyAllowance - limits.spentToday);

  return min(
    min(limits.absoluteCap, perTrade),
    min(chainDailyLeft, ourDailyLeft),
  );
}

/**
 * Throws unless `lamports` is within every ceiling. The message says which one
 * bound, because "too large" without a reason is the kind of thing that gets
 * worked around rather than understood.
 */
function assertWithinBudget(limits, lamports, opts = {}) {
  const allowed = maxBuy(limits, opts);
  if (lamports <= allowed) return;

  const tradeBps = BigInt(opts.tradeBps ?? DEFAULT_TRADE_BPS);
  const reserve = BigInt(opts.reserveLamports ?? DEFAULT_RESERVE_LAMPORTS);
  const tradable = clampZero(limits.balance - reserve);
  const sol = (v) => (Number(v) / 1e9).toFixed(6);

  let why;
  if (allowed === 0n && tradable === 0n) {
    why = `balance ${sol(limits.balance)} SOL is at or below the ${sol(reserve)} reserve`;
  } else if (allowed === limits.absoluteCap) {
    why = `the chain's per-trade cap of ${sol(limits.absoluteCap)} SOL`;
  } else if (allowed === (tradable * tradeBps) / BPS) {
    why = `${Number(tradeBps) / 100}% of the ${sol(tradable)} SOL tradable balance`;
  } else {
    why = `what is left of today's budget, ${sol(allowed)} SOL after ${sol(limits.spentToday)} spent`;
  }
  throw new Error(`buy of ${sol(lamports)} SOL exceeds ${why}`);
}

module.exports = {
  readLimits, maxBuy, assertWithinBudget,
  DEFAULT_TRADE_BPS, DEFAULT_DAILY_BPS, DEFAULT_RESERVE_LAMPORTS,
};
