CREATE TABLE "DepositAddress" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "derivationIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DepositAddress_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DepositAddress_userId_network_key" ON "DepositAddress"("userId", "network");
CREATE UNIQUE INDEX "DepositAddress_network_derivationIndex_key" ON "DepositAddress"("network", "derivationIndex");
CREATE UNIQUE INDEX "DepositAddress_network_address_key" ON "DepositAddress"("network", "address");
CREATE INDEX "DepositAddress_network_createdAt_idx" ON "DepositAddress"("network", "createdAt");

ALTER TABLE "DepositAddress" ADD CONSTRAINT "DepositAddress_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
