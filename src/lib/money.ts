import { Prisma } from "../generated/prisma/client.js";

Prisma.Decimal.set({ precision: 40 });

export type Money = Prisma.Decimal;

export const ZERO_MONEY = new Prisma.Decimal(0);
export const MAX_TRANSACTION_AMOUNT = new Prisma.Decimal("100000000");

export function sumMoney(values: Iterable<Money>): Money {
  let total = ZERO_MONEY;
  for (const value of values) total = total.plus(value);
  return total;
}

export function nonNegativeMoney(value: Money): Money {
  return value.lt(0) ? ZERO_MONEY : value;
}

export function parsePositiveMoney(value: unknown): Money | null {
  const isNumber = typeof value === "number" && Number.isFinite(value);
  const raw = typeof value === "string" ? value.trim() : isNumber ? String(value) : "";

  if (!raw || (typeof value === "string" && !/^\d+(?:\.\d{1,8})?$/.test(raw))) return null;

  try {
    const amount = new Prisma.Decimal(raw);
    return amount.gt(0) && amount.decimalPlaces() <= 8 ? amount : null;
  } catch {
    return null;
  }
}
