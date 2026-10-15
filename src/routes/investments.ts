import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { nonNegativeMoney, sumMoney } from "../lib/money.js";
import { lockWalletForSpending } from "../lib/wallet-lock.js";
import { getDepositMonitorConfig } from "../lib/chain-verification.js";

const router = Router();

const TERM_DAYS = 7;
const DAILY_RATE = "0.13";

const PLAN_AMOUNTS: Record<number, number> = {
  1: 50,
  2: 100,
  3: 200,
  4: 500,
  5: 1000,
  6: 1500,
  7: 2000,
  8: 6000,
  9: 15000,
  10: 35000,
};

/*
 * Referral commission rates:
 *
 * Level 1 = direct referral = 5%
 * Level 2 = second level     = 2%
 * Level 3 = third level      = 1%
 */
const REFERRAL_RATES: Record<number, string> = {
  1: "0.05",
  2: "0.02",
  3: "0.01",
};

function eatDateTime(date: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    day: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

async function getUncommittedPayoutUsdt(tx: Prisma.TransactionClient) {
  const chain = getDepositMonitorConfig("BEP20");
  const payoutAddress = process.env.TATUM_PAYOUT_WALLET_ADDRESS?.trim();
  if (!chain || !payoutAddress || !/^0x[0-9a-fA-F]{40}$/.test(payoutAddress)) {
    throw new Error("The BNB Smart Chain payout reserve is not configured.");
  }
  if (process.env.BSC_SEND_ADDRESS?.trim().toLowerCase() !== payoutAddress.toLowerCase()) {
    throw new Error("The configured payout wallet does not match the BNB Smart Chain sender.");
  }

  const [chainIdResponse, balanceResponse] = await Promise.all([
    fetch(chain.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(15_000),
    }),
    fetch(chain.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_call",
        params: [{
          to: chain.tokenAddress,
          data: `0x70a08231${payoutAddress.slice(2).toLowerCase().padStart(64, "0")}`,
        }, "latest"],
      }),
      signal: AbortSignal.timeout(15_000),
    }),
  ]);
  if (!chainIdResponse.ok || !balanceResponse.ok) {
    throw new Error(`Could not read payout wallet balance (HTTP ${chainIdResponse.status}/${balanceResponse.status}).`);
  }
  const chainBody = await chainIdResponse.json() as { result?: string; error?: { message?: string } };
  if (chainBody.error || chainBody.result !== "0x38") {
    throw new Error("The configured payout RPC is not connected to BNB Smart Chain.");
  }
  const body = await balanceResponse.json() as { result?: string; error?: { message?: string } };
  if (body.error || typeof body.result !== "string" || !/^0x[0-9a-f]+$/i.test(body.result)) {
    throw new Error(`Could not read payout wallet balance${body.error?.message ? `: ${body.error.message}` : "."}`);
  }

  /*
   * Check on-chain liquidity after subtracting existing customer balances and
   * active investment obligations. The caller holds the shared advisory lock,
   * so concurrent daily credits and maturity credits cannot spend the same reserve.
   */
  // Binance-Peg BSC-USD uses 18 decimals on BNB Smart Chain.
  const raw = BigInt(body.result);
  const scale = 10n ** 18n;
  const walletBalance = new Prisma.Decimal(`${raw / scale}.${(raw % scale).toString().padStart(18, "0")}`);

  const wallets = await tx.wallet.findMany({ include: { ledgerEntries: { select: { amount: true, asset: true } } } });
  const walletLiability = sumMoney(wallets.map((wallet) =>
    sumMoney(wallet.ledgerEntries.filter((entry) => entry.asset === "USDT").map((entry) => entry.amount))
  ).map((amount) => nonNegativeMoney(amount)));

  const [fundings, returns] = await Promise.all([
    tx.transaction.findMany({ where: { type: "INVESTMENT", status: "COMPLETED" } }),
    tx.transaction.findMany({ where: { type: "INVESTMENT_RETURN", status: "COMPLETED" }, select: { reference: true, amount: true, description: true } }),
  ]);
  const maturedRefs = new Set(returns.map((item) => item.reference || ""));
  const paidDailyReturns = new Map<string, Prisma.Decimal>();
  for (const item of returns) {
    try {
      const meta = JSON.parse(item.description || "{}");
      if (meta.kind !== "daily_quantify_credit" || typeof meta.investmentId !== "string") continue;
      paidDailyReturns.set(meta.investmentId, (paidDailyReturns.get(meta.investmentId) || new Prisma.Decimal(0)).plus(item.amount));
    } catch { /* Ignore unrelated transaction descriptions. */ }
  }

  let investmentLiability = new Prisma.Decimal(0);
  for (const funding of fundings) {
    const meta = parseInvestmentMeta(funding.description);
    if (!meta || maturedRefs.has(`RET-${funding.reference || funding.id}`)) continue;
    const principal = new Prisma.Decimal(funding.amount);
    const fullReturn = principal.plus(principal.mul(meta.dailyRate).mul(meta.termDays));
    const alreadyPaid = paidDailyReturns.get(funding.id) || new Prisma.Decimal(0);
    investmentLiability = investmentLiability.plus(nonNegativeMoney(fullReturn.minus(alreadyPaid)));
  }

  return nonNegativeMoney(walletBalance.minus(walletLiability).minus(investmentLiability));
}

type InvestmentMeta = {
  kind: "investment_funding";
  planLevel: number;
  dailyRate: string;
  termDays: number;
  startedAt: string;
  maturesAt: string;
};

function parseInvestmentMeta(
  description: string | null
): InvestmentMeta | null {
  if (!description) return null;

  try {
    const value = JSON.parse(description) as Partial<InvestmentMeta>;

    if (
      value.kind !== "investment_funding" ||
      typeof value.planLevel !== "number" ||
      (typeof value.dailyRate !== "number" && typeof value.dailyRate !== "string") ||
      typeof value.termDays !== "number" ||
      typeof value.startedAt !== "string" ||
      typeof value.maturesAt !== "string"
    ) {
      return null;
    }

    const termDays = Math.min(value.termDays, TERM_DAYS);
    const startedAt = new Date(value.startedAt);
    if (!Number.isFinite(startedAt.getTime())) return null;
    const maturesAt = new Date(startedAt.getTime() + termDays * 24 * 60 * 60 * 1000).toISOString();
    return { ...value, dailyRate: String(value.dailyRate), termDays, maturesAt } as InvestmentMeta;
  } catch {
    return null;
  }
}

router.get("/plans", requireAuth, (_req, res) => {
  return res.json({
    termDays: TERM_DAYS,
    dailyRate: Number(DAILY_RATE),
    plans: Object.entries(PLAN_AMOUNTS).map(([level, amount]) => ({
      level: Number(level),
      name: `VIP ${level}`,
      amount,
    })),
  });
});

router.get(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const fundingTransactions = await prisma.transaction.findMany({
        where: {
          userId: req.userId!,
          type: "INVESTMENT",
          status: "COMPLETED",
        },
        orderBy: {
          createdAt: "desc",
        },
      });

      const returnTransactions = await prisma.transaction.findMany({
        where: {
          userId: req.userId!,
          type: "INVESTMENT_RETURN",
          status: "COMPLETED",
        },
        select: {
          id: true,
          reference: true,
          description: true,
          createdAt: true,
        },
      });

      const returnRefs = new Set(
        returnTransactions.map((tx) => tx.reference || "")
      );

      const todayEAT = eatDateTime(new Date()).day;
      const quantifyClaims = await prisma.transaction.findMany({
        where: {
          userId: req.userId!,
          type: "INVESTMENT_RETURN",
          status: "COMPLETED",
          idempotencyKey: { startsWith: "QNT:" },
        },
        select: { idempotencyKey: true },
      });
      const claimedToday = new Set(
        quantifyClaims
          .map((claim) => claim.idempotencyKey || "")
          .filter((key) => key.endsWith(`:${todayEAT}`))
      );

      const investments = fundingTransactions
        .map((tx) => {
          const meta = parseInvestmentMeta(tx.description);

          if (!meta) return null;

          const returnReference = `RET-${tx.reference || tx.id}`;
          const matured = returnRefs.has(returnReference);

          return {
            id: tx.id,
            reference: tx.reference,
            planLevel: meta.planLevel,
            principal: tx.amount.toString(),
            dailyRate: meta.dailyRate.toString(),
            termDays: meta.termDays,
            startedAt: meta.startedAt,
            maturesAt: meta.maturesAt,
            status: matured ? "MATURED" : "ACTIVE",
            quantifiedToday: claimedToday.has(`QNT:${tx.id}:${todayEAT}`),
          };
        })
        .filter(Boolean);

      return res.json({ investments });
    } catch (error) {
      next(error);
    }
  }
);

router.post(
  "/:id/quantify",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const now = eatDateTime(new Date());
      if (now.hour !== 15 || now.minute >= 30) {
        return res.status(400).json({ error: "Quantify is available daily from 15:00 to 15:30 EAT." });
      }

      const result = await prisma.$transaction(async (tx) => {
        // Serialize reserve checks with other quantify and maturity credits.
        await tx.$queryRaw<Array<{ locked: number }>>`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(735204, 1)) AS quantify_lock`;
        const claimTime = eatDateTime(new Date());
        if (claimTime.hour !== 15 || claimTime.minute >= 30) {
          throw new Error("Quantify window has closed. It is available daily from 15:00 to 15:30 EAT.");
        }

        const investment = await tx.transaction.findFirst({
          where: {
            id: String(req.params.id),
            userId: req.userId!,
            type: "INVESTMENT",
            status: "COMPLETED",
          },
        });
        const meta = parseInvestmentMeta(investment?.description || null);
        if (!investment || !meta) throw new Error("Active VIP investment not found.");

        const matured = await tx.transaction.findUnique({
          where: { reference: `RET-${investment.reference || investment.id}` },
          select: { id: true },
        });
        if (matured || new Date(meta.maturesAt).getTime() <= Date.now()) {
          throw new Error("This VIP investment is no longer active.");
        }

        const idempotencyKey = `QNT:${investment.id}:${claimTime.day}`;
        const priorClaim = await tx.transaction.findUnique({ where: { idempotencyKey } });
        if (priorClaim?.status === "COMPLETED") throw new Error("Today’s return has already been credited for this VIP.");
        const previousCredits = await tx.transaction.count({
          where: {
            userId: req.userId!,
            type: "INVESTMENT_RETURN",
            status: "COMPLETED",
            idempotencyKey: { startsWith: `QNT:${investment.id}:` },
          },
        });
        if (previousCredits >= meta.termDays) throw new Error("This investment has reached its seven daily credits.");

        const amount = investment.amount.mul(new Prisma.Decimal(meta.dailyRate)).toDecimalPlaces(8);
        const availableReserve = await getUncommittedPayoutUsdt(tx);
        if (availableReserve.lt(amount)) {
          throw new Error(`Insufficient uncommitted payout reserve. Available: ${availableReserve.toFixed(8)} USDT; required: ${amount.toFixed(8)} USDT.`);
        }

        const wallet = await tx.wallet.findUnique({ where: { userId: req.userId! } });
        if (!wallet) throw new Error("Wallet not found");

        const description = JSON.stringify({
          kind: "daily_quantify_credit",
          investmentId: investment.id,
          investmentReference: investment.reference,
          planLevel: meta.planLevel,
          claimDateEAT: claimTime.day,
          reserveChecked: true,
        });
        const credit = priorClaim
          ? await tx.transaction.update({
              where: { id: priorClaim.id },
              data: { status: "COMPLETED", amount, description },
            })
          : await tx.transaction.create({
              data: {
                userId: req.userId!,
                type: "INVESTMENT_RETURN",
                status: "COMPLETED",
                amount,
                asset: "USDT",
                reference: `QNT-${randomUUID()}`,
                idempotencyKey,
                description,
              },
            });

        await tx.ledgerEntry.create({ data: { walletId: wallet.id, transactionId: credit.id, amount, asset: "USDT" } });
        await tx.notification.create({
          data: {
            userId: req.userId!,
            title: "Daily return credited",
            body: `${amount.toFixed(2)} USDT was credited for VIP ${meta.planLevel}.`,
            kind: "INVESTMENT",
          },
        });
        return { credit, amount, dateEAT: claimTime.day };
      });

      return res.status(201).json({
        message: `${result.amount.toFixed(2)} USDT was added to your wallet balance.`,
        claim: { id: result.credit.id, amount: result.amount.toFixed(2), status: result.credit.status, dateEAT: result.dateEAT },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return res.status(409).json({ error: "The daily return was already credited for this VIP today." });
      }
      const message = error instanceof Error ? error.message : "Could not credit the daily return.";
      if (message.startsWith("Insufficient uncommitted payout reserve")) return res.status(409).json({ error: message });
      if (message === "Active VIP investment not found." || message === "This VIP investment is no longer active." || message.startsWith("Today’s return") || message.startsWith("This investment has reached")) return res.status(400).json({ error: message });
      if (message === "Wallet not found") return res.status(404).json({ error: message });
      if (message.startsWith("Quantify window has closed")) return res.status(400).json({ error: message });
      next(error);
    }
  }
);

router.post(
  "/",
  requireAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const planLevel = Number(req.body?.planLevel);
      const planAmount = PLAN_AMOUNTS[planLevel];

      if (!planAmount) {
        return res.status(400).json({
          error: "Invalid VIP plan.",
        });
      }
      const principal = new Prisma.Decimal(planAmount);

      const result = await prisma.$transaction(async (tx) => {
        await lockWalletForSpending(tx, req.userId!);
        /*
         * ------------------------------------------------------------
         * 1. Get the investor's wallet
         * ------------------------------------------------------------
         */

        const wallet = await tx.wallet.findUnique({
          where: {
            userId: req.userId!,
          },
          include: {
            ledgerEntries: true,
          },
        });

        if (!wallet) {
          throw new Error("Wallet not found");
        }

        const balance = sumMoney(wallet.ledgerEntries.map((entry) => entry.amount));

        /*
         * Pending withdrawals are not available for investment.
         */

        const pendingWithdrawals = await tx.transaction.findMany({
          where: {
            userId: req.userId!,
            type: "WITHDRAWAL",
            status: "PENDING",
          },
          select: {
            amount: true,
          },
        });

        const pendingWithdrawalTotal = sumMoney(pendingWithdrawals.map((item) => item.amount));

        const available = nonNegativeMoney(balance.minus(pendingWithdrawalTotal));

        /*
         * ------------------------------------------------------------
         * 2. Check whether this VIP plan is already active
         * ------------------------------------------------------------
         */

        const existing = await tx.transaction.findMany({
          where: {
            userId: req.userId!,
            type: "INVESTMENT",
            status: "COMPLETED",
          },
        });

        if (available.lt(principal)) {
          throw new Error(
            `Insufficient balance. Available: ${available.toFixed(2)} USDT`
          );
        }

        const allReturns = await tx.transaction.findMany({
          where: {
            userId: req.userId!,
            type: "INVESTMENT_RETURN",
            status: "COMPLETED",
          },
          select: {
            reference: true,
          },
        });

        const returnRefSet = new Set(
          allReturns.map((x) => x.reference || "")
        );

        const alreadyActive = existing.some((funding) => {
          const meta = parseInvestmentMeta(funding.description);

          if (!meta || meta.planLevel !== planLevel) {
            return false;
          }

          return !returnRefSet.has(
            `RET-${funding.reference || funding.id}`
          );
        });

        if (alreadyActive) {
          throw new Error("This VIP plan is already active.");
        }

        /*
         * ------------------------------------------------------------
         * 3. Create the investment
         * ------------------------------------------------------------
         */

        const startedAt = new Date();

        const maturesAt = new Date(startedAt);

        maturesAt.setDate(
          maturesAt.getDate() + TERM_DAYS
        );

        const reference = `INV-${randomUUID()}`;

        const meta: InvestmentMeta = {
          kind: "investment_funding",
          planLevel,
          dailyRate: DAILY_RATE,
          termDays: TERM_DAYS,
          startedAt: startedAt.toISOString(),
          maturesAt: maturesAt.toISOString(),
        };

        const transaction = await tx.transaction.create({
          data: {
            userId: req.userId!,
            type: "INVESTMENT",
            status: "COMPLETED",
            amount: principal,
            asset: "USDT",
            reference,
            description: JSON.stringify(meta),
          },
        });

        /*
         * Deduct the investment principal from the investor's wallet.
         */

        await tx.ledgerEntry.create({
          data: {
            walletId: wallet.id,
            transactionId: transaction.id,
            amount: principal.negated(),
            asset: "USDT",
          },
        });

        /*
         * ------------------------------------------------------------
         * 4. Notify the investor
         * ------------------------------------------------------------
         */

        await tx.notification.create({
          data: {
            userId: req.userId!,
            title: "VIP plan activated",
            body: `VIP ${planLevel} has been activated with ${principal.toFixed(2)} USDT for ${TERM_DAYS} days.`,
            kind: "INVESTMENT",
          },
        });

        /*
         * ------------------------------------------------------------
         * 5. REFERRAL REWARDS
         * ------------------------------------------------------------
         *
         * Investor
         *     ↓
         * Level 1 referrer = 5%
         *     ↓
         * Level 2 referrer = 2%
         *     ↓
         * Level 3 referrer = 1%
         *
         * Example:
         *
         * A user invests 50 USDT.
         *
         * Level 1 receives:
         * 50 × 5% = 2.50 USDT
         *
         * Level 2 receives:
         * 50 × 2% = 1.00 USDT
         *
         * Level 3 receives:
         * 50 × 1% = 0.50 USDT
         *
         * The reward is credited directly to the referrer's wallet.
         * ------------------------------------------------------------
         */

        let currentUserId: string | null = req.userId!;
        let referralLevel = 1;

        while (
          currentUserId !== null &&
          referralLevel <= 3
        ) {
          /*
           * Find the current user's direct referrer.
           */

          const currentUser: {
            referredById: string | null;
          } | null = await tx.user.findUnique({
            where: {
              id: currentUserId,
            },
            select: {
              referredById: true,
            },
          });

          /*
           * No referrer means the referral chain has ended.
           */

          if (!currentUser?.referredById) {
            break;
          }

          const referrerId: string =
            currentUser.referredById;

          const rate = new Prisma.Decimal(REFERRAL_RATES[referralLevel]);

          /*
           * Calculate the referral reward.
           */

          const rewardAmount = principal.mul(rate);

          if (rewardAmount.gt(0)) {
            /*
             * Create a deterministic reference.
             *
             * This prevents the same investment from generating
             * the same referral reward twice.
             */

            const rewardReference =
              `REF-${transaction.reference}-L${referralLevel}`;

            const existingReward =
              await tx.transaction.findUnique({
                where: {
                  reference: rewardReference,
                },
              });

            /*
             * Only create the reward if it doesn't already exist.
             */

            if (!existingReward) {
              const referrerWallet =
                await tx.wallet.findUnique({
                  where: {
                    userId: referrerId,
                  },
                });

              /*
               * A referrer should normally have a wallet.
               * If they don't, skip the reward rather than breaking
               * the entire VIP investment transaction.
               */

              if (referrerWallet) {
                /*
                 * Create the referral reward transaction.
                 */

                const rewardTransaction =
                  await tx.transaction.create({
                    data: {
                      userId: referrerId,
                      type: "REFERRAL_REWARD",
                      status: "COMPLETED",
                      amount: rewardAmount,
                      asset: "USDT",
                      reference: rewardReference,
                      description: JSON.stringify({
                        kind: "referral_reward",
                        level: referralLevel,
                        rate: rate.toString(),
                        sourceInvestmentId:
                          transaction.id,
                        sourceInvestmentReference:
                          transaction.reference,
                        sourceUserId: req.userId!,
                      }),
                    },
                  });

                /*
                 * Credit the reward to the referrer's wallet.
                 */

                await tx.ledgerEntry.create({
                  data: {
                    walletId: referrerWallet.id,
                    transactionId:
                      rewardTransaction.id,
                    amount: rewardAmount,
                    asset: "USDT",
                  },
                });

                /*
                 * Notify the referrer.
                 */

                await tx.notification.create({
                  data: {
                    userId: referrerId,
                    title: "Referral reward credited",
                    body: `You received ${rewardAmount.toFixed(2)} USDT from a Level ${referralLevel} referral reward.`,
                    kind: "REFERRAL_REWARD",
                  },
                });
              }
            }
          }

          /*
           * Move one level higher in the referral tree.
           */

          currentUserId = referrerId;
          referralLevel++;
        }

        return {
          transaction,
          meta,
        };
      });

      /*
       * ------------------------------------------------------------
       * 6. Return investment details to the frontend
       * ------------------------------------------------------------
       */

      return res.status(201).json({
        message: "VIP investment created",

        investment: {
          id: result.transaction.id,
          reference: result.transaction.reference,
          planLevel: result.meta.planLevel,
          principal: result.transaction.amount.toString(),
          dailyRate: result.meta.dailyRate,
          termDays: result.meta.termDays,
          startedAt: result.meta.startedAt,
          maturesAt: result.meta.maturesAt,
          status: "ACTIVE",
        },
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not create investment";

      if (message === "Wallet not found") {
        return res.status(404).json({
          error: message,
        });
      }

      if (
        message.startsWith("Insufficient balance") ||
        message.includes("already active")
      ) {
        return res.status(400).json({
          error: message,
        });
      }

      next(error);
    }
  }
);

export {
  parseInvestmentMeta,
  PLAN_AMOUNTS,
};

export default router;
