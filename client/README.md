# client

Everything the router needs off chain, built on the official pump.fun SDKs
rather than hand-rolled derivations.

| Module | Does |
|---|---|
| `venue.js` | decides curve vs PumpSwap for a mint, derives the accounts, flags accounts needing `extend_account` |
| `wsol.js` | wrap and unwrap around AMM trades, and resolves the mint's token program instead of assuming |
| `fees.js` | compute unit limit and a priority fee estimate from live chain data |

## Verified against mainnet

- Pool derivation: mint `7LSsEoJG…pump` resolves to `GseMAnND…d77J`, which
  exists and is owned by PumpSwap. Several guides, including the bundled
  pumpfun skill, say the pool seed uses the token **creator**. It does not. It
  uses the **pool-authority PDA**, which is what `canonicalPumpPoolPda` returns.
- Venue detection returns `curve` for a live bonding curve and `amm` for a
  graduated mint.
- `tokenProgramOf` returns Token-2022 for a `create_v2` mint, which is why the
  associated account must never be derived against classic SPL Token by default.
- Priority fee estimate returns a live figure, currently around 3.4M
  microlamports per CU, roughly 0.0007 SOL on a 200k CU trade.

## Not verified

Nothing here has built and sent a full AMM transaction yet. Quoting still needs
wiring to `buyBaseInput` / `buyQuoteInput` / `sellBaseInput` / `sellQuoteInput`
from `@pump-fun/pump-swap-sdk`, which must be used rather than a local constant
product formula: pools now carry a non-zero `virtual_quote_reserves` (~17.58
SOL) that shifts price by around 3.3%, and pump.fun's own README still
documents it as zero.
