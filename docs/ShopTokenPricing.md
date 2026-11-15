# SOL-based shop pricing

The admin controls each product's `shopSolPrices` base in SOL. With
`tokenPricingMode: "sol-discounted"`, SKR and PLAY both cost 80% of that SOL
value: `SOL base × SOL/USD × 0.80 ÷ token/USD`.

One process-wide, single-flight Jupiter Price V3 request obtains SOL, SKR and
PLAY together. The snapshot expires after ten minutes and is reused by every
player, catalog request and checkout. Derived amounts are cached by snapshot
and base price; an admin base-price change takes effect immediately without
requesting another market snapshot. A process restart needs one new snapshot.
Failed provider requests also wait for the next shared refresh, preventing
per-player retries from exhausting the price-provider request budget.
Unavailable/expired market data cannot authorize an automatic token quote.
SOL and explicitly configured manual prices remain independent of the feed.

The calculation uses rational BigInt arithmetic and rounds up only at the
token's atomic precision. A signed V2 checkout fixes that amount for the
existing two-minute approval window. Later exchange-rate or admin edits cannot
change an already quoted transaction. Existing payer, treasury, mint, token
program, message-integrity and idempotent payment checks remain in force.

`shopSkrOverrides` and `shopPlayPrices` provide explicit per-item token prices.
An omitted key uses automatic pricing; null disables that token/item. The admin
editor clears a token override back to automatic when its input is blank.
In backward-compatible `fixed` mode, legacy `shopSkrPrices` remain authoritative.
Blank SOL prices disable that item's SOL option. Season passes retain their
separate SOL base and eligibility switches; automatic token pricing applies
to that base as well, with the same 20% discount.

PLAY is mainnet-only: mint
`PLAYs3GSSadH2q2JLS7djp7yzeT75NK78XgrE5YLrfq`, six decimals, classic SPL Token
program. Migration 034 adds `play` to the payment receipt currency constraint.
PSG1 selects PLAY; other game platforms retain SKR. Footer balance rounding is
display-only, while approval dialogs and signed amounts preserve exact precision.
