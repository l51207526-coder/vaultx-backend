import { prisma } from "./prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { randomUUID } from "node:crypto";
import { DEPOSIT_REQUEST_TTL_MS, isWithinDepositWindow } from "./deposit-expiry.js";
import {
  getDepositMonitorConfig,
  SUPPORTED_NETWORKS,
  topicAddress,
  TRANSFER_TOPIC,
  verifyUsdtTransfer,
  type SupportedNetwork,
} from "./chain-verification.js";
import { listDepositAddresses } from "./deposit-addresses.js";

const SCAN_INTERVAL_MS = Math.max(10_000, Number(process.env.DEPOSIT_SCAN_INTERVAL_MS || "30000"));
// Alchemy's free BNB endpoint supports eth_getLogs ranges of up to 10 blocks.
const EVM_SCAN_CHUNK_SIZE = 10n;
const TRON_CURSOR_OVERLAP_MS = 120_000n;
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

export async function creditVerifiedDeposit(
  transactionId: string,
  userId: string,
  network: SupportedNetwork,
  hash: string,
  blockTime: Date,
  actualAmount: Prisma.Decimal,
  recipient: string,
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const request = await tx.transaction.findFirst({
        where: { id: transactionId, userId, type: "DEPOSIT", externalId: null },
      });
      if (!request || !["PENDING", "FAILED"].includes(request.status)) return false;
      if (!isWithinDepositWindow(request.createdAt, blockTime)) return false;
      if (!actualAmount.gt(0)) return false;

      const claimed = await tx.transaction.updateMany({
        where: { id: transactionId, userId, type: "DEPOSIT", status: request.status, externalId: null },
        data: { status: "COMPLETED", amount: actualAmount, externalId: `${network}:${hash.toLowerCase()}:${recipient}` },
      });
      if (claimed.count !== 1) return false;

      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) throw new Error("Wallet not found while crediting verified deposit");
      const transaction = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      await tx.ledgerEntry.create({
        data: {
          walletId: wallet.id,
          transactionId,
          amount: transaction.amount,
          asset: transaction.asset,
        },
      });
      await tx.notification.create({
        data: {
          userId,
          title: "Deposit verified",
          body: `${transaction.amount.toString()} USDT was verified on ${network} and credited.`,
          kind: "TRANSACTION",
        },
      });
      return true;
    });
  } catch (error) {
    // The unique externalId constraint is the final protection against one chain transfer
    // being credited to more than one request, including when multiple server instances scan.
    if (error instanceof Error && error.message.includes("Unique constraint")) return false;
    throw error;
  }
}

async function creditIncomingDeposit(userId: string, network: SupportedNetwork, hash: string, blockTime: Date, actualAmount: Prisma.Decimal, recipient: string) {
  const externalId = `${network}:${hash.toLowerCase()}:${recipient}`;
  try {
    return await prisma.$transaction(async (tx) => {
      if (await tx.transaction.findUnique({ where: { externalId } })) return false;
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) return false;
      const transaction = await tx.transaction.create({
        data: {
          userId,
          type: "DEPOSIT",
          status: "COMPLETED",
          amount: actualAmount,
          asset: "USDT",
          reference: `DEP-${randomUUID()}`,
          externalId,
          description: JSON.stringify({ kind: "deposit", network, depositAddress: recipient, automatic: true }),
          createdAt: blockTime,
        },
      });
      await tx.ledgerEntry.create({ data: { walletId: wallet.id, transactionId: transaction.id, amount: actualAmount, asset: "USDT" } });
      await tx.notification.create({
        data: { userId, title: "Deposit verified", body: `${actualAmount.toString()} USDT was verified on ${network} and credited.`, kind: "TRANSACTION" },
      });
      return true;
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) return false;
    throw error;
  }
}

async function matchAndCreditTransfer(network: SupportedNetwork, hash: string, blockTime: Date, recipient: string) {
  const addressRecord = await prisma.depositAddress.findUnique({ where: { network_address: { network, address: recipient } } });
  if (!addressRecord) return false;
  const requests = await prisma.transaction.findMany({
    where: {
      userId: addressRecord.userId,
      type: "DEPOSIT",
      status: { in: ["PENDING", "FAILED"] },
      externalId: null,
      createdAt: {
        gte: new Date(blockTime.getTime() - DEPOSIT_REQUEST_TTL_MS),
        lte: blockTime,
      },
    },
    select: { id: true, userId: true, description: true },
    orderBy: { createdAt: "asc" },
  });
  let verified: Awaited<ReturnType<typeof verifyUsdtTransfer>>;
  try {
    verified = await verifyUsdtTransfer(network, hash, undefined, "IN", undefined, recipient);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/RPC returned|RPC error|fetch failed|timed out|network error/i.test(message)) throw error;
    return false;
  }

  const matchingRequests = requests.filter((request) => {
    try {
      const metadata = JSON.parse(request.description || "{}");
      return metadata.network === network && (!metadata.depositAddress || metadata.depositAddress === recipient);
    } catch { return false; }
  });
  if (matchingRequests.length > 0) {
    return creditVerifiedDeposit(matchingRequests[0].id, addressRecord.userId, network, hash, verified.blockTime, verified.amount, recipient);
  }
  return creditIncomingDeposit(addressRecord.userId, network, hash, verified.blockTime, verified.amount, recipient);
}

async function scanEvmNetwork(network: SupportedNetwork) {
  const config = getDepositMonitorConfig(network);
  if (!config || network === "TRC20") return;

  const head = BigInt(await rpc(config.rpcUrl, "eth_blockNumber", []));
  const safeHead = head - config.minimumConfirmations + 1n;
  if (safeHead < 0n) return;

  let state = await prisma.chainScanCursor.findUnique({ where: { network } });
  if (!state) {
    // Start from now so old transfers to a reused address can never satisfy a new request.
    state = await prisma.chainScanCursor.create({
      data: { network, cursor: (safeHead + 1n).toString() },
    });
    return;
  }

  let nextBlock = BigInt(state.cursor);
  const addresses = await listDepositAddresses(network);
  while (nextBlock <= safeHead) {
    const toBlock = nextBlock + EVM_SCAN_CHUNK_SIZE - 1n < safeHead
      ? nextBlock + EVM_SCAN_CHUNK_SIZE - 1n
      : safeHead;
    const uniqueLogs = new Map<string, { hash: string; blockNumber: string; recipient: string }>();
    for (let offset = 0; offset < addresses.length; offset += 100) {
      const recipients = addresses.slice(offset, offset + 100);
      const logs = await rpc(config.rpcUrl, "eth_getLogs", [{
        fromBlock: `0x${nextBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        address: config.tokenAddress,
        topics: [TRANSFER_TOPIC, null, recipients.map((entry) => topicAddress(entry.address))],
      }]) as Array<{ transactionHash?: string; blockNumber?: string; topics?: string[] }>;
      for (const log of logs || []) {
        if (!log.transactionHash || !log.blockNumber || !log.topics?.[2]) continue;
        const recipient = `0x${log.topics[2].slice(-40)}`.toLowerCase();
        uniqueLogs.set(`${log.transactionHash.toLowerCase()}:${recipient}`, { hash: log.transactionHash.toLowerCase(), blockNumber: log.blockNumber, recipient });
      }
    }

    const blockTimes = new Map<string, Date>();
    for (const { hash, blockNumber, recipient } of uniqueLogs.values()) {
      let blockTime = blockTimes.get(blockNumber);
      if (!blockTime) {
        const block = await rpc(config.rpcUrl, "eth_getBlockByNumber", [blockNumber, false]);
        if (!block?.timestamp) throw new Error("Chain RPC did not return the transfer block timestamp");
        blockTime = new Date(Number(BigInt(block.timestamp)) * 1000);
        blockTimes.set(blockNumber, blockTime);
      }
      await matchAndCreditTransfer(network, hash, blockTime, recipient);
    }

    const nextCursor = (toBlock + 1n).toString();
    await prisma.chainScanCursor.update({ where: { network }, data: { cursor: nextCursor } });
    nextBlock = toBlock + 1n;
  }
}

async function scanTron() {
  const network: SupportedNetwork = "TRC20";
  const config = getDepositMonitorConfig(network);
  if (!config) return;

  let state = await prisma.chainScanCursor.findUnique({ where: { network } });
  if (!state) {
    // Do not inspect historical transfers when enabling the monitor for the first time.
    await prisma.chainScanCursor.create({ data: { network, cursor: Date.now().toString() } });
    return;
  }

  const cursor = BigInt(state.cursor);
  const minTimestamp = cursor > TRON_CURSOR_OVERLAP_MS ? cursor - TRON_CURSOR_OVERLAP_MS : 0n;
  const base = config.rpcUrl.replace(/\/$/, "");
  const addresses = await listDepositAddresses(network);
  const uniqueTransfers = new Map<string, { hash: string; blockTime: Date; recipient: string }>();
  const headers: Record<string, string> = {};
  const apiKey = process.env.TRON_GRID_API_KEY?.trim();
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  for (const address of addresses) {
    let fingerprint: string | undefined;
    let pages = 0;
    do {
      const query = new URLSearchParams({
        only_confirmed: "true", only_to: "true", limit: "200", order_by: "block_timestamp,asc",
        contract_address: config.tokenAddress, min_timestamp: minTimestamp.toString(),
      });
      if (fingerprint) query.set("fingerprint", fingerprint);
      const response = await fetch(`${base}/v1/accounts/${encodeURIComponent(address.address)}/transactions/trc20?${query}`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`TRON history API returned HTTP ${response.status}`);
      const body = await response.json() as {
        data?: Array<{ transaction_id?: string; block_timestamp?: number; to?: string }>;
        meta?: { fingerprint?: string };
      };
      for (const transfer of body.data || []) {
        if (!transfer.transaction_id || !transfer.block_timestamp || transfer.to !== address.address) continue;
        const hash = transfer.transaction_id.toLowerCase();
        uniqueTransfers.set(`${hash}:${transfer.to}`, { hash, blockTime: new Date(transfer.block_timestamp), recipient: transfer.to });
      }
      fingerprint = body.meta?.fingerprint;
      pages += 1;
      if (pages > 100) throw new Error("TRON history scan exceeded the pagination safety limit");
    } while (fingerprint);
  }
  for (const transfer of uniqueTransfers.values()) {
    await matchAndCreditTransfer(network, transfer.hash, transfer.blockTime, transfer.recipient);
  }

  await prisma.chainScanCursor.update({ where: { network }, data: { cursor: Date.now().toString() } });
}

async function scanAllNetworks() {
  if (scanInProgress) return;
  scanInProgress = true;
  try {
    await Promise.all(SUPPORTED_NETWORKS.map(async (network) => {
      try {
        if (network === "TRC20") await scanTron();
        else await scanEvmNetwork(network);
      } catch (error) {
        console.error(`Automatic ${network} deposit scan failed:`, error);
      }
    }));
  } finally {
    scanInProgress = false;
  }
}

export function startAutomaticDepositMonitor() {
  // This VaultX setup uses a shared Trust Wallet address. Automatic matching cannot
  // safely determine which account owns a transfer, so only user-submitted transaction
  // IDs may trigger credits in this mode.
  if ((process.env.DEPOSIT_VERIFICATION_MODE || "manual").trim().toLowerCase() !== "automatic") return;
  void scanAllNetworks();
  const timer = setInterval(() => void scanAllNetworks(), SCAN_INTERVAL_MS);
  timer.unref();
}
