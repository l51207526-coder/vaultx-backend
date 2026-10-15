import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";
import { requirePayoutOperator } from "../middleware/payout-operator.js";
import { lockWalletForSpending } from "../lib/wallet-lock.js";
import { nonNegativeMoney, sumMoney } from "../lib/money.js";
import { recordedWithdrawalTerms } from "../lib/withdrawal-fee.js";
import { validateWithdrawalAddress, verifyUsdtTransfer } from "../lib/chain-verification.js";

const router = Router();
router.use(requireAuth, requirePayoutOperator);

function payoutConfig() {
  const senderAddress = process.env.BSC_SEND_ADDRESS?.trim();
  const tokenContract = process.env.BSC_USDT_CONTRACT?.trim();
  if (!senderAddress || !tokenContract) throw new Error("Automated BNB Smart Chain payouts require BSC_SEND_ADDRESS and BSC_USDT_CONTRACT to be configured");
  const senderError = validateWithdrawalAddress(senderAddress, "BEP20");
  const contractError = validateWithdrawalAddress(tokenContract, "BEP20");
  if (senderError || contractError) throw new Error("The configured BNB Smart Chain payout wallet or USDT contract address is invalid");
  return { senderAddress, tokenContract };
}

function readMeta(description: string | null): { network?: string; address?: string; payoutMode?: string } {
  try { return JSON.parse(description || "{}"); } catch { return {}; }
}

function withPayoutHashAudit(description: string | null, entry: Record<string, string>): string {
  let details: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(description || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed;
  } catch { /* Preserve the payout record even if legacy metadata is not JSON. */ }
  const history = Array.isArray(details.payoutHashHistory) ? details.payoutHashHistory : [];
  return JSON.stringify({ ...details, payoutHashHistory: [...history, entry] });
}

router.get("/pending", async (_req, res, next) => {
  try {
    const withdrawals = await prisma.transaction.findMany({
      where: { type: "WITHDRAWAL", status: "PENDING" },
      orderBy: { createdAt: "asc" },
    });
    let config: ReturnType<typeof payoutConfig> | null = null;
    let configurationError: string | null = null;
    try { config = payoutConfig(); } catch (error) { configurationError = error instanceof Error ? error.message : "Payout wallet is not configured"; }
    return res.json({
      withdrawals: withdrawals.map((transaction) => {
        const meta = readMeta(transaction.description);
        const terms = recordedWithdrawalTerms(transaction.amount, transaction.description);
        return {
          id: transaction.id,
          reference: transaction.reference,
          amount: transaction.amount.toString(),
          feeAmount: terms.feeAmount.toFixed(8),
          netAmount: terms.netAmount.toFixed(8),
          network: meta.network || "",
          address: meta.address || "",
          payoutTxHash: transaction.payoutTxHash,
          createdAt: transaction.createdAt,
        };
      }),
      automatedNetwork: "BEP20",
      senderAddress: config?.senderAddress || null,
      tokenContract: config?.tokenContract || null,
      configurationError,
    });
  } catch (error) { next(error); }
});

router.post("/:id/clear-mistaken-hash", async (req: AuthenticatedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    if (req.body?.confirmNoPayoutSent !== true) {
      return res.status(400).json({ error: "Confirm that you did not send a payout for this order before clearing its hash" });
    }
    const transaction = await prisma.transaction.findUnique({ where: { id } });
    if (!transaction || transaction.type !== "WITHDRAWAL") return res.status(404).json({ error: "Withdrawal request not found" });
    if (transaction.status !== "PENDING" || transaction.externalId) {
      return res.status(409).json({ error: "This withdrawal is no longer pending and its hash cannot be cleared" });
    }
    const attachedHash = transaction.payoutTxHash;
    if (!attachedHash) return res.json({ message: "There is no transaction hash attached to this order" });

    const metadata = readMeta(transaction.description);
    if (["CDP", "TATUM", "TRON_LOCAL"].includes(metadata.payoutMode || "")) {
      return res.status(409).json({ error: "This withdrawal is managed by its automated payout worker and cannot have its hash cleared here." });
    }
    if (metadata.network === "BEP20" && metadata.address && attachedHash.startsWith("BEP20:")) {
      const hash = attachedHash.slice("BEP20:".length);
      try {
        const verified = await verifyUsdtTransfer("BEP20", hash, undefined, "OUT", metadata.address);
        const terms = recordedWithdrawalTerms(transaction.amount, transaction.description);
        if (verified.amount.eq(terms.netAmount)) {
          return res.status(409).json({ error: "This hash is a confirmed matching payout. It cannot be cleared." });
        }
        return res.status(409).json({ error: "This hash shows a transfer to the requested address, but the amount differs. Keep it attached and review the transfer before sending anything else." });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not inspect the attached transaction";
        if (message.startsWith("Transaction needs") || message.startsWith("Chain RPC returned HTTP 429") || message.startsWith("Chain RPC returned HTTP 5") || message.startsWith("Chain RPC error:")) {
          return res.status(409).json({ error: "This transaction is still confirming or the chain verifier is unavailable. Keep it attached and try again later." });
        }
        if (message === "Transaction is not mined yet" && req.body?.confirmNoPayoutSent !== true) {
          return res.status(409).json({ error: "This transaction is not mined yet. Do not clear it if you sent the payout." });
        }
        // Confirmed failed transactions and hashes without the expected outgoing USDT transfer
        // can be detached; a hash alone never completes or credits a withdrawal.
        if (message !== "Transaction is not mined yet" && message !== "On-chain transaction failed" && message !== "Transaction does not contain the expected USDT transfer") {
          return res.status(409).json({ error: `Could not safely clear this hash: ${message}` });
        }
      }
    }

    const cleared = await prisma.transaction.updateMany({
      where: { id, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: attachedHash },
      data: { payoutTxHash: null },
    });
    if (cleared.count !== 1) return res.status(409).json({ error: "The withdrawal changed while the hash was being cleared. Refresh the orders page." });
    return res.json({ message: "Mistaken hash cleared. You can enter the correct transaction hash now." });
  } catch (error) { next(error); }
});

router.post("/:id/broadcasted", async (req: AuthenticatedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const txHash = String(req.body?.txHash || "").trim().toLowerCase();
    if (!/^0x[a-f0-9]{64}$/.test(txHash)) return res.status(400).json({ error: "Trust Wallet did not return a valid BNB Smart Chain transaction hash" });
    const transaction = await prisma.transaction.findUnique({ where: { id } });
    if (!transaction || transaction.type !== "WITHDRAWAL") return res.status(404).json({ error: "Withdrawal request not found" });
    if (transaction.status === "COMPLETED") return res.json({ message: "Withdrawal was already completed", transaction });
    if (transaction.status !== "PENDING") return res.status(400).json({ error: `Withdrawal cannot be processed from status ${transaction.status}` });
    const metadata = readMeta(transaction.description);
    if (["CDP", "TATUM", "TRON_LOCAL"].includes(metadata.payoutMode || "")) {
      return res.status(409).json({ error: "This withdrawal is assigned to its automated payout worker. Do not submit a second transfer manually." });
    }
    if (metadata.network !== "BEP20" || !metadata.address) {
      return res.status(400).json({ error: "This automated Trust Wallet flow currently supports BNB Smart Chain withdrawals only" });
    }
    payoutConfig();

    const claimedHash = `BEP20:${txHash}`;
    const priorHash = transaction.payoutTxHash;
    const terms = recordedWithdrawalTerms(transaction.amount, transaction.description);
    let verified: Awaited<ReturnType<typeof verifyUsdtTransfer>> | undefined;

    // A mistyped hash can still be a real transfer to the recipient for a different
    // amount. Keep it in the audit trail, but allow a replacement only after the new
    // hash independently proves the exact requested payout on chain.
    if (priorHash && priorHash !== claimedHash) {
      if (priorHash.startsWith("BEP20:")) {
        try {
          const previous = await verifyUsdtTransfer("BEP20", priorHash.slice("BEP20:".length), undefined, "OUT", metadata.address);
          if (previous.amount.eq(terms.netAmount)) {
            return res.status(409).json({ error: "The attached hash already verifies as the requested payout. It cannot be replaced." });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Could not inspect the attached transaction";
          if (message === "Transaction is not mined yet" || message.startsWith("Transaction needs") || message.startsWith("Chain RPC returned HTTP 429") || message.startsWith("Chain RPC returned HTTP 5") || message.startsWith("Chain RPC error:")) {
            return res.status(409).json({ error: "The attached transaction is still confirming or the chain verifier is unavailable. Keep it attached and try again later." });
          }
          if (message !== "On-chain transaction failed" && message !== "Transaction does not contain the expected USDT transfer") {
            return res.status(409).json({ error: `Could not safely replace the attached hash: ${message}` });
          }
        }
      }

      try {
        verified = await verifyUsdtTransfer("BEP20", txHash, undefined, "OUT", metadata.address);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not verify the payout transaction";
        if (message === "Transaction is not mined yet" || message.startsWith("Transaction needs")) {
          return res.status(202).json({ message: "Replacement transfer is not fully confirmed yet. The existing hash remains attached; check this hash again after confirmation.", payoutTxHash: priorHash, status: "PENDING" });
        }
        if (message.startsWith("Chain RPC returned HTTP 429") || message.startsWith("Chain RPC returned HTTP 5") || message.startsWith("Chain RPC error:")) {
          return res.status(503).json({ error: "The network verifier is temporarily unavailable. The existing hash remains attached; try again shortly." });
        }
        return res.status(400).json({ error: message });
      }
      if (!verified.amount.eq(terms.netAmount)) {
        return res.status(409).json({ error: `The replacement transfer is ${verified.amount.toFixed(8)} USDT; this order requires exactly ${terms.netAmount.toFixed(8)} USDT. The existing hash remains attached.` });
      }

      try {
        const replaced = await prisma.transaction.updateMany({
          where: { id, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: priorHash },
          data: {
            payoutTxHash: claimedHash,
            description: withPayoutHashAudit(transaction.description, {
              hash: priorHash,
              replacedBy: claimedHash,
              replacedAt: new Date().toISOString(),
              reason: "Superseded by a separately verified matching payout hash",
            }),
          },
        });
        if (replaced.count !== 1) return res.status(409).json({ error: "The withdrawal changed while correcting its hash. Refresh the orders page." });
      } catch (error) {
        if (error instanceof Error && error.message.includes("Unique constraint")) return res.status(409).json({ error: "This transaction hash has already been attached to another payout" });
        throw error;
      }
    } else if (!priorHash) {
      try {
        const saved = await prisma.transaction.updateMany({
          where: { id, type: "WITHDRAWAL", status: "PENDING", payoutTxHash: null },
          data: { payoutTxHash: claimedHash },
        });
        if (saved.count !== 1) {
          const latest = await prisma.transaction.findUnique({ where: { id } });
          if (latest?.payoutTxHash !== claimedHash) return res.status(409).json({ error: "A payout is already being processed. Do not send another transfer." });
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("Unique constraint")) return res.status(409).json({ error: "This transaction hash is already attached to another payout" });
        throw error;
      }
    }

    if (!verified) {
      try {
        verified = await verifyUsdtTransfer("BEP20", txHash, undefined, "OUT", metadata.address);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not verify the payout transaction";
        if (message === "Transaction is not mined yet" || message.startsWith("Transaction needs")) {
          return res.status(202).json({ message: "Transfer submitted from Trust Wallet. Waiting for network confirmations.", payoutTxHash: txHash, status: "PENDING" });
        }
        if (message.startsWith("Chain RPC returned HTTP 429") || message.startsWith("Chain RPC returned HTTP 5")) {
          return res.status(503).json({ error: "The network verifier is temporarily busy. The transaction hash is saved; try checking it again shortly.", payoutTxHash: txHash });
        }
        return res.status(400).json({ error: message, payoutTxHash: txHash });
      }
    }

    if (!verified.amount.eq(terms.netAmount)) {
      return res.status(409).json({ error: `The on-chain payout amount (${verified.amount.toFixed(8)} USDT) does not match the requested net amount (${terms.netAmount.toFixed(8)} USDT). The transaction is recorded for review; do not resend.`, payoutTxHash: txHash });
    }

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.transaction.findUnique({ where: { id } });
      if (!current) throw new Error("Withdrawal request not found");
      if (current.status === "COMPLETED") return { transaction: current, alreadyCompleted: true };
      if (current.status !== "PENDING" || current.payoutTxHash !== claimedHash) throw new Error("Withdrawal request changed while the transfer was being verified");

      await lockWalletForSpending(tx, current.userId);
      const wallet = await tx.wallet.findUnique({ where: { userId: current.userId }, include: { ledgerEntries: true } });
      if (!wallet) throw new Error("Wallet not found while completing payout");
      const balance = sumMoney(wallet.ledgerEntries.map((entry) => entry.amount));
      const otherPending = await tx.transaction.findMany({
        where: { userId: current.userId, type: "WITHDRAWAL", status: "PENDING", id: { not: id } },
        select: { amount: true },
      });
      const available = balance.minus(sumMoney(otherPending.map((item) => item.amount)));
      if (current.amount.gt(available)) throw new Error(`Insufficient available balance. Available: ${nonNegativeMoney(available).toFixed(2)} USDT`);

      const claimed = await tx.transaction.updateMany({
        where: { id, status: "PENDING", payoutTxHash: claimedHash, externalId: null },
        data: { status: "COMPLETED", externalId: claimedHash },
      });
      if (claimed.count !== 1) {
        const latest = await tx.transaction.findUnique({ where: { id } });
        if (latest?.status === "COMPLETED") return { transaction: latest, alreadyCompleted: true };
        throw new Error("Withdrawal request changed while completing payout");
      }
      const updated = await tx.transaction.findUniqueOrThrow({ where: { id } });
      await tx.ledgerEntry.create({ data: { walletId: wallet.id, transactionId: id, amount: current.amount.negated(), asset: current.asset } });
      const payoutTerms = recordedWithdrawalTerms(current.amount, current.description);
      await tx.notification.create({
        data: {
          userId: current.userId,
          title: "Withdrawal completed",
          body: `${payoutTerms.netAmount.toFixed(8)} USDT payout completed on BNB Smart Chain. ${payoutTerms.feeAmount.toFixed(8)} USDT fee; ${current.amount.toFixed(8)} USDT debited.`,
          kind: "TRANSACTION",
        },
      });
      return { transaction: updated, alreadyCompleted: false };
    });

    return res.json({ message: result.alreadyCompleted ? "Withdrawal was already completed" : "Withdrawal verified and completed", transaction: result.transaction, confirmations: verified.confirmations });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not process payout";
    if (message.includes("not configured")) return res.status(503).json({ error: message });
    if (message.includes("Unique constraint")) return res.status(409).json({ error: "This transaction hash has already been used" });
    if (message === "Withdrawal request not found") return res.status(404).json({ error: message });
    if (message.startsWith("Withdrawal request changed") || message.startsWith("Insufficient available balance")) return res.status(409).json({ error: message });
    next(error);
  }
});

export default router;
