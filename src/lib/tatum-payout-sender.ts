import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "./prisma.js";
import { getDepositMonitorConfig, validateWithdrawalAddress } from "./chain-verification.js";
import { recordedWithdrawalTerms } from "./withdrawal-fee.js";

const SCALE = new Prisma.Decimal("1000000000000000000");
const INTERVAL_MS = 15_000;
const ADVISORY_LOCK_NAMESPACE = 735_202;
const TATUM_API = "https://api.tatum.io";
let scanInProgress = false;

type TatumPayout = {
  state?: "PREPARING" | "SUBMITTING" | "SUBMITTED" | "LIMIT_BLOCKED";
  reason?: string;
  reservedDate?: string;
  reservedAmount?: string;
  startedAt?: string;
  requestId?: string;
  transactionHash?: string;
  signatureId?: string;
};
type WithdrawalMeta = { network?: string; address?: string; payoutMode?: string; tatumPayout?: TatumPayout; [key: string]: unknown };

function parseMeta(description: string | null): WithdrawalMeta {
  try {
    const parsed = JSON.parse(description || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function config() {
  if (process.env.PAYOUT_AUTOMATION_ENABLED?.trim().toLowerCase() !== "true") return null;
  const apiKey = process.env.TATUM_API_KEY?.trim();
  const signatureId = process.env.TATUM_KMS_SIGNATURE_ID?.trim();
  const walletAddress = process.env.TATUM_PAYOUT_WALLET_ADDRESS?.trim();
  const maxSingle = process.env.PAYOUT_MAX_SINGLE_USDT?.trim();
  const dailyLimit = process.env.PAYOUT_DAILY_LIMIT_USDT?.trim();
  const chain = getDepositMonitorConfig("BEP20");
  if (!apiKey || !signatureId || !walletAddress || !maxSingle || !dailyLimit || !chain) {
    throw new Error("Tatum payout automation is enabled but the API key, KMS signature ID, payout address, limits, or BNB chain configuration is missing");
  }
  if (validateWithdrawalAddress(walletAddress, "BEP20") || validateWithdrawalAddress(chain.tokenAddress, "BEP20")) {
    throw new Error("Tatum payout wallet or configured BNB USDT contract address is invalid");
  }
  if (process.env.BSC_SEND_ADDRESS?.trim().toLowerCase() !== walletAddress.toLowerCase()) {
    throw new Error("BSC_SEND_ADDRESS must exactly match TATUM_PAYOUT_WALLET_ADDRESS so chain monitoring can verify payouts");
  }
  const maxSingleAmount = new Prisma.Decimal(maxSingle);
  const dailyLimitAmount = new Prisma.Decimal(dailyLimit);
  if (!maxSingleAmount.isFinite() || !dailyLimitAmount.isFinite() || maxSingleAmount.lte(0) || dailyLimitAmount.lte(0)) {
    throw new Error("Tatum payout limits must be positive USDT amounts");
  }
  return { apiKey, signatureId, walletAddress, maxSingleAmount, dailyLimitAmount, chain };
}

async function tatumRequest(path: string, init: RequestInit = {}) {
  const settings = config();
  if (!settings) throw new Error("Tatum payout automation is disabled");
  const response = await fetch(`${TATUM_API}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* report status only below */ }
  if (!response.ok) throw new Error(`Tatum API returned HTTP ${response.status}${typeof body.message === "string" ? `: ${body.message}` : ""}`);
  return body;
}

async function rpc(url: string, method: string, params: unknown[]) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`BNB RPC returned HTTP ${response.status}`);
  const result = await response.json() as { result?: string; error?: { message?: string } };
  if (result.error || typeof result.result !== "string") throw new Error(`BNB RPC error: ${result.error?.message || "invalid response"}`);
  return result.result;
}

function amountUnits(amount: Prisma.Decimal): bigint { return BigInt(amount.mul(SCALE).toFixed(0)); }

function encodeTransfer(recipient: string, amount: Prisma.Decimal): `0x${string}` {
  const address = recipient.slice(2).toLowerCase().padStart(64, "0");
  const units = amountUnits(amount).toString(16).padStart(64, "0");
  return `0xa9059cbb${address}${units}`;
}

async function assertFunded(settings: NonNullable<ReturnType<typeof config>>, recipient: string, amount: Prisma.Decimal) {
  const tokenBalanceHex = await rpc(settings.chain.rpcUrl, "eth_call", [{
    to: settings.chain.tokenAddress,
    data: `0x70a08231${settings.walletAddress.slice(2).toLowerCase().padStart(64, "0")}`,
  }, "latest"]);
  if (BigInt(tokenBalanceHex) < amountUnits(amount)) throw new Error("Tatum payout wallet does not have enough BNB Smart Chain USDT for this withdrawal");
  const [gasHex, gasPriceHex, nativeBalanceHex] = await Promise.all([
    rpc(settings.chain.rpcUrl, "eth_estimateGas", [{ from: settings.walletAddress, to: settings.chain.tokenAddress, data: encodeTransfer(recipient, amount), value: "0x0" }]),
    rpc(settings.chain.rpcUrl, "eth_gasPrice", []),
    rpc(settings.chain.rpcUrl, "eth_getBalance", [settings.walletAddress, "latest"]),
  ]);
  if (BigInt(nativeBalanceHex) < BigInt(gasHex) * BigInt(gasPriceHex)) throw new Error("Tatum payout wallet needs more BNB to cover the estimated network fee");
}

async function reserve(request: { id: string; amount: Prisma.Decimal; description: string | null }, amount: Prisma.Decimal, settings: NonNullable<ReturnType<typeof config>>) {
  const today = new Date().toISOString().slice(0, 10);
  return prisma.$transaction(async (tx) => {
    // PostgreSQL advisory locks return `void`, which Prisma's PostgreSQL adapter
    // cannot deserialize as a query result. Keep the lock call in a subquery and
    // return a supported scalar instead.
    await tx.$queryRaw<Array<{ locked: number }>>`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, 1)) AS payout_lock`;
    const current = await tx.transaction.findUnique({ where: { id: request.id } });
    if (!current || current.type !== "WITHDRAWAL" || current.status !== "PENDING" || current.externalId || current.payoutTxHash) return null;
    const meta = parseMeta(current.description);
    if (meta.network !== "BEP20" || meta.payoutMode !== "TATUM" || typeof meta.address !== "string") return null;
    const prior = meta.tatumPayout;
    // Tatum's transaction-create endpoint has no idempotency key. Never repeat a
    // request after it entered SUBMITTING: a lost HTTP response could hide a real payout.
    if (prior?.state === "SUBMITTING" || prior?.state === "SUBMITTED" || prior?.state === "LIMIT_BLOCKED") return null;
    if (prior?.state === "PREPARING") return { metadata: meta, recipient: meta.address, netAmount: amount };

    const reservations = await tx.transaction.findMany({ where: { type: "WITHDRAWAL", description: { not: null } }, select: { description: true } });
    const usedToday = reservations.reduce((sum, row) => {
      const payout = parseMeta(row.description).tatumPayout;
      return payout?.reservedDate === today && payout.reservedAmount ? sum.plus(payout.reservedAmount) : sum;
    }, new Prisma.Decimal(0));
    if (amount.gt(settings.maxSingleAmount) || usedToday.plus(amount).gt(settings.dailyLimitAmount)) {
      const reason = amount.gt(settings.maxSingleAmount) ? "PER_WITHDRAWAL_LIMIT" : "DAILY_LIMIT";
      await tx.transaction.updateMany({
        where: { id: current.id, type: "WITHDRAWAL", status: "PENDING", payoutTxHash: null, description: current.description },
        data: { description: JSON.stringify({ ...meta, tatumPayout: { state: "LIMIT_BLOCKED", reason } }) },
      });
      return null;
    }
    const nextMeta: WithdrawalMeta = {
      ...meta,
      tatumPayout: { state: "PREPARING", reservedDate: today, reservedAmount: amount.toFixed(8), signatureId: settings.signatureId },
    };
    const claimed = await tx.transaction.updateMany({
      where: { id: current.id, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: null, description: current.description },
      data: { description: JSON.stringify(nextMeta) },
    });
    if (claimed.count !== 1) return null;
    return { metadata: nextMeta, recipient: meta.address, netAmount: amount };
  });
}

async function saveHash(requestId: string, metadata: WithdrawalMeta, hash: string) {
  const normalized = hash.toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(normalized)) return;
  const nextMeta = { ...metadata, tatumPayout: { ...metadata.tatumPayout, state: "SUBMITTED" as const, transactionHash: normalized } };
  const value = `BEP20:${normalized}`;
  const updated = await prisma.transaction.updateMany({
    where: { id: requestId, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: null },
    data: { payoutTxHash: value, description: JSON.stringify(nextMeta) },
  });
  if (updated.count !== 1) {
    const latest = await prisma.transaction.findUnique({ where: { id: requestId }, select: { payoutTxHash: true } });
    if (latest?.payoutTxHash !== value) throw new Error(`Tatum broadcasted payout ${requestId}, but its hash could not be recorded; do not submit another payout until reconciled`);
  }
  console.info(`Tatum submitted BEP20 withdrawal ${requestId} (${normalized}); ledger completion waits for chain confirmation.`);
}

async function syncSubmitted(request: { id: string; description: string | null }) {
  const metadata = parseMeta(request.description);
  const payout = metadata.tatumPayout;
  if (metadata.payoutMode !== "TATUM" || payout?.state !== "SUBMITTED" || !payout.requestId || payout.transactionHash) return;
  const status = await tatumRequest(`/v3/kms/${encodeURIComponent(payout.requestId)}`);
  const hash = typeof status.txId === "string" ? status.txId : typeof status.transactionId === "string" ? status.transactionId : "";
  if (hash) {
    await saveHash(request.id, metadata, hash);
    return;
  }
  const state = typeof status.status === "string" ? status.status : "not provided";
  console.info(`Tatum payout ${request.id} is still awaiting KMS/on-chain submission (KMS status: ${state}; transaction hash: not assigned).`);
}

async function processOne(request: { id: string; amount: Prisma.Decimal; description: string | null }, settings: NonNullable<ReturnType<typeof config>>) {
  const metadata = parseMeta(request.description);
  if (metadata.network !== "BEP20" || metadata.payoutMode !== "TATUM" || typeof metadata.address !== "string") return;
  const terms = recordedWithdrawalTerms(request.amount, request.description);
  if (terms.netAmount.lte(0)) return;
  const submission = await reserve(request, terms.netAmount, settings);
  if (!submission) return;
  await assertFunded(settings, submission.recipient, submission.netAmount);

  const submittingMeta: WithdrawalMeta = {
    ...submission.metadata,
    tatumPayout: { ...submission.metadata.tatumPayout, state: "SUBMITTING", startedAt: new Date().toISOString() },
  };
  const claimed = await prisma.transaction.updateMany({
    where: { id: request.id, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: null, description: JSON.stringify(submission.metadata) },
    data: { description: JSON.stringify(submittingMeta) },
  });
  if (claimed.count !== 1) return;

  const response = await tatumRequest("/v3/bsc/transaction", {
    method: "POST",
    body: JSON.stringify({ currency: "USDT_BSC", to: submission.recipient, amount: submission.netAmount.toFixed(8), signatureId: settings.signatureId, index: 0 }),
  });
  const requestId = typeof response.id === "string" ? response.id : typeof response.signatureId === "string" ? response.signatureId : "";
  if (!/^[a-f0-9]{24}$/i.test(requestId)) {
    throw new Error("Tatum accepted the payout request but did not return a recognizable KMS transaction ID; automatic retries are paused for safety");
  }
  const submittedMeta: WithdrawalMeta = {
    ...submittingMeta,
    tatumPayout: { ...submittingMeta.tatumPayout, state: "SUBMITTED", requestId },
  };
  const saved = await prisma.transaction.updateMany({
    where: { id: request.id, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: null },
    data: { description: JSON.stringify(submittedMeta) },
  });
  if (saved.count !== 1) throw new Error(`Tatum queued withdrawal ${request.id}, but its KMS request ID was not saved; do not submit another payout`);
}

async function scan() {
  if (scanInProgress) return;
  scanInProgress = true;
  try {
    const settings = config();
    if (!settings) return;
    const requests = await prisma.transaction.findMany({
      where: { type: "WITHDRAWAL", status: "PENDING", externalId: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, amount: true, description: true, payoutTxHash: true },
    });
    const unresolved = requests.filter((row) => {
      const meta = parseMeta(row.description);
      return meta.payoutMode === "TATUM" && ["SUBMITTING", "SUBMITTED"].includes(meta.tatumPayout?.state || "");
    });
    for (const row of unresolved) {
      if (row.payoutTxHash || parseMeta(row.description).tatumPayout?.state !== "SUBMITTED") continue;
      try { await syncSubmitted(row); }
      catch (error) { console.error(`Could not sync Tatum payout ${row.id}:`, error); }
    }
    if (unresolved.length) return;
    const next = requests.find((row) => {
      const meta = parseMeta(row.description);
      return meta.payoutMode === "TATUM" && (!meta.tatumPayout || meta.tatumPayout.state === "PREPARING");
    });
    if (next) {
      try { await processOne(next, settings); }
      catch (error) { console.error(`Tatum payout ${next.id} was not submitted or needs reconciliation:`, error); }
    }
  } catch (error) {
    console.error("Tatum payout worker is not ready:", error);
  } finally { scanInProgress = false; }
}

export async function authorizeTatumKmsRequest(requestId: string): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/i.test(requestId) || !config()) return false;
  const rows = await prisma.transaction.findMany({
    where: { type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: null, description: { contains: requestId } },
    select: { amount: true, description: true },
  });
  const settings = config();
  if (!settings) return false;
  return rows.some((row) => {
    const meta = parseMeta(row.description);
    const payout = meta.tatumPayout;
    if (meta.payoutMode !== "TATUM" || meta.network !== "BEP20" || payout?.state !== "SUBMITTED" || payout.requestId !== requestId) return false;
    if (payout.signatureId !== settings.signatureId || typeof meta.address !== "string" || validateWithdrawalAddress(meta.address, "BEP20")) return false;
    const terms = recordedWithdrawalTerms(row.amount, row.description);
    return terms.netAmount.gt(0) && terms.netAmount.lte(settings.maxSingleAmount) && payout.reservedAmount === terms.netAmount.toFixed(8);
  });
}

export function startTatumPayoutSender() {
  if (process.env.PAYOUT_AUTOMATION_ENABLED?.trim().toLowerCase() !== "true") return;
  try { config(); }
  catch (error) {
    console.error("Tatum payout automation remains inactive:", error instanceof Error ? error.message : "configuration error");
    return;
  }
  void scan();
  const timer = setInterval(() => void scan(), INTERVAL_MS);
  timer.unref();
}
