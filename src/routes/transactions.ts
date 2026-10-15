import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { recordedWithdrawalTerms } from "../lib/withdrawal-fee.js";

const router = Router();

function maskEmail(email: string): string {
  const separator = email.lastIndexOf("@");
  if (separator < 1) return "•••";
  return `${email.slice(0, 1)}•••${email.slice(separator)}`;
}

router.get("/recent-withdrawals", requireAuth, async (_req, res, next) => {
  try {
    const withdrawals = await prisma.transaction.findMany({
      where: { type: "WITHDRAWAL", status: "COMPLETED" },
      include: { user: { select: { email: true } } },
      orderBy: { updatedAt: "desc" },
      take: 8,
    });

    return res.json({
      withdrawals: withdrawals.map((withdrawal) => {
        const terms = recordedWithdrawalTerms(withdrawal.amount, withdrawal.description);
        return {
          account: maskEmail(withdrawal.user.email),
          amount: terms.netAmount.toFixed(2),
          asset: withdrawal.asset,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const transactions = await prisma.transaction.findMany({
      where: { userId: req.userId! },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return res.json({
      transactions: transactions.map((transaction) => ({
        id: transaction.id,
        type: transaction.type,
        status: transaction.status,
        amount: transaction.amount.toString(),
        asset: transaction.asset,
        reference: transaction.reference,
        description: transaction.description,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
