CREATE TABLE "ChainScanCursor" (
    "network" TEXT NOT NULL,
    "cursor" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainScanCursor_pkey" PRIMARY KEY ("network")
);
