// What the model is allowed to say.
//
// This is the whole point of the boundary: an intent has no destination field.
// There is no slot in this shape for "send to address X", so no amount of
// clever text in a token description can produce one. The model picks a side,
// a mint and a size. That is the entire vocabulary.

const { PublicKey } = require("@solana/web3.js");

const ACTIONS = new Set(["buy", "sell", "hold"]);

/** Below this, priority and protocol fees eat the trade. */
const MIN_SOL = 0.005;

class IntentError extends Error {}

/**
 * Parse and validate. Throws rather than coercing, and rejects unknown fields
 * outright so a model cannot smuggle anything past by inventing keys.
 */
function parseIntent(raw, limits) {
  let obj = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new IntentError("intent is not valid JSON");
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new IntentError("intent must be an object");
  }

  const allowed = new Set(["action", "mint", "sol", "reason"]);
  const extra = Object.keys(obj).filter((k) => !allowed.has(k));
  if (extra.length) {
    throw new IntentError(`unknown field(s): ${extra.join(", ")}`);
  }

  const action = String(obj.action || "").toLowerCase();
  if (!ACTIONS.has(action)) {
    throw new IntentError(`action must be one of ${[...ACTIONS].join(", ")}`);
  }
  if (action === "hold") return { action: "hold", reason: text(obj.reason) };

  let mint;
  try {
    mint = new PublicKey(String(obj.mint));
  } catch {
    throw new IntentError("mint is not a valid address");
  }
  // Deliberately not checking the curve here: mints are ordinary keypairs and
  // are usually on-curve, so that test rejects real tokens. Proving this is a
  // mint means asking the chain who owns it, which `assertIsMint` does before
  // anything gets built.

  if (action === "sell") {
    return { action: "sell", mint, reason: text(obj.reason) };
  }

  const sol = Number(obj.sol);
  if (!Number.isFinite(sol) || sol <= 0) {
    throw new IntentError("sol must be a positive number");
  }
  if (sol < MIN_SOL) {
    throw new IntentError(`sol below ${MIN_SOL}; fees would exceed the trade`);
  }
  // The chain enforces this too. Failing here just saves a wasted transaction
  // and gives the model a readable reason instead of a program error code.
  if (limits && sol > limits.maxSolPerTrade) {
    throw new IntentError(
      `sol exceeds the per-trade cap of ${limits.maxSolPerTrade}`
    );
  }

  return { action: "buy", mint, sol, reason: text(obj.reason) };
}

function text(v) {
  if (v === undefined || v === null) return null;
  return String(v).slice(0, 280);
}

/**
 * The check the offline parser cannot do: only a token program may own a mint,
 * so a wallet address can never pass this.
 */
async function assertIsMint(connection, mint) {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new IntentError(`${mint.toBase58()} does not exist`);
  const owner = info.owner.toBase58();
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  if (owner !== TOKEN && owner !== TOKEN_2022) {
    throw new IntentError(`${mint.toBase58()} is not a token mint (owned by ${owner})`);
  }
  return info.owner;
}

module.exports = { parseIntent, assertIsMint, IntentError, ACTIONS, MIN_SOL };
