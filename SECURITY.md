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
| Cannot exceed a per-trade cap **on a buy** | `max_lamports_per_trade` checked before the CPI | yes, `TradeTooLarge` |
| Cannot exceed a daily budget **on a buy** | rolling window on `AgentAuth` | yes, `DailyLimitExceeded` |
| Cannot redirect the fee | vault pinned to config | yes, `WrongFeeVault` |

Each was attacked directly in `tests/forked-buy.js` against pump.fun's real
program on a validator forked from mainnet, and each rejected the attack.

**The two spending limits are buy-side only, and the wording above is deliberate.**
`curve.rs` and `amm.rs` both wrap the zero check, the per-trade cap and
`charge_daily_budget` in `if side == Side::Buy`, and `sell` / `sell_amm` call
`route` with a ceiling of zero, so the block is unreachable twice over. A sell
still passes the pause switch, the `enabled` flag, the agent-seeded PDA, the
pinned CPI target and the fee vault pin, and on the curve it still refuses a
graduated token. Its size is not measured against anything, and its
`min_sol_output` / `min_quote_amount_out` are forwarded to the venue unexamined.

A poisoned agent therefore cannot spend more than its budget, but can liquidate
an entire position at any price in one instruction. Whether that is acceptable
is a product decision, not an oversight to paper over: selling reduces exposure,
which is the argument for leaving it open. It is recorded here so nobody reads
the table above as symmetric.

Two further limits on what this program can promise:

- **Nothing on chain ties a wallet to this program.** `AgentAuth` bounds trades
  routed through the router. The same key can sign a plain transfer and never
  touch it. Any claim that a registered wallet is protected "no matter what signs
  for it" is false; that property comes from the off-chain policy gate in
  `signer/`, and only while we hold the key and run it.
- **`set_agent` does not read `authority_managed`.** The authority can change any
  agent's ceiling, disable it, or grant it a reward share, including a wallet that
  registered itself. The flag only stops a wallet raising its own ceiling.

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
reason about the economics and does not substitute for a human reading the code.

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
- **`max_lamports_per_trade` is a lamport figure compared against the AMM's
  `max_quote_amount_in`**, which is denominated in the pool's quote mint. Nothing
  pins that mint to WSOL, and PumpSwap pool creation is permissionless. On an
  ordinary pump.fun pool the two units coincide; on a pool quoted in something
  else they do not, and neither the cap nor the budget means what it says.
- **The fee base differs by venue.** A curve buy measures the agent's raw lamport
  delta, so any rent the CPI makes the agent pay is inside the fee base. A curve
  sell measures lamports net of pump.fun's own fees, while an AMM sell measures
  gross quote credited.

## Proven on mainnet

As of 2026-08-17, eight transactions have touched the program: the deploy, then
`initialize`, `init_creator_vault` and `register_agent`, then two PumpSwap
trades, then two admin and rewards exercises.

- **The PumpSwap path works end to end with real money, both legs.** A buy and a
  sell of a third party's token, run by hand from `scripts/trade-mainnet.js`. The
  router took exactly 1.000% on each into the configured fee vault.
- The program is deployed on mainnet and devnet. Only mainnet was ever
  initialized, so **devnet is a shell**: no Config, no creator vault, no agent.
  A client pointed there fails on the first instruction that loads Config, which
  makes devnet useless as a rehearsal without initializing it first.

## Not proven

- **The bonding curve path has never run on mainnet.** It was exercised only
  against a forked validator.
- **Creator reward distribution has only run on a local validator.**
  `distribute_rewards` has never moved a creator fee on mainnet, because no token
  names the creator PDA, so the vault holds exactly its rent and the instruction
  aborts with `NothingToDistribute`.
- Two properties of `distribute_rewards` are untested and undesigned rather than
  verified: a call with zero payees satisfies the `% 2 == 0` check and sends the
  whole available balance to the treasury, and the payee loop has no seen-set, so
  a repeated pair is paid again up to the cumulative 100% cap. Neither is theft,
  since the treasury is pinned to config, but both mean `reward_bps` describes
  what a cooperative caller pays rather than what the instruction enforces.
- **The deployed binary has not been verified against source.** No reproducible
  build was run, so whether the mainnet artifact matches any commit in this repo
  is unknown.
- `npm test` is still the placeholder that exits 1, so `signer/policy.test.js`
  runs only when invoked by hand.
- No human other than the author has read this.

## Operational requirements that are easy to miss

- **The fee vault must be rent exempt before the first trade.** A fee smaller
  than the rent minimum landing in an empty account fails the entire
  transaction. Found in testing, not in review.
- **Upgrade authority is a single key.** For a program routing other people's
  money that is the first thing anyone will ask about. Move it to a multisig or
  decide deliberately not to.
- **`config.authority` has no rotation path.** It is written once in
  `initialize` and no instruction ever changes it. Losing that key permanently
  freezes agent registration, every agent limit, the pause switch and all fee
  configuration, recoverable only by a program upgrade, which needs the upgrade
  authority as well. Both keys are currently the same wallet.
- **The fee vault and the treasury are currently the same account**, so router
  trading fees and any undistributed creator rewards commingle with no way to
  tell them apart after the fact.
- **`creator` is set once, at token creation, and pump.fun's `set_creator` is
  gated by their authority.** If the creator PDA is wrong at launch, the creator
  revenue is unreachable forever.
