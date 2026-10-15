import { Prisma } from "../generated/prisma/client.js";

const WITHDRAWAL_FEE_RATE = new Prisma.Decimal("0.10");
const ZERO = new Prisma.Decimal(0);

export function calculateWithdrawalTerms(grossAmount: Prisma.Decimal) {
  const feeAmount = grossAmount.mul(WITHDRAWAL_FEE_RATE)
    .toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
  return { feeAmount, netAmount: grossAmount.minus(feeAmount) };
}

/** Preserve the terms recorded when a request was created; old requests remain fee-free. */
export function recordedWithdrawalTerms(amount: Prisma.Decimal, description: string | null) {
  try {
    const metadata = JSON.parse(description || "") as { feeAmount?: unknown; netAmount?: unknown };
    if (typeof metadata.feeAmount === "string" && typeof metadata.netAmount === "string") {
      return {
        feeAmount: new Prisma.Decimal(metadata.feeAmount),
        netAmount: new Prisma.Decimal(metadata.netAmount),
      };
    }
  } catch { /* Existing transactions may not have fee metadata. */ }
  return { feeAmount: ZERO, netAmount: amount };
}
