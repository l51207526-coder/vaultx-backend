import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../lib/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { nonNegativeMoney, sumMoney } from "../lib/money.js";
import { lockWalletForSpending } from "../lib/wallet-lock.js";
import { recordedWithdrawalTerms } from "../lib/withdrawal-fee.js";
import { isSupportedNetwork, verifyUsdtTransfer } from "../lib/chain-verification.js";

const router = Router();
const MAX_INVESTMENT_DAYS = 7;

/*
 * ============================================================
 * ADMIN AUTHENTICATION
 * ============================================================
 */

function requireAdminKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const configuredKey = process.env.ADMIN_API_KEY;
  const suppliedKey = String(req.header("x-admin-key") || "");

  if (!configuredKey) {
    return res.status(500).json({
      error: "Admin API key is not configured",
    });
  }

  if (!suppliedKey || suppliedKey !== configuredKey) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  next();
}

/*
 * ============================================================
 * INVESTMENT METADATA
 * ============================================================
 */

type InvestmentMeta = {
  kind: string;
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
    const value = JSON.parse(description);

    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.planLevel !== "number" ||
      (typeof value.dailyRate !== "number" && typeof value.dailyRate !== "string") ||
      typeof value.termDays !== "number" ||
      typeof value.startedAt !== "string" ||
      typeof value.maturesAt !== "string"
    ) {
      return null;
    }

    const termDays = Math.min(value.termDays, MAX_INVESTMENT_DAYS);
    const startedAt = new Date(value.startedAt);
    if (!Number.isFinite(startedAt.getTime())) return null;
    const maturesAt = new Date(startedAt.getTime() + termDays * 24 * 60 * 60 * 1000).toISOString();
    return {
      kind: typeof value.kind === "string"
        ? value.kind
        : "investment_funding",
      planLevel: value.planLevel,
      dailyRate: String(value.dailyRate),
      termDays,
      startedAt: value.startedAt,
      maturesAt,
    };
  } catch {
    return null;
  }
}

/*
 * ============================================================
 * PENDING ADMIN ITEMS
 * ============================================================
 */

router.get(
  "/pending",
  requireAdminKey,
  async (_req, res, next) => {
    try {
      const deposits = await prisma.transaction.findMany({
        where: {
          type: "DEPOSIT",
          status: "PENDING",
        },
        orderBy: {
          createdAt: "asc",
        },
      });

      const withdrawals = await prisma.transaction.findMany({
        where: {
          type: "WITHDRAWAL",
          status: "PENDING",
        },
        orderBy: {
          createdAt: "asc",
        },
      });

      return res.json({
        deposits,
        withdrawals: withdrawals.map((transaction) => {
          const terms = recordedWithdrawalTerms(transaction.amount, transaction.description);
          return { ...transaction, feeAmount: terms.feeAmount.toFixed(8), netAmount: terms.netAmount.toFixed(8) };
        }),
      });
    } catch (error) {
      next(error);
    }
  }
);

/*
 * ============================================================
 * DEPOSIT CONFIRMATION
 * ============================================================
 */

router.post(
  "/deposits/:id/confirm",
  requireAdminKey,
  async (req, res, next) => {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const transaction = await tx.transaction.findUnique({
          where: {
            id: String(req.params.id),
          },
        });

        if (!transaction) {
          throw new Error("Deposit transaction not found");
        }

        if (transaction.type !== "DEPOSIT") {
          throw new Error("Transaction is not a deposit");
        }

        if (!transaction.externalId || !transaction.externalId.includes(":")) {
          throw new Error("Deposit must be verified on-chain before it can be credited");
        }

        if (transaction.status === "COMPLETED") {
          return {
            transaction,
            alreadyCompleted: true,
          };
        }

        if (transaction.status !== "PENDING") {
          throw new Error(
            `Deposit cannot be confirmed from status ${transaction.status}`
          );
        }

        const wallet = await tx.wallet.findUnique({
          where: {
            userId: transaction.userId,
          },
        });

        if (!wallet) {
          throw new Error("Wallet not found");
        }

        /*
         * Atomically claim the pending deposit.
         * This prevents two admin requests from crediting
         * the same deposit twice.
         */
        const claimed = await tx.transaction.updateMany({
          where: {
            id: transaction.id,
            status: "PENDING",
          },
          data: {
            status: "COMPLETED",
          },
        });

        if (claimed.count !== 1) {
          const current = await tx.transaction.findUnique({
            where: {
              id: transaction.id,
            },
          });

          if (current?.status === "COMPLETED") {
            return {
              transaction: current,
              alreadyCompleted: true,
            };
          }

          throw new Error(
            "Deposit could not be confirmed because its status changed"
          );
        }

        const updated =
          await tx.transaction.findUniqueOrThrow({
            where: {
              id: transaction.id,
            },
          });

        await tx.ledgerEntry.create({
          data: {
            walletId: wallet.id,
            transactionId: transaction.id,
            amount: transaction.amount,
            asset: transaction.asset,
          },
        });

        await tx.notification.create({
          data: {
            userId: transaction.userId,
            title: "Deposit completed",
            body: `${transaction.amount.toString()} USDT has been credited to your wallet.`,
            kind: "TRANSACTION",
          },
        });

        return {
          transaction: updated,
          alreadyCompleted: false,
        };
      });

      return res.json({
        message: result.alreadyCompleted
          ? "Deposit was already confirmed"
          : "Deposit confirmed and wallet ledger updated",
        transaction: result.transaction,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not confirm deposit";

      if (message === "Deposit transaction not found") {
        return res.status(404).json({
          error: message,
        });
      }

      if (
        message === "Transaction is not a deposit" ||
        message === "Deposit must be verified on-chain before it can be credited" ||
        message.startsWith("Deposit cannot be confirmed")
      ) {
        return res.status(400).json({
          error: message,
        });
      }

      if (message === "Wallet not found") {
        return res.status(404).json({
          error: message,
        });
      }

      next(error);
    }
  }
);

/*
 * ============================================================
 * WITHDRAWAL COMPLETION
 * ============================================================
 */

router.post(
  "/withdrawals/:id/complete",
  requireAdminKey,
  async (req, res, next) => {
    try {
      const pendingWithdrawal = await prisma.transaction.findUnique({ where: { id: String(req.params.id) } });
      if (!pendingWithdrawal) return res.status(404).json({ error: "Withdrawal transaction not found" });
      if (pendingWithdrawal.type !== "WITHDRAWAL") return res.status(400).json({ error: "Transaction is not a withdrawal" });
      if (pendingWithdrawal.status === "COMPLETED") return res.json({ message: "Withdrawal was already completed", transaction: pendingWithdrawal });
      if (pendingWithdrawal.status !== "PENDING") return res.status(400).json({ error: `Withdrawal cannot be completed from status ${pendingWithdrawal.status}` });
      let withdrawalMeta: any;
      try { withdrawalMeta = JSON.parse(pendingWithdrawal.description || "{}"); } catch { withdrawalMeta = {}; }
      if (["CDP", "TATUM", "TRON_LOCAL"].includes(withdrawalMeta.payoutMode || "")) {
        return res.status(409).json({ error: "This withdrawal is assigned to an automated payout worker. Verify it through that worker instead of submitting a second hash." });
      }
      if (!isSupportedNetwork(withdrawalMeta.network) || typeof withdrawalMeta.address !== "string") {
        return res.status(400).json({ error: "Withdrawal network or destination is invalid" });
      }
      const txHash = String(req.body?.txHash || "").trim();
      const terms = recordedWithdrawalTerms(pendingWithdrawal.amount, pendingWithdrawal.description);
      const verified = await verifyUsdtTransfer(withdrawalMeta.network, txHash, terms.netAmount.toFixed(6), "OUT", withdrawalMeta.address);
      const result = await prisma.$transaction(async (tx) => {
        const transaction = await tx.transaction.findUnique({
          where: {
            id: String(req.params.id),
          },
        });

        if (!transaction) {
          throw new Error("Withdrawal transaction not found");
        }

        if (transaction.type !== "WITHDRAWAL") {
          throw new Error("Transaction is not a withdrawal");
        }

        const withdrawalTerms = recordedWithdrawalTerms(transaction.amount, transaction.description);

        if (transaction.status === "COMPLETED") {
          return {
            transaction,
            withdrawalTerms,
            alreadyCompleted: true,
          };
        }

        if (transaction.status !== "PENDING") {
          throw new Error(
            `Withdrawal cannot be completed from status ${transaction.status}`
          );
        }

        await lockWalletForSpending(tx, transaction.userId);

        const wallet = await tx.wallet.findUnique({
          where: {
            userId: transaction.userId,
          },
          include: {
            ledgerEntries: true,
          },
        });

        if (!wallet) {
          throw new Error("Wallet not found");
        }

        const balance = sumMoney(wallet.ledgerEntries.map((entry) => entry.amount));

        const otherPendingWithdrawals =
          await tx.transaction.findMany({
            where: {
              userId: transaction.userId,
              type: "WITHDRAWAL",
              status: "PENDING",
              id: {
                not: transaction.id,
              },
            },
            select: {
              amount: true,
            },
          });

        const pendingOtherTotal = sumMoney(otherPendingWithdrawals.map((item) => item.amount));

        const available =
          balance.minus(pendingOtherTotal);

        if (transaction.amount.gt(available)) {
          throw new Error(
            `Insufficient available balance. Available: ${nonNegativeMoney(available).toFixed(2)} USDT`
          );
        }

        /*
         * Atomically claim the withdrawal.
         */
        const claimed = await tx.transaction.updateMany({
          where: {
            id: transaction.id,
            status: "PENDING",
            externalId: null,
          },
          data: {
            status: "COMPLETED",
            externalId: `${withdrawalMeta.network}:${verified.hash}`,
          },
        });

        if (claimed.count !== 1) {
          const current = await tx.transaction.findUnique({
            where: {
              id: transaction.id,
            },
          });

          if (current?.status === "COMPLETED") {
            return {
              transaction: current,
              withdrawalTerms: recordedWithdrawalTerms(current.amount, current.description),
              alreadyCompleted: true,
            };
          }

          throw new Error(
            "Withdrawal could not be completed because its status changed"
          );
        }

        const updated =
          await tx.transaction.findUniqueOrThrow({
            where: {
              id: transaction.id,
            },
          });

        /*
         * Withdrawals are represented by a negative ledger entry.
         */
        await tx.ledgerEntry.create({
          data: {
            walletId: wallet.id,
            transactionId: transaction.id,
            amount: transaction.amount.negated(),
            asset: transaction.asset,
          },
        });

        await tx.notification.create({
          data: {
            userId: transaction.userId,
            title: "Withdrawal completed",
            body: `${withdrawalTerms.netAmount.toFixed(8)} USDT net payout completed. ${withdrawalTerms.feeAmount.toFixed(8)} USDT fee; ${transaction.amount.toFixed(8)} USDT debited.`,
            kind: "TRANSACTION",
          },
        });

        return {
          transaction: updated,
          withdrawalTerms,
          alreadyCompleted: false,
        };
      });

      return res.json({
        message: result.alreadyCompleted
          ? "Withdrawal was already completed"
          : "Withdrawal completed and wallet ledger updated",
        transaction: result.transaction,
        feeAmount: result.withdrawalTerms.feeAmount.toFixed(8),
        netAmount: result.withdrawalTerms.netAmount.toFixed(8),
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not complete withdrawal";

      if (message === "Withdrawal transaction not found") {
        return res.status(404).json({
          error: message,
        });
      }

      if (
        message === "Transaction is not a withdrawal" ||
        message.startsWith(
          "Withdrawal cannot be completed"
        ) ||
        message.startsWith(
          "Insufficient available balance"
        )
      ) {
        return res.status(400).json({
          error: message,
        });
      }
      if (message.includes("not configured")) return res.status(503).json({ error: message });
      if (message.includes("Unique constraint") || message.includes("externalId")) return res.status(409).json({ error: "This blockchain transaction has already been used" });
      if (message.startsWith("Invalid") || message.startsWith("Unsupported") || message.startsWith("Transaction") || message.startsWith("On-chain") || message.startsWith("Configured") || message.startsWith("Chain RPC") || message.startsWith("Amount") || message.startsWith("The ")) return res.status(400).json({ error: message });

      if (message === "Wallet not found") {
        return res.status(404).json({
          error: message,
        });
      }

      next(error);
    }
  }
);

/*
 * ============================================================
 * WITHDRAWAL REJECTION
 * ============================================================
 */

router.post(
  "/withdrawals/:id/reject",
  requireAdminKey,
  async (req, res, next) => {
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          const transaction =
            await tx.transaction.findUnique({
              where: {
                id: String(req.params.id),
              },
            });

          if (!transaction) {
            throw new Error(
              "Withdrawal transaction not found"
            );
          }

          if (transaction.type !== "WITHDRAWAL") {
            throw new Error(
              "Transaction is not a withdrawal"
            );
          }

          if (transaction.status === "CANCELLED") {
            return {
              transaction,
              alreadyRejected: true,
            };
          }

          if (transaction.status !== "PENDING") {
            throw new Error(
              `Withdrawal cannot be rejected from status ${transaction.status}`
            );
          }

          const claimed =
            await tx.transaction.updateMany({
              where: {
                id: transaction.id,
                status: "PENDING",
              },
              data: {
                status: "CANCELLED",
              },
            });

          if (claimed.count !== 1) {
            const current =
              await tx.transaction.findUnique({
                where: {
                  id: transaction.id,
                },
              });

            if (current?.status === "CANCELLED") {
              return {
                transaction: current,
                alreadyRejected: true,
              };
            }

            throw new Error(
              "Withdrawal could not be rejected because its status changed"
            );
          }

          const updated =
            await tx.transaction.findUniqueOrThrow({
              where: {
                id: transaction.id,
              },
            });

          await tx.notification.create({
            data: {
              userId: transaction.userId,
              title: "Withdrawal update",
              body: `${transaction.amount.toString()} USDT withdrawal was rejected.`,
              kind: "TRANSACTION",
            },
          });

          return {
            transaction: updated,
            alreadyRejected: false,
          };
        }
      );

      return res.json({
        message: result.alreadyRejected
          ? "Withdrawal was already rejected"
          : "Withdrawal rejected",
        transaction: result.transaction,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not reject withdrawal";

      if (
        message === "Withdrawal transaction not found"
      ) {
        return res.status(404).json({
          error: message,
        });
      }

      if (
        message === "Transaction is not a withdrawal" ||
        message.startsWith(
          "Withdrawal cannot be rejected"
        )
      ) {
        return res.status(400).json({
          error: message,
        });
      }

      next(error);
    }
  }
);

/*
 * ============================================================
 * INVESTMENT MATURITY
 * ============================================================
 */

router.post(
  "/investments/:id/mature",
  requireAdminKey,
  async (req, res, next) => {
    try {
      const result = await prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw<Array<{ locked: number }>>`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(735204, 1)) AS quantify_lock`;
          const investment =
            await tx.transaction.findUnique({
              where: {
                id: String(req.params.id),
              },
            });

          if (
            !investment ||
            investment.type !== "INVESTMENT"
          ) {
            throw new Error("Investment not found");
          }

          if (investment.status !== "COMPLETED") {
            throw new Error(
              `Investment cannot mature from status ${investment.status}`
            );
          }

          const meta = parseInvestmentMeta(
            investment.description
          );

          if (!meta) {
            throw new Error(
              "Investment metadata is invalid"
            );
          }

          /*
           * IMPORTANT:
           * An investment must reach its maturity date
           * before the return can be credited.
           */
          if (
            new Date(meta.maturesAt).getTime() >
            Date.now()
          ) {
            throw new Error(
              `Investment matures on ${meta.maturesAt}`
            );
          }

          const returnReference =
            `RET-${investment.reference || investment.id}`;

          /*
           * Idempotency:
           * Never create a second return transaction
           * for the same investment.
           */
          const existingReturn =
            await tx.transaction.findFirst({
              where: {
                reference: returnReference,
              },
            });

          if (existingReturn) {
            return {
              investment,
              returnTransaction: existingReturn,
              alreadyMatured: true,
            };
          }

          const wallet = await tx.wallet.findUnique({
            where: {
              userId: investment.userId,
            },
          });

          if (!wallet) {
            throw new Error("Wallet not found");
          }

          const principal = new Prisma.Decimal(investment.amount.toString());

          const projectedProfit =
            principal
              .mul(new Prisma.Decimal(meta.dailyRate))
              .mul(meta.termDays);

          const priorReturnTransactions = await tx.transaction.findMany({
            where: {
              userId: investment.userId,
              type: "INVESTMENT_RETURN",
              status: "COMPLETED",
            },
            select: { amount: true, description: true },
          });
          const creditedDailyReturns = priorReturnTransactions.reduce((sum, item) => {
            try {
              const detail = JSON.parse(item.description || "{}");
              return detail.kind === "daily_quantify_credit" && detail.investmentId === investment.id
                ? sum.plus(item.amount)
                : sum;
            } catch {
              return sum;
            }
          }, new Prisma.Decimal(0));
          const profit = nonNegativeMoney(projectedProfit.minus(creditedDailyReturns));

          const totalReturn =
            principal.plus(profit);

          const returnTransaction =
            await tx.transaction.create({
              data: {
                userId: investment.userId,
                type: "INVESTMENT_RETURN",
                status: "COMPLETED",
                amount: totalReturn,
                asset: investment.asset,
                reference: returnReference,
                description: JSON.stringify({
                  kind: "investment_return",
                  investmentId: investment.id,
                  principal: principal.toString(),
                  profit: profit.toString(),
                  creditedDailyReturns: creditedDailyReturns.toString(),
                  totalReturn: totalReturn.toString(),
                }),
              },
            });

          /*
           * Credit the principal + profit to the wallet.
           */
          await tx.ledgerEntry.create({
            data: {
              walletId: wallet.id,
              transactionId: returnTransaction.id,
              amount: totalReturn,
              asset: investment.asset,
            },
          });

          await tx.notification.create({
            data: {
              userId: investment.userId,
              title: "Investment return credited",
              body: `${totalReturn.toFixed(2)} USDT investment return has been credited.`,
              kind: "INVESTMENT",
            },
          });

          return {
            investment,
            returnTransaction,
            alreadyMatured: false,
          };
        }
      );

      return res.json({
        message: result.alreadyMatured
          ? "Investment was already matured"
          : "Investment matured and return credited",
        investment: result.investment,
        returnTransaction:
          result.returnTransaction,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not mature investment";

      /*
       * These are expected API errors, NOT server failures.
       */

      if (message === "Investment not found") {
        return res.status(404).json({
          error: message,
        });
      }

      if (
        message ===
        "Investment metadata is invalid"
      ) {
        return res.status(400).json({
          error: message,
        });
      }

      if (
        message.startsWith(
          "Investment cannot mature from status"
        )
      ) {
        return res.status(400).json({
          error: message,
        });
      }

      if (
        message.startsWith(
          "Investment matures on"
        )
      ) {
        const maturesAt =
          message.replace(
            "Investment matures on ",
            ""
          );

        return res.status(400).json({
          error: "Investment has not matured yet",
          maturesAt,
        });
      }

      if (message === "Wallet not found") {
        return res.status(404).json({
          error: message,
        });
      }

      next(error);
    }
  }
);

export default router;
