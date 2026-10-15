DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "LedgerEntry"
    GROUP BY "transactionId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one ledger entry per transaction: duplicate ledger entries already exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "LedgerEntry_transactionId_key"
ON "LedgerEntry"("transactionId");
