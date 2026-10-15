import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { MAX_TRANSACTION_AMOUNT, nonNegativeMoney, parsePositiveMoney, sumMoney } from "../lib/money.js";
import { lockWalletForSpending } from "../lib/wallet-lock.js";
import { calculateWithdrawalTerms, recordedWithdrawalTerms } from "../lib/withdrawal-fee.js";
import { isKnownNetwork, isSupportedNetwork, validateWithdrawalAddress, verifyUsdtTransfer } from "../lib/chain-verification.js";
import { creditVerifiedDeposit } from "../lib/automatic-deposits.js";
import { getSharedDepositAddress } from "../lib/deposit-addresses.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { userId: req.userId! },
      include: {
        ledgerEntries: {
          include: { transaction: true },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!wallet) return res.status(404).json({ error: "Wallet not found" });

    const balance = sumMoney(wallet.ledgerEntries.map((entry) => entry.amount));
    const pendingWithdrawals = await prisma.transaction.findMany({
      where: { userId: req.userId!, type: "WITHDRAWAL", status: "PENDING" },
      select: { amount: true },
    });
    const pendingWithdrawalTotal = sumMoney(pendingWithdrawals.map((item) => item.amount));
    const availableBalance = nonNegativeMoney(balance.minus(pendingWithdrawalTotal));

    const recentTransactions = wallet.ledgerEntries.slice(0, 20).map((entry) => ({
      id: entry.transaction.id,
      type: entry.transaction.type,
      status: entry.transaction.status,
      amount: entry.amount.toString(),
      transactionAmount: entry.transaction.amount.toString(),
      asset: entry.asset,
      reference: entry.transaction.reference,
      description: entry.transaction.description,
      createdAt: entry.createdAt,
    }));

    return res.json({
      wallet: {
        id: wallet.id,
        asset: wallet.asset,
        balance: balance.toFixed(8),
        availableBalance: availableBalance.toFixed(8),
        pendingWithdrawal: pendingWithdrawalTotal.toFixed(8),
      },
      recentTransactions,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/deposit-address", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const network = String(req.query.network || "").trim();
    if (!isSupportedNetwork(network)) return res.status(400).json({ error: "Unsupported USDT network" });
    const depositAddress = getSharedDepositAddress(network);
    return res.json({ network, depositAddress, automaticMonitoring: false });
  } catch (error) {
    if (error instanceof Error && /not configured|extended key|derivation branch|not a valid/i.test(error.message)) return res.status(503).json({ error: error.message });
    next(error);
  }
});

router.post("/deposit", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const amount = parsePositiveMoney(req.body?.amount);
    const network = String(req.body?.network || "").trim();
    const idempotencyKey = String(req.header("Idempotency-Key") || "").trim() || null;

    if (!amount) {
      return res.status(400).json({ error: "Invalid deposit amount" });
    }
    if (!isSupportedNetwork(network)) return res.status(400).json({ error: "Unsupported USDT network" });
    if (amount.decimalPlaces() > 6) return res.status(400).json({ error: "USDT deposits support up to 6 decimal places" });
    const depositAddress = getSharedDepositAddress(network);

    if (amount.gt(MAX_TRANSACTION_AMOUNT)) {
      return res.status(400).json({ error: "Deposit amount is too large" });
    }

    if (idempotencyKey) {
      const existing = await prisma.transaction.findUnique({ where: { idempotencyKey } });
      if (existing && existing.userId === req.userId!) {
        return res.status(200).json({
          message: "Deposit request already exists",
          transaction: existing,
        });
      }
    }

    const wallet = await prisma.wallet.findUnique({ where: { userId: req.userId! } });
    if (!wallet) return res.status(404).json({ error: "Wallet not found" });

    const transaction = await prisma.transaction.create({
      data: {
        userId: req.userId!,
        type: "DEPOSIT",
        status: "PENDING",
        amount,
        asset: "USDT",
        reference: `DEP-${randomUUID()}`,
        description: JSON.stringify({ kind: "deposit", network, sendAmount: amount.toString(), depositAddress }),
        idempotencyKey,
      },
    });

    await prisma.notification.create({
      data: {
        userId: req.userId!,
        title: "Deposit request submitted",
        body: `${amount.toFixed(2)} USDT deposit is awaiting confirmation.`,
        kind: "TRANSACTION"
      }
    });

    return res.status(201).json({
      message: "Deposit request created",
      transaction: {
        id: transaction.id,
        type: transaction.type,
        status: transaction.status,
        amount: transaction.amount.toString(),
        asset: transaction.asset,
        reference: transaction.reference,
        network,
        depositAddress,
        automaticMonitoring: false,
        createdAt: transaction.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof Error && /not configured|extended key|derivation branch|not a valid/i.test(error.message)) return res.status(503).json({ error: error.message });
    next(error);
  }
});

router.post("/deposit/:id/verify", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const transaction = await prisma.transaction.findFirst({ where: { id: String(req.params.id), userId: req.userId!, type: "DEPOSIT" } });
    if (!transaction) return res.status(404).json({ error: "Deposit request not found" });
    if (transaction.status === "COMPLETED") return res.json({ message: "Deposit was already verified", transaction });
    if (!["PENDING", "FAILED"].includes(transaction.status)) return res.status(400).json({ error: `Deposit cannot be verified from status ${transaction.status}` });
    let meta: any;
    try { meta = JSON.parse(transaction.description || "{}"); } catch { meta = {}; }
    // Allow verification of pre-existing TRC20 requests, while new requests are BEP20-only.
    if (!isKnownNetwork(meta.network)) return res.status(400).json({ error: "Deposit network is missing or unsupported" });
    const depositAddress = typeof meta.depositAddress === "string" && meta.depositAddress
      ? meta.depositAddress
      : getSharedDepositAddress(meta.network);
    const txHash = String(req.body?.txHash || "").trim();
    const verified = await verifyUsdtTransfer(meta.network, txHash, undefined, "IN", undefined, depositAddress);
    const credited = await creditVerifiedDeposit(transaction.id, req.userId!, meta.network, verified.hash, verified.blockTime, verified.amount, depositAddress);
    if (!credited) return res.status(409).json({ error: "This transfer was not made within the 20-minute request window, or the request or transaction hash has already been used" });
    const result = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    return res.json({ message: "On-chain deposit verified and credited", transaction: result, confirmations: verified.confirmations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not verify deposit";
    if (message.includes("not configured")) return res.status(503).json({ error: message });
    if (message.includes("already claimed") || message.includes("Unique constraint")) return res.status(409).json({ error: "This deposit request or transaction hash has already been used" });
    if (message.startsWith("Wallet not found")) return res.status(404).json({ error: "Wallet not found" });
    if (message.startsWith("Invalid") || message.startsWith("Unsupported") || message.startsWith("Transaction") || message.startsWith("On-chain") || message.startsWith("Configured") || message.startsWith("Chain RPC") || message.startsWith("Amount") || message.startsWith("The ")) return res.status(400).json({ error: message });
    next(error);
  }
});

router.post("/withdraw", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const amount = parsePositiveMoney(req.body?.amount);
    const network = String(req.body?.network || "").trim();
    const address = String(req.body?.address || "").trim();
    const withdrawalPassword = String(req.body?.withdrawalPassword || "");
    const idempotencyKey = String(req.header("Idempotency-Key") || "").trim() || null;

    if (!amount) {
      return res.status(400).json({ error: "Invalid withdrawal amount" });
    }
    if (!isSupportedNetwork(network)) return res.status(400).json({ error: "Unsupported USDT network" });
    const addressError = validateWithdrawalAddress(address, network);
    if (addressError) return res.status(400).json({ error: addressError });
    if (amount.lt("1")) return res.status(400).json({ error: "Minimum withdrawal is 1.00 USDT" });
    if (!withdrawalPassword) return res.status(400).json({ error: "Enter your withdrawal password" });
    if (amount.gt(MAX_TRANSACTION_AMOUNT)) {
      return res.status(400).json({ error: "Withdrawal amount is too large" });
    }

    if (idempotencyKey) {
      const existing = await prisma.transaction.findUnique({ where: { idempotencyKey } });
      if (existing && existing.userId === req.userId!) {
        const terms = recordedWithdrawalTerms(existing.amount, existing.description);
        return res.status(200).json({
          message: "Withdrawal request already exists",
          transaction: { ...existing, feeAmount: terms.feeAmount.toFixed(8), netAmount: terms.netAmount.toFixed(8) },
        });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      await lockWalletForSpending(tx, req.userId!);
      const wallet = await tx.wallet.findUnique({
        where: { userId: req.userId! },
        include: { ledgerEntries: true },
      });
      if (!wallet) throw new Error("Wallet not found");

      const user = await tx.user.findUnique({ where: { id: req.userId! }, select: { withdrawalPasswordHash: true } });
      if (!user?.withdrawalPasswordHash) throw new Error("Withdrawal password is not set. Set it in your account security settings first.");
      if (!(await bcrypt.compare(withdrawalPassword, user.withdrawalPasswordHash))) throw new Error("Incorrect withdrawal password");

      const balance = sumMoney(wallet.ledgerEntries.map((entry) => entry.amount));
      const pending = await tx.transaction.findMany({
        where: { userId: req.userId!, type: "WITHDRAWAL", status: "PENDING" },
        select: { amount: true },
      });
      const pendingTotal = sumMoney(pending.map((item) => item.amount));
      const available = nonNegativeMoney(balance.minus(pendingTotal));

      if (amount.gt(available)) {
        throw new Error(`Insufficient available balance. Available: ${available.toFixed(2)} USDT`);
      }

      const { feeAmount, netAmount } = calculateWithdrawalTerms(amount);

      const transaction = await tx.transaction.create({
        data: {
          userId: req.userId!,
          type: "WITHDRAWAL",
          status: "PENDING",
          amount,
          asset: "USDT",
          reference: `WDR-${randomUUID()}`,
          description: JSON.stringify({
            kind: "withdrawal", address, network,
            feePercent: 10,
            feeAmount: feeAmount.toFixed(8),
            netAmount: netAmount.toFixed(8),
            payoutMode: network === "BEP20"
              && process.env.PAYOUT_AUTOMATION_ENABLED?.trim().toLowerCase() === "true"
              && Boolean(process.env.TATUM_API_KEY?.trim() && process.env.TATUM_KMS_SIGNATURE_ID?.trim() && process.env.TATUM_PAYOUT_WALLET_ADDRESS?.trim())
              ? "TATUM"
              : network === "TRC20" && process.env.TRON_PAYOUT_AUTOMATION_ENABLED?.trim().toLowerCase() === "true"
                ? "TRON_LOCAL"
                : "MANUAL",
          }),
            idempotencyKey,
        },
      });

      await tx.notification.create({
        data: {
          userId: req.userId!,
          title: "Withdrawal request submitted",
          body: `${netAmount.toFixed(8)} USDT net payout is awaiting processing. The ${feeAmount.toFixed(8)} USDT fee is included in the ${amount.toFixed(8)} USDT request.`,
          kind: "TRANSACTION"
        }
      });

      return { transaction, feeAmount, netAmount };
    });

    return res.status(201).json({
      message: "Withdrawal request created",
      transaction: {
        id: result.transaction.id,
        type: result.transaction.type,
        status: result.transaction.status,
        amount: result.transaction.amount.toString(),
        feeAmount: result.feeAmount.toFixed(8),
        netAmount: result.netAmount.toFixed(8),
        asset: result.transaction.asset,
        reference: result.transaction.reference,
        createdAt: result.transaction.createdAt,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create withdrawal request";
    if (message === "Wallet not found") return res.status(404).json({ error: message });
    if (message.startsWith("Insufficient available balance") || message.startsWith("Withdrawal password") || message === "Incorrect withdrawal password") return res.status(400).json({ error: message });
    next(error);
  }
});

export default router;
