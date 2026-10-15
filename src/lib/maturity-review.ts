import { prisma } from "./prisma.js";

type InvestmentMeta = {
  kind: string;
  planLevel: number;
  maturesAt: string;
};

function parseInvestmentMeta(description: string | null): InvestmentMeta | null {
  if (!description) return null;

  try {
    const value = JSON.parse(description) as Partial<InvestmentMeta>;
    if (
      value.kind !== "investment_funding" ||
      typeof value.planLevel !== "number" ||
      typeof value.maturesAt !== "string"
    ) {
      return null;
    }
    return value as InvestmentMeta;
  } catch {
    return null;
  }
}

/** Notify admins once when an investment reaches maturity; this never credits a wallet. */
export async function notifyDueInvestmentReviews(): Promise<void> {
  try {
    const funding = await prisma.transaction.findMany({
      where: { type: "INVESTMENT", status: "COMPLETED" },
      select: {
        id: true,
        userId: true,
        amount: true,
        reference: true,
        description: true,
      },
    });

    const due = funding.flatMap((investment) => {
      const meta = parseInvestmentMeta(investment.description);
      if (!meta) return [];

      const maturesAt = new Date(meta.maturesAt);
      if (!Number.isFinite(maturesAt.getTime()) || maturesAt.getTime() > Date.now()) {
        return [];
      }

      return [{ investment, meta, maturesAt }];
    });

    if (due.length === 0) return;

    const returnReferences = due.map(
      ({ investment }) => `RET-${investment.reference || investment.id}`
    );
    const [returns, admins] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          type: "INVESTMENT_RETURN",
          status: "COMPLETED",
          reference: { in: returnReferences },
        },
        select: { reference: true },
      }),
      prisma.user.findMany({
        where: { role: "ADMIN" },
        select: { id: true },
      }),
    ]);

    if (admins.length === 0) return;

    const completedReturnReferences = new Set(
      returns.map((transaction) => transaction.reference)
    );
    const pendingReview = due.filter(({ investment }) =>
      !completedReturnReferences.has(`RET-${investment.reference || investment.id}`)
    );
    if (pendingReview.length === 0) return;

    await prisma.notification.createMany({
      data: pendingReview.flatMap(({ investment, meta, maturesAt }) =>
        admins.map((admin) => ({
          // A stable primary key makes repeated scans safe, including across restarts.
          id: `maturity-review-${admin.id}-${investment.id}`,
          userId: admin.id,
          title: "Investment maturity due for review",
          body: `VIP ${meta.planLevel} investment ${investment.reference || investment.id} for ${investment.amount.toString()} USDT reached maturity on ${maturesAt.toISOString()}. Review is required; no wallet credit was made automatically.`,
          kind: "INVESTMENT_REVIEW",
        }))
      ),
      skipDuplicates: true,
    });
  } catch (error) {
    console.error("Investment maturity review scan failed.", error);
  }
}
