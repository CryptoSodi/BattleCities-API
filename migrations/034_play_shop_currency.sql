ALTER TABLE battlecity_shop_payments DROP CONSTRAINT battlecity_shop_payments_currency_check;
ALTER TABLE battlecity_shop_payments ADD CONSTRAINT battlecity_shop_payments_currency_check
  CHECK (currency IN ('sol', 'token', 'skr', 'play'));
