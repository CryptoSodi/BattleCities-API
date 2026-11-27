# Free fuel

New accounts start with 5 fuel once. Login does not grant another five.

Free fuel arrives one at a time every 6 minutes, up to 5. A referred player
receives one every 5 minutes, up to 6. Purchased fuel and other rewards can
exceed the free refill cap and are never reduced by the refill.

The server applies elapsed intervals when the authenticated account is next read
or mutated, before checking match fuel costs. Offline intervals accumulate only
up to the applicable cap. A full interval
cannot be saved and claimed immediately after spending fuel.

PostgreSQL locks the account and commits the balance, refill clock, and ledger
credit together. Migration 033 starts existing accounts' clock at rollout and
does not repeat the initial grant. Account responses expose the server time, cap,
interval and next checkpoint for the home-screen countdown.
