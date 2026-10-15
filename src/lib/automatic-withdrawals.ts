import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "./prisma.js";
import { lockWalletForSpending } from "./wallet-lock.js";
import { nonNegativeMoney, sumMoney } from "./money.js";
import { recordedWithdrawalTerms } from "./withdrawal-fee.js";
import {
  getDepositMonitorConfig,
  topicAddress,
  TRANSFER_TOPIC,
  validateWithdrawalAddress,
  verifyUsdtTransfer,
} from "./chain-verification.js";

const CURSOR_KEY = "BEP20_WITHDRAWAL";
const DECIMAL_SCALE = new Prisma.Decimal("1000000000000000000");
const configuredInterval = Number(process.env.WITHDRAWAL_SCAN_INTERVAL_MS || "15000");
const SCAN_INTERVAL_MS = Number.isFinite(configuredInterval) ? Math.max(10_000, configuredInterval) : 15_000;
const EVM_SCAN_CHUNK_SIZE = 10n;
let scanInProgress = false;

async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Chain RPC returned HTTP ${response.status}`);
  const body = await response.json() as { result?: any; error?: { message?: string } };
  if (body.error) throw new Error(`Chain RPC error: ${body.error.message || "unknown error"}`);
  return body.result;
}

function readMeta(description: string | null): { network?: string; address?: string } {
  try { return JSON.parse(description || "{}"); } catch { return {}; }
}

async function settleWithdrawal(requestId: string, network: "BEP20" | "TRC20", hash: string, recipient: string, verifiedAmount: Prisma.Decimal, blockTime: Date) {
  const claimedHash = `${network}:${hash.toLowerCase()}`;
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await tx.transaction.findUnique({ where: { id: requestId } });
      if (!current || current.type !== "WITHDRAWAL" || current.status !== "PENDING" || current.externalId) return false;
      const meta = readMeta(current.description);
      if (meta.network !== network || meta.address?.toLowerCase() !== recipient.toLowerCase()) return false;
      if (blockTime < current.createdAt) return false;
      if (current.payoutTxHash && current.payoutTxHash !== claimedHash) return false;
      const terms = recordedWithdrawalTerms(current.amount, current.description);
      if (!terms.netAmount.eq(verifiedAmount)) return false;

      if (!current.payoutTxHash) {
        const reserved = await tx.transaction.updateMany({
          where: { id: requestId, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: null },
          data: { payoutTxHash: claimedHash },
        });
        if (reserved.count !== 1) return false;
      }

      await lockWalletForSpending(tx, current.userId);
      const wallet = await tx.wallet.findUnique({ where: { userId: current.userId, }, include: { ledgerEntries: true } });
      if (!wallet) throw new Error("Wallet not found while completing payout");
      const balance = sumMoney(wallet.ledgerEntries.map((entry) => entry.amount));
      const otherPending = await tx.transaction.findMany({
        where: { userId: current.userId, type: "WITHDRAWAL", status: "PENDING", id: { not: requestId } },
        select: { amount: true },
      });
      const available = sumMoney([balance, sumMoney(otherPending.map((item) => item.amount)).negated()]);
      if (current.amount.gt(available)) throw new Error(`Insufficient available balance. Available: ${nonNegativeMoney(available).toFixed(2)} USDT`);

      const completed = await tx.transaction.updateMany({
        where: { id: requestId, type: "WITHDRAWAL", status: "PENDING", payoutTxHash: claimedHash, externalId: null },
        data: { status: "COMPLETED", externalId: claimedHash },
      });
      if (completed.count !== 1) return false;
      const updated = await tx.transaction.findUniqueOrThrow({ where: { id: requestId } });
      await tx.ledgerEntry.create({
        data: { walletId: wallet.id, transactionId: requestId, amount: current.amount.negated(), asset: current.asset },
      });
      await tx.notification.create({
        data: {
          userId: current.userId,
          title: "Withdrawal completed",
          body: `${terms.netAmount.toFixed(8)} USDT payout confirmed on ${network === "TRC20" ? "TRON" : "BNB Smart Chain"}. ${terms.feeAmount.toFixed(8)} USDT fee; ${current.amount.toFixed(8)} USDT debited.`,
          kind: "TRANSACTION",
        },
      });
      return updated.id;
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) return false;
    throw error;
  }
}

async function matchOutgoingTransfer(hash: string, recipient: string, blockNumber: string, rawUnits: bigint, blockTime: Date) {
  const amountFromLog = new Prisma.Decimal(rawUnits.toString()).div(DECIMAL_SCALE);
  const requests = await prisma.transaction.findMany({
    where: { type: "WITHDRAWAL", status: "PENDING", externalId: null },
    select: { id: true, userId: true, amount: true, description: true, payoutTxHash: true, createdAt: true },
  });
  const candidates = requests.filter((request) => {
    const metadata = readMeta(request.description);
    if (metadata.network !== "BEP20" || metadata.address?.toLowerCase() !== recipient.toLowerCase()) return false;
    if (request.createdAt > blockTime) return false;
    if (request.payoutTxHash && request.payoutTxHash !== `BEP20:${hash.toLowerCase()}`) return false;
    return recordedWithdrawalTerms(request.amount, request.description).netAmount.eq(amountFromLog);
  });
  // Same recipient and amount can legitimately belong to two pending requests. Never guess.
  if (candidates.length !== 1) return;

  const verified = await verifyUsdtTransfer("BEP20", hash, undefined, "OUT", recipient);
  if (!verified.amount.eq(amountFromLog) || verified.blockTime.getTime() !== blockTime.getTime()) return;
  const settledId = await settleWithdrawal(candidates[0].id, "BEP20", hash, recipient, verified.amount, verified.blockTime);
  if (settledId) console.info(`Automatic BEP20 withdrawal verified and settled (${settledId}) at block ${blockNumber}.`);
}

async function scanTronPayoutHashes() {
  if (process.env.TRON_PAYOUT_AUTOMATION_ENABLED?.trim().toLowerCase() !== "true") return;
  const pending = await prisma.transaction.findMany({
    where: { type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: { startsWith: "TRC20:" } },
    select: { id: true, userId: true, amount: true, description: true, payoutTxHash: true, createdAt: true },
  });
  for (const request of pending) {
    const meta = readMeta(request.description);
    if (meta.network !== "TRC20" || meta.address === undefined) continue;
    const hash = request.payoutTxHash?.slice("TRC20:".length) || "";
    try {
      const verified = await verifyUsdtTransfer("TRC20", hash, undefined, "OUT", meta.address);
      if (verified.blockTime < request.createdAt) continue;
      const terms = recordedWithdrawalTerms(request.amount, request.description);
      if (!verified.amount.eq(terms.netAmount)) {
        console.error(`TRC20 payout ${request.id} confirmed with an unexpected amount; leaving it pending for review.`);
        continue;
      }
      const settled = await settleWithdrawal(request.id, "TRC20", hash, meta.address, verified.amount, verified.blockTime);
      if (settled) console.info(`Automatic TRC20 withdrawal verified and settled (${settled}).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "TRON transaction verification failed";
      if (message === "On-chain transaction failed") {
        const failed = await prisma.transaction.updateMany({
          where: { id: request.id, type: "WITHDRAWAL", status: "PENDING", payoutTxHash: `TRC20:${hash}`, externalId: null },
          data: { status: "FAILED" },
        });
        if (failed.count === 1) {
          await prisma.notification.create({
            data: { userId: request.userId, title: "Withdrawal failed", body: "The TRC20 transfer failed on the TRON network. No wallet balance was debited; contact support before retrying.", kind: "TRANSACTION" },
          });
        }
      } else if (message !== "Transaction is not confirmed on TRON yet") {
        console.error(`TRC20 payout verification is waiting for a valid chain response (${request.id}):`, message);
      }
    }
  }
}

async function scanBep20Withdrawals() {
  const config = getDepositMonitorConfig("BEP20");
  const configuredSender = process.env.BSC_SEND_ADDRESS?.trim() || process.env.BSC_RECEIVE_ADDRESS?.trim();
  if (!config || !configuredSender) return;
  const senderError = validateWithdrawalAddress(configuredSender, "BEP20");
  if (senderError) throw new Error("Configured BSC payout sender address is invalid");
  const sender = configuredSender.toLowerCase();

  const head = BigInt(await rpc(config.rpcUrl, "eth_blockNumber", []));
  const safeHead = head - config.minimumConfirmations + 1n;
  if (safeHead < 0n) return;

  let state = await prisma.chainScanCursor.findUnique({ where: { network: CURSOR_KEY } });
  if (!state) {
    // Begin at the current confirmed head; previously sent transfers require manual review.
    state = await prisma.chainScanCursor.create({ data: { network: CURSOR_KEY, cursor: (safeHead + 1n).toString() } });
    return;
  }

  let nextBlock = BigInt(state.cursor);
  while (nextBlock <= safeHead) {
    const toBlock = nextBlock + EVM_SCAN_CHUNK_SIZE - 1n < safeHead ? nextBlock + EVM_SCAN_CHUNK_SIZE - 1n : safeHead;
    const logs = await rpc(config.rpcUrl, "eth_getLogs", [{
      fromBlock: `0x${nextBlock.toString(16)}`,
      toBlock: `0x${toBlock.toString(16)}`,
      address: config.tokenAddress,
      topics: [TRANSFER_TOPIC, topicAddress(sender)],
    }]) as Array<{ address?: string; transactionHash?: string; blockNumber?: string; topics?: string[]; data?: string }>;

    const transfers = new Map<string, { hash: string; blockNumber: string; recipient: string; rawUnits: bigint }>();
    for (const log of logs || []) {
      if (!log.address || !log.transactionHash || !log.blockNumber || !log.topics?.[2] || !log.data) continue;
      if (log.address.toLowerCase() !== config.tokenAddress.toLowerCase() || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      const hash = log.transactionHash.toLowerCase();
      const recipient = `0x${log.topics[2].slice(-40)}`.toLowerCase();
      const key = `${hash}:${recipient}`;
      const previous = transfers.get(key);
      transfers.set(key, {
        hash,
        blockNumber: log.blockNumber,
        recipient,
        rawUnits: (previous?.rawUnits || 0n) + BigInt(log.data),
      });
    }

    const blockTimes = new Map<string, Date>();
    for (const transfer of transfers.values()) {
      let blockTime = blockTimes.get(transfer.blockNumber);
      if (!blockTime) {
        const block = await rpc(config.rpcUrl, "eth_getBlockByNumber", [transfer.blockNumber, false]);
        if (!block?.timestamp) throw new Error("Chain RPC did not return the payout block timestamp");
        blockTime = new Date(Number(BigInt(block.timestamp)) * 1000);
        blockTimes.set(transfer.blockNumber, blockTime);
      }
      await matchOutgoingTransfer(transfer.hash, transfer.recipient, transfer.blockNumber, transfer.rawUnits, blockTime);
    }

    const nextCursor = (toBlock + 1n).toString();
    await prisma.chainScanCursor.update({ where: { network: CURSOR_KEY }, data: { cursor: nextCursor } });
    nextBlock = toBlock + 1n;
  }
}

async function scan() {
  if (scanInProgress) return;
  scanInProgress = true;
  try { await scanBep20Withdrawals(); }
  catch (error) { console.error("Automatic BEP20 withdrawal scan failed:", error); }
  try { await scanTronPayoutHashes(); }
  catch (error) { console.error("Automatic TRC20 withdrawal scan failed:", error); }
  finally { scanInProgress = false; }
}

export function startAutomaticWithdrawalMonitor() {
  const enabled = (process.env.WITHDRAWAL_MONITOR_ENABLED || "false").trim().toLowerCase() === "true" ||
    process.env.PAYOUT_AUTOMATION_ENABLED?.trim().toLowerCase() === "true";
  if (!enabled) return;
  void scan();
  const timer = setInterval(() => void scan(), SCAN_INTERVAL_MS);
  timer.unref();
}
