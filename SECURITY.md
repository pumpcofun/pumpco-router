# security

What has actually been checked on this program, and what has not.

## The four invariants the program exists to enforce

An agent whose context has been poisoned can still sign anything it likes. These
are the things it cannot do, enforced on chain rather than in the process that
talks to the model.

| Invariant | How | Proven |
|---|---|---|
| Cannot route to another program | CPI target hardcoded to pump.fun / PumpSwap, pinned by `address =` | yes, `WrongProgram` |
| Cannot spend another agent's budget | agent PDA seeded by the signer | yes, by construction |
| Cannot exceed a per-trade cap | `max_lamports_per_trade` checked before the CPI | yes, `TradeTooLarge` |
| Cannot exceed a daily budget | rolling window on `AgentAuth` | yes, `DailyLimitExceeded` |
| Cannot redirect the fee | vault pinned to config | yes, `WrongFeeVault` |

Each was attacked directly in `tests/forked-buy.js` against pump.fun's real
program on a validator forked from mainnet, and each rejected the attack.

## Static analysis

`program_autofixer` from the Solana Foundation MCP (`https://mcp.solana.com/mcp`,
hosted, so always current) run over every module:

| Module | Issues | Suggestions |
|---|---|---|
| `lib.rs` | 0 | 0 |
| `state.rs` + `guards.rs` | 0 | 0 |
| `curve.rs` | 0 | 0 |
| `amm.rs` | 0 | 0 |
| `rewards.rs` | 0 | 0 |

A clean static pass is not an audit. It checks known rule patterns. It does not
reason about the economics, does not know the AMM path has never run, and does
not substitute for a human reading the code.

## Deliberate choices worth questioning in review

- **The daily budget reserves the slippage ceiling, not the settled cost.** The
  budget has to be provably safe before the trade runs, so unused headroom is
  charged and only released the next day. Conservative on purpose.
- **pump.fun's own PDAs are forwarded, not re-derived.** pump.fun validates them
  with its own seeds. Re-deriving here would add code that can be wrong without
  adding a guarantee.
- **`rewards.rs` moves lamports by direct adjustment** rather than a System CPI.
  The vault is owned by this program, so this is the normal pattern, but it is
  the sharpest edge in the codebase and deserves the closest read.
- **The fee is always taken in native SOL**, on both venues, so the vault holds
  one asset. On the AMM this means the size is measured from the WSOL account
  while the fee is paid from the agent's lamports.

## Not proven

- The AMM path compiles and lints clean but **has never executed**. Only the
  bonding curve path has run end to end.
- `sell` on either venue is written and unexercised.
- Nothing has touched mainnet or devnet.
- No human other than the author has read this.

## Operational requirements that are easy to miss

- **The fee vault must be rent exempt before the first trade.** A fee smaller
  than the rent minimum landing in an empty account fails the entire
  transaction. Found in testing, not in review.
- **Upgrade authority is a single key.** For a program routing other people's
  money that is the first thing anyone will ask about. Move it to a multisig or
  decide deliberately not to.
- **`creator` is set once, at token creation, and pump.fun's `set_creator` is
  gated by their authority.** If the creator PDA is wrong at launch, the creator
  revenue is unreachable forever.
