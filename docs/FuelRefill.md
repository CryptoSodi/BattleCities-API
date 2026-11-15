# Free fuel

New accounts start with 5 fuel once. Login does not grant another five.

Every 30 minutes from account creation, free fuel replenishes the balance up to
5. A balance of 2 receives 3; a balance of 5 or higher receives nothing. Purchased
fuel and other rewards can exceed 5 and are never reduced by the refill.

The server applies elapsed intervals when the authenticated account is next read
or mutated, before checking match fuel costs. Offline intervals do not stack;
returning after several hours still replenishes only up to 5. A full interval
cannot be saved and claimed immediately after spending fuel.

PostgreSQL locks the account and commits the balance, refill clock, and ledger
credit together. Migration 033 starts existing accounts' clock at rollout and
does not repeat the initial grant. Deploy the migration before the API release.
