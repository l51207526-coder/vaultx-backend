ALTER TABLE "Transaction" ADD COLUMN "payoutTxHash" TEXT;

CREATE UNIQUE INDEX "Transaction_payoutTxHash_key" ON "Transaction"("payoutTxHash");
