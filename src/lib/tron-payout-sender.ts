import { Prisma } from "../generated/prisma/client.js";
import { TronWeb } from "tronweb";
import { prisma } from "./prisma.js";
import { validateWithdrawalAddress } from "./chain-verification.js";
import { recordedWithdrawalTerms } from "./withdrawal-fee.js";

const TOKEN_SCALE = new Prisma.Decimal("1000000");
const INTERVAL_MS = 15_000;
const ADVISORY_LOCK_NAMESPACE = 735_202;
const TRON_USDT_ABI = [
  { constant: true, inputs: [{ name: "who", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], type: "function" },
];
let scanInProgress = false;
let tronWeb: TronWeb | undefined;

type TronPayoutMeta = {
  state?: "PREPARING" | "PREPARED" | "SUBMITTED" | "LIMIT_BLOCKED";
  reason?: string;
  startedAt?: string;
  preparedAt?: string;
  reservedDate?: string;
  reservedAmount?: string;
  transactionHash?: string;
  unsignedTransaction?: unknown;
};
type WithdrawalMeta = { network?: string; address?: string; payoutMode?: string; tronPayout?: TronPayoutMeta; [key: string]: unknown };

function parseMeta(description: string | null): WithdrawalMeta {
  try {
    const value = JSON.parse(description || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function config() {
  if (process.env.TRON_PAYOUT_AUTOMATION_ENABLED?.trim().toLowerCase() !== "true") return null;
  const rpcUrl = process.env.TRON_RPC_URL?.trim();
  const tokenAddress = process.env.TRON_USDT_CONTRACT?.trim();
  const privateKey = process.env.TRON_PAYOUT_PRIVATE_KEY?.trim().replace(/^0x/i, "");
  const payoutAddress = process.env.TRON_PAYOUT_ADDRESS?.trim();
  const sendAddress = process.env.TRON_SEND_ADDRESS?.trim();
  const maxSingleText = process.env.TRON_PAYOUT_MAX_SINGLE_USDT?.trim();
  const dailyLimitText = process.env.TRON_PAYOUT_DAILY_LIMIT_USDT?.trim();
  const feeLimitText = process.env.TRON_PAYOUT_FEE_LIMIT_TRX?.trim();
  if (!rpcUrl || !tokenAddress || !privateKey || !payoutAddress || !sendAddress || !maxSingleText || !dailyLimitText || !feeLimitText) {
    throw new Error("TRC20 payout automation needs a TRON RPC, USDT contract, dedicated wallet secret/address, send address, positive caps, and TRX fee limit");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(privateKey) || validateWithdrawalAddress(payoutAddress, "TRC20") || validateWithdrawalAddress(sendAddress, "TRC20") || validateWithdrawalAddress(tokenAddress, "TRC20")) {
    throw new Error("TRC20 payout wallet key, address, or token contract is invalid");
  }
  if (payoutAddress !== sendAddress) throw new Error("TRON_SEND_ADDRESS must exactly match TRON_PAYOUT_ADDRESS so the chain verifier checks the signing wallet");
  const derived = TronWeb.address.fromPrivateKey(privateKey);
  if (!derived || derived !== payoutAddress) throw new Error("TRON_PAYOUT_PRIVATE_KEY does not match TRON_PAYOUT_ADDRESS");
  const maxSingle = new Prisma.Decimal(maxSingleText);
  const dailyLimit = new Prisma.Decimal(dailyLimitText);
  const feeLimitTrx = new Prisma.Decimal(feeLimitText);
  if (!maxSingle.isFinite() || !dailyLimit.isFinite() || maxSingle.lte(0) || dailyLimit.lte(0) || !feeLimitTrx.isFinite() || feeLimitTrx.lte(0) || feeLimitTrx.gt(1000)) {
    throw new Error("TRON payout caps must be positive and the TRX fee limit must be between 0 and 1000 TRX");
  }
  return { rpcUrl, tokenAddress, privateKey, payoutAddress, maxSingle, dailyLimit, feeLimitSun: Number(feeLimitTrx.mul("1000000").toFixed(0)) };
}

function getTronWeb(settings: NonNullable<ReturnType<typeof config>>) {
  if (!tronWeb) {
    const apiKey = process.env.TRON_GRID_API_KEY?.trim();
    tronWeb = new TronWeb({
      fullHost: settings.rpcUrl,
      headers: apiKey ? { "TRON-PRO-API-KEY": apiKey } : undefined,
    });
  }
  return tronWeb;
}

function toUnits(amount: Prisma.Decimal) {
  return BigInt(amount.mul(TOKEN_SCALE).toFixed(0));
}

function asBase58(address: string) {
  if (/^(41)?[0-9a-fA-F]{40}$/.test(address)) {
    const hex = address.startsWith("41") ? address : `41${address}`;
    return TronWeb.address.fromHex(hex);
  }
  return address;
}

function verifyUnsignedTransaction(transaction: any, wallet: string, recipient: string, token: string, amount: Prisma.Decimal) {
  const contract = transaction?.raw_data?.contract?.[0];
  const value = contract?.parameter?.value;
  if (transaction?.raw_data?.contract?.length !== 1 || contract?.type !== "TriggerSmartContract") {
    throw new Error("TRON node returned an unexpected transaction type");
  }
  if (asBase58(value?.owner_address || "") !== wallet || asBase58(value?.contract_address || transaction?.contract_address || "") !== token) {
    throw new Error("Unsigned TRON transaction has an unexpected sender or USDT contract");
  }
  const data = String(value?.data || "").replace(/^0x/i, "").toLowerCase();
  const recipientHex = TronWeb.address.toHex(recipient).slice(-40).toLowerCase();
  if (data.length !== 136 || data.slice(0, 8) !== "a9059cbb" || data.slice(32, 72) !== recipientHex || BigInt(`0x${data.slice(72)}`) !== toUnits(amount)) {
    throw new Error("Unsigned TRON contract call does not match the exact requested USDT transfer");
  }
  if (!transaction?.txID || !transaction?.raw_data?.expiration) throw new Error("TRON node returned an incomplete transaction");
}

async function assertFunded(settings: NonNullable<ReturnType<typeof config>>, recipient: string, amount: Prisma.Decimal) {
  const web = getTronWeb(settings);
  const token = await web.contract(TRON_USDT_ABI as any, settings.tokenAddress);
  const tokenBalance = await token.balanceOf(settings.payoutAddress).call();
  if (BigInt(tokenBalance.toString()) < toUnits(amount)) throw new Error("TRON payout wallet does not have enough TRC20 USDT for this withdrawal");
  const trxBalanceSun = BigInt(String(await web.trx.getBalance(settings.payoutAddress)));
  if (trxBalanceSun < BigInt(settings.feeLimitSun)) throw new Error("TRON payout wallet needs more TRX to cover the configured maximum network fee");
  const unsigned = await web.transactionBuilder.triggerSmartContract(
    settings.tokenAddress,
    "transfer(address,uint256)",
    { feeLimit: settings.feeLimitSun, callValue: 0 },
    [
      { type: "address", value: recipient },
      { type: "uint256", value: toUnits(amount).toString() },
    ],
    settings.payoutAddress,
  );
  if (!unsigned.result?.result) throw new Error(`TRON node could not build the transfer: ${unsigned.result?.message || unsigned.Error || "unknown reason"}`);
  verifyUnsignedTransaction(unsigned.transaction, settings.payoutAddress, recipient, settings.tokenAddress, amount);
  return unsigned.transaction;
}

async function reserve(request: { id: string; description: string | null }, amount: Prisma.Decimal, settings: NonNullable<ReturnType<typeof config>>) {
  const today = new Date().toISOString().slice(0, 10);
  return prisma.$transaction(async (tx) => {
    // PostgreSQL advisory locks return `void`, which Prisma's PostgreSQL adapter
    // cannot deserialize as a query result. Keep the lock call in a subquery and
    // return a supported scalar instead.
    await tx.$queryRaw<Array<{ locked: number }>>`SELECT 1::int AS locked FROM (SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, 1)) AS payout_lock`;
    const current = await tx.transaction.findUnique({ where: { id: request.id } });
    if (!current || current.type !== "WITHDRAWAL" || current.status !== "PENDING" || current.externalId) return null;
    const meta = parseMeta(current.description);
    if (meta.network !== "TRC20" || meta.payoutMode !== "TRON_LOCAL" || typeof meta.address !== "string") return null;
    const prior = meta.tronPayout;
    if (prior?.state === "PREPARED" && prior.unsignedTransaction && prior.transactionHash) {
      if (current.payoutTxHash !== `TRC20:${prior.transactionHash}`) return null;
      const preparedAt = prior.preparedAt ? new Date(prior.preparedAt).getTime() : 0;
      if (!preparedAt || Date.now() - preparedAt > 10 * 60_000) {
        console.error(`TRC20 withdrawal ${request.id} has an unsigned transaction older than 10 minutes; automatic retries are paused for manual reconciliation.`);
        return null;
      }
      return { metadata: meta, recipient: meta.address, amount, transaction: prior.unsignedTransaction as any, hash: prior.transactionHash, recovery: true };
    }
    if (current.payoutTxHash) return null;
    if (prior?.state === "SUBMITTED") return null;
    if (prior?.state === "PREPARING" && prior.reservedDate === today) {
      return { metadata: meta, recipient: meta.address, amount, recovery: false };
    }
    const history = await tx.transaction.findMany({ where: { type: "WITHDRAWAL", description: { not: null } }, select: { description: true } });
    const usedToday = history.reduce((sum, row) => {
      const payout = parseMeta(row.description).tronPayout;
      return payout?.reservedDate === today && payout.reservedAmount ? sum.plus(payout.reservedAmount) : sum;
    }, new Prisma.Decimal(0));
    if (amount.gt(settings.maxSingle)) {
      await tx.transaction.updateMany({
        where: { id: current.id, type: "WITHDRAWAL", status: "PENDING", payoutTxHash: null, description: current.description },
        data: { description: JSON.stringify({ ...meta, tronPayout: { state: "LIMIT_BLOCKED", reason: "PER_WITHDRAWAL_LIMIT" } }) },
      });
      console.warn(`TRC20 withdrawal ${request.id} exceeds its configured per-withdrawal cap; it remains pending for review.`);
      return null;
    }
    if (usedToday.plus(amount).gt(settings.dailyLimit)) {
      await tx.transaction.updateMany({
        where: { id: current.id, type: "WITHDRAWAL", status: "PENDING", payoutTxHash: null, description: current.description },
        data: { description: JSON.stringify({ ...meta, tronPayout: { state: "LIMIT_BLOCKED", reason: "DAILY_LIMIT" } }) },
      });
      console.warn(`TRC20 withdrawal ${request.id} exceeds its configured daily cap; it remains pending for review.`);
      return null;
    }
    const next: WithdrawalMeta = {
      ...meta,
      tronPayout: { state: "PREPARING", reservedDate: today, reservedAmount: amount.toFixed(8) },
    };
    const claimed = await tx.transaction.updateMany({
      where: { id: current.id, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: null, description: current.description },
      data: { description: JSON.stringify(next) },
    });
    if (claimed.count !== 1) return null;
    return { metadata: next, recipient: meta.address, amount, recovery: false };
  });
}

async function processOne(request: { id: string; amount: Prisma.Decimal; description: string | null }, settings: NonNullable<ReturnType<typeof config>>) {
  const meta = parseMeta(request.description);
  if (meta.network !== "TRC20" || meta.payoutMode !== "TRON_LOCAL" || typeof meta.address !== "string" || meta.tronPayout?.state === "LIMIT_BLOCKED") return;
  const amount = recordedWithdrawalTerms(request.amount, request.description).netAmount;
  if (amount.lte(0)) return;
  const reservation = await reserve(request, amount, settings);
  if (!reservation) return;
  let unsignedTransaction = reservation.transaction;
  let txHash = reservation.hash;
  let metadata = reservation.metadata;
  if (!reservation.recovery) {
    unsignedTransaction = await assertFunded(settings, reservation.recipient, amount);
    txHash = String(unsignedTransaction.txID).toLowerCase();
    const prepared: WithdrawalMeta = {
      ...metadata,
      tronPayout: {
        state: "PREPARED",
        reservedDate: metadata.tronPayout?.reservedDate,
        reservedAmount: metadata.tronPayout?.reservedAmount,
        preparedAt: new Date().toISOString(),
        transactionHash: txHash,
        unsignedTransaction,
      },
    };
    const saved = await prisma.transaction.updateMany({
      where: { id: request.id, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: null, description: JSON.stringify(metadata) },
      data: { description: JSON.stringify(prepared), payoutTxHash: `TRC20:${txHash}` },
    });
    if (saved.count !== 1) return;
    metadata = prepared;
  }

  const web = getTronWeb(settings);
  const signed = await web.trx.sign(unsignedTransaction, settings.privateKey);
  const sent = await web.trx.sendRawTransaction(signed);
  if (!sent.result) throw new Error(`TRON node did not accept the signed transaction: ${sent.message || sent.code || "unknown reason"}`);
  const submitted: WithdrawalMeta = {
    ...metadata,
    tronPayout: { ...metadata.tronPayout, state: "SUBMITTED", transactionHash: txHash },
  };
  await prisma.transaction.updateMany({
    where: { id: request.id, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: `TRC20:${txHash}` },
    data: { description: JSON.stringify(submitted) },
  });
  console.info(`TRON submitted TRC20 withdrawal ${request.id} (${txHash}); ledger completion waits for solidified chain confirmation.`);
}

async function scan() {
  if (scanInProgress) return;
  scanInProgress = true;
  try {
    const settings = config();
    if (!settings) return;
    const pendingAll = await prisma.transaction.findMany({
      where: { type: "WITHDRAWAL", status: "PENDING", externalId: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, amount: true, description: true, payoutTxHash: true },
    });
    const unresolved = pendingAll.filter((row) => {
      const meta = parseMeta(row.description);
      return meta.payoutMode === "TRON_LOCAL" && ["PREPARING", "PREPARED", "SUBMITTED"].includes(meta.tronPayout?.state || "");
    });
    if (unresolved.some((row) => parseMeta(row.description).tronPayout?.state === "SUBMITTED")) return;
    let request = unresolved.find((row) => parseMeta(row.description).tronPayout?.state === "PREPARED");
    if (!request) request = unresolved.find((row) => parseMeta(row.description).tronPayout?.state === "PREPARING");
    if (!request) request = pendingAll.find((row) => {
      const meta = parseMeta(row.description);
      return !row.payoutTxHash && meta.payoutMode === "TRON_LOCAL" && meta.tronPayout?.state !== "LIMIT_BLOCKED";
    });
    if (request) {
      try { await processOne(request, settings); }
      catch (error) { console.error(`TRC20 payout ${request.id} was not submitted or needs reconciliation:`, error); }
    }
  } catch (error) { console.error("TRC20 payout worker is not ready:", error); }
  finally { scanInProgress = false; }
}

export function startTronPayoutSender() {
  if (process.env.TRON_PAYOUT_AUTOMATION_ENABLED?.trim().toLowerCase() !== "true") return;
  try { config(); }
  catch (error) {
    console.error("TRC20 payout automation remains inactive:", error instanceof Error ? error.message : "configuration error");
    return;
  }
  void scan();
  const timer = setInterval(() => void scan(), INTERVAL_MS);
  timer.unref();
}
