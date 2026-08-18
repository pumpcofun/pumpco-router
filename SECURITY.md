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

## Verified against source

The deployed binary is a reproducible build of this commit.

| | |
|---|---|
| Program | `PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp` |
| Program hash | `e69386c77ac659e40286049142b3f78a937c6257f9dff9e853c80b7444ae8274` |
| Status | https://verify.osec.io/status/PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp |

To reproduce, which needs Docker and nothing from the author's machine:

```
solana-verify build --library-name pumpco_router   -b solanafoundation/solana-verifiable-build:4.0.3
solana-verify get-program-hash -u <rpc> PUMpCot6PDv4pda4a6Mwd3gDMyFCXpSLFej9ftskrxp
```

The image tag matters. Images older than 3.1.x ship a cargo that cannot parse the
`edition2024` manifests in the dependency tree, and every image produces a binary
roughly 27 KB larger than a local `cargo build-sbf`, so the program account must
be sized for the reproducible build rather than the local one.

This proves the bytes on chain are the source in this repo. It says nothing about
whether the source is correct.

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

All of this ran against the deployed binary, on mainnet, with real money.

**Both venues, both legs.** PumpSwap and the bonding curve each completed a buy
and a sell routed by the clerk. `TradeRouted` fired on all four and decodes with
the site's own `extractTrades`, with `onAmm` correctly distinguishing the venue.

| | |
|---|---|
| AMM buy | `64e1QiULJ2KMVJwsLanQeVzrt5b5b5dz35jx7qvQ3UdChWKLr4TzWphtF2nBki2pW7n9aukTDfdNrCh3TzDjVdKg` |
| AMM sell | `2zG2J7Z4symQp2NSpfNxhEPzyvK7P7KpDbdyWLV2SwQEFWoEGY7xRJTWSYmvXDE4zAu1wD9aEfpXbdb5HvKYrh1` |
| curve buy | `inGdjanKhvVcsX5fqWjprr4aFfw2rE6QNhjmaN6HQ5dW8XbfkGMRvN4bYZRcU3fpt2jW74K8u9RArFYhxXiFar5` |
| curve sell | `32aecmidNc4BwfQqppmcp2e4idpMPppoobDWuwmRV45bKtGjsyEL3AzeCabjV7U8mAJrnH6UwJTp5dAk9ri1qZKU` |

**The fee is real and exact.** With the clerk temporarily set to 100 bps, a buy
and a sell each moved exactly 1.0000% into the fee vault, measured from the event
rather than inferred. The clerk was returned to 0 afterwards.

**The creator reward path works end to end**, staged before any token names the
vault: wrapped SOL parked in the vault's token account exactly as pump.fun pays
it after graduation, then `unwrap_creator_fees` converted it to lamports and
closed the account, then `distribute_rewards` split it **50.00%** to the clerk
against its 5000 bps share, remainder to the treasury, leaving the vault rent
exempt. This is the mechanism the token's funding depends on, and it is no longer
theoretical.

**The kill switch works.** With `paused` true, a valid buy fails at `amm.rs:30`
with `Paused`; it unpaused cleanly.

**Thirteen guards were attacked directly on the deployed program** and all
refused, seven on the trading path and six on the admin path. Simulation, so free:
`scripts/guards-mainnet.js` and `admin-mainnet.js guards`.

| Attack | Refused with |
|---|---|
| buy above the per-trade cap | `TradeTooLarge` |
| fee redirected to another vault | `WrongFeeVault` |
| CPI target swapped to the curve program | `WrongProgram` |
| CPI target swapped to the token program | `WrongProgram` |
| spending another agent's budget | `ConstraintSeeds` |
| zero size | `ZeroAmount` |
| substituted config account | `ConstraintSeeds` |
| an agent raising its own ceiling | `AuthorityManaged` |
| an outsider calling `update_config` | `Unauthorized` |
| config fee above the 3% ceiling | `FeeTooHigh` |
| agent fee above the 3% ceiling | `FeeTooHigh` |
| reward share above 100% | `RewardSharesTooHigh` |
| distribute naming no agents | `IncompletePayees` |

`set_authority` was exercised as a no-op rotation to the same key.

## Not proven

- **No outsider has ever used the router.** `self_register` has not been called
  on mainnet, so the path by which someone other than us registers a wallet and
  pays the config fee rate is unexercised.
- **No real creator fee has ever been paid to the vault.** The reward path was
  proven with wrapped SOL we staged there ourselves. Nothing has yet arrived from
  pump.fun, because no token names the vault.
- No human other than the author has read this.

## The outage of 2026-08-17, on the previous deployment

`Config` and `AgentAuth` each gained a field, both inserted mid-struct rather
than appended. The accounts on mainnet predated the change, so the upgraded
program could not deserialize them and every instruction failed for 37 minutes,
until a `migrate` instruction grew both records and shifted their tails.

Nothing could be lost, because nothing could execute.

Every suite passed throughout. All of them create their accounts fresh with the
program under test, so none could see a record written by an older build.
`tests/migration.js` now closes that gap by deploying the previous program,
writing real records with it, upgrading, and migrating. Run it for any future
change to an on-chain struct, and prefer appending fields to inserting them.

## Operational requirements that are easy to miss

- **The fee vault must be rent exempt before the first trade.** A fee smaller
  than the rent minimum landing in an empty account fails the entire
  transaction. Found in testing, not in review.
- **Upgrade authority is a single key.** For a program routing other people's
  money that is the first thing anyone will ask about. Move it to a multisig or
  decide deliberately not to.
- **`config.authority` can now be rotated** with `set_authority`, but it and the
  upgrade authority are still the same wallet, so one key loss still costs both.
- **The fee vault and the treasury are currently the same account**, so router
  trading fees and any undistributed creator rewards commingle with no way to
  tell them apart after the fact.
- **`creator` is set once, at token creation, and pump.fun's `set_creator` is
  gated by their authority.** If the creator PDA is wrong at launch, the creator
  revenue is unreachable forever.
