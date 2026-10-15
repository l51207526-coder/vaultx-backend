import { Prisma } from "../generated/prisma/client.js";

export async function lockWalletForSpending(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<void> {
  await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Wallet"
    WHERE "userId" = ${userId}
    FOR UPDATE
  `;
}
