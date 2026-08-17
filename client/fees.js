// Compute budget for a trade.
//
// A mainnet trade without a priority fee may simply never land, so this is not
// optional polish. The estimate comes from `getRecentPrioritizationFees`, which
// is a core Agave RPC method and therefore works against any provider rather
// than binding us to one. Verified live: 150 samples returned for the pump.fun
// program, of which only a handful are non-zero, which is exactly why the
// percentile is taken over non-zero samples only. Averaging in the zeros would
// report a fee far below what is actually clearing.

const { ComputeBudgetProgram } = require("@solana/web3.js");

/**
 * pump.fun's own guidance is a static limit rather than a simulated one,
 * because measured usage shifts with PDA bump seeds and simulation is both
 * slower and unreliable. Ours sits above that to cover the router frame and
 * the wrap and unwrap instructions.
 */
const CU_LIMIT = 200_000;
const FALLBACK_MICROLAMPORTS = 100_000;
const MAX_MICROLAMPORTS = 5_000_000;

/**
 * @param percentile 0..1. Higher lands more reliably and costs more. 0.75 is a
 *        reasonable default for a trade that should land but is not racing.
 */
async function estimatePriorityFee(connection, addresses, percentile = 0.75) {
  let samples;
  try {
    samples = await connection.getRecentPrioritizationFees({
      lockedWritableAccounts: addresses,
    });
  } catch {
    return FALLBACK_MICROLAMPORTS;
  }

  // Most slots carry no priority fee at all. Those slots say nothing about
  // what it costs to land, so they are dropped rather than averaged in.
  const paid = samples
    .map((s) => s.prioritizationFee)
    .filter((f) => f > 0)
    .sort((a, b) => a - b);

  if (paid.length === 0) return FALLBACK_MICROLAMPORTS;

  const index = Math.min(paid.length - 1, Math.floor(paid.length * percentile));
  return Math.min(MAX_MICROLAMPORTS, Math.max(1, paid[index]));
}

/** Always the first instructions in the transaction. */
async function computeBudgetInstructions(connection, addresses, opts = {}) {
  const units = opts.units ?? CU_LIMIT;
  const microLamports =
    opts.microLamports ?? (await estimatePriorityFee(connection, addresses, opts.percentile));

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

/** What the priority fee actually costs, so a caller can budget for it. */
function priorityCostLamports(units, microLamports) {
  return Math.ceil((units * microLamports) / 1_000_000);
}

module.exports = {
  CU_LIMIT,
  FALLBACK_MICROLAMPORTS,
  MAX_MICROLAMPORTS,
  estimatePriorityFee,
  computeBudgetInstructions,
  priorityCostLamports,
};
