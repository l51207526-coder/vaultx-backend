import { prisma } from "./prisma.js";

export const DEPOSIT_REQUEST_TTL_MS = 20 * 60 * 1000;

export function isWithinDepositWindow(createdAt: Date, blockTime: Date) {
  const transferTime = blockTime.getTime();
  const requestTime = createdAt.getTime();
  return transferTime >= requestTime && transferTime <= requestTime + DEPOSIT_REQUEST_TTL_MS;
}

export async function expirePendingDeposits() {
  const cutoff = new Date(Date.now() - DEPOSIT_REQUEST_TTL_MS);
  return prisma.transaction.updateMany({
    where: {
      type: "DEPOSIT",
      status: "PENDING",
      externalId: null,
      createdAt: { lte: cutoff },
    },
    data: { status: "FAILED" },
  });
}
