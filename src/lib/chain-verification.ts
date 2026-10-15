import { Prisma } from "../generated/prisma/client.js";
import { createHash } from "node:crypto";

export const SUPPORTED_NETWORKS = ["BEP20", "TRC20"] as const;
export type SupportedNetwork = typeof SUPPORTED_NETWORKS[number];

type NetworkConfig = {
  rpcUrl: string;
  tokenAddress: string;
  receivingAddress?: string;
  sendingAddress?: string;
  chainId?: bigint;
};

export type DepositMonitorConfig = {
  rpcUrl: string;
  tokenAddress: string;
  minimumConfirmations: bigint;
};

function configFor(network: SupportedNetwork): NetworkConfig {
  const prefix = {
    BEP20: "BSC",
    TRC20: "TRON",
  }[network];
  const required = (name: string) => {
    const value = process.env[`${prefix}_${name}`]?.trim();
    if (!value) throw new Error(`${prefix}_${name} is not configured`);
    return value;
  };
  return {
    rpcUrl: required("RPC_URL"),
    tokenAddress: required("USDT_CONTRACT"),
    receivingAddress: process.env[`${prefix}_RECEIVE_ADDRESS`]?.trim(),
    sendingAddress: process.env[`${prefix}_SEND_ADDRESS`]?.trim() || process.env[`${prefix}_RECEIVE_ADDRESS`]?.trim(),
    chainId: network === "BEP20" ? 56n : undefined,
  };
}

function normalizeAddress(value: string, network: SupportedNetwork): string {
  if (network === "TRC20") {
    if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) throw new Error("Invalid TRON address configuration");
    return value;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error("Invalid EVM address configuration");
  return value.toLowerCase();
}

export function validateWithdrawalAddress(value: string, network: SupportedNetwork): string | null {
  if (network === "BEP20") {
    return /^0x[0-9a-fA-F]{40}$/.test(value)
      ? null
      : "Enter a BNB Smart Chain address starting with 0x and containing 40 hexadecimal characters.";
  }
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) {
    return "Enter a valid TRON address: it starts with T and has 34 characters.";
  }
  let decoded = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return "Enter a valid TRON address.";
    decoded = decoded * 58n + BigInt(digit);
  }
  let hex = decoded.toString(16).padStart(50, "0");
  for (let index = 0; index < value.length && value[index] === "1"; index += 1) hex = `00${hex}`;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.length !== 25 || bytes[0] !== 0x41) return "Enter a valid TRON mainnet address.";
  const payload = bytes.subarray(0, 21);
  const checksum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  if (!bytes.subarray(21).equals(checksum)) return "The TRON address checksum is invalid. Check the address and try again.";
  return null;
}

function tokenDecimals(network: SupportedNetwork): number {
  // Binance-Peg BSC-USD uses 18 decimals on BNB Smart Chain; TRON USDT uses 6.
  return network === "BEP20" ? 18 : 6;
}

function toUnits(amount: string, network: SupportedNetwork): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount)) throw new Error("Amount must have at most 6 decimal places for USDT");
  const decimals = tokenDecimals(network);
  const scale = 10n ** BigInt(decimals);
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(decimals, "0"));
}

function fromUnits(value: bigint, network: SupportedNetwork): Prisma.Decimal {
  const decimals = tokenDecimals(network);
  const scale = 10n ** BigInt(decimals);
  return new Prisma.Decimal(`${value / scale}.${(value % scale).toString().padStart(decimals, "0")}`);
}

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

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const topicAddress = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

function minimumConfirmations(network: SupportedNetwork): bigint {
  const parsed = Number(process.env.BSC_MIN_CONFIRMATIONS || "12");
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("Invalid BSC_MIN_CONFIRMATIONS setting");
  return BigInt(parsed);
}

export function getDepositMonitorConfig(network: SupportedNetwork): DepositMonitorConfig | null {
  const prefix = {
    BEP20: "BSC",
    TRC20: "TRON",
  }[network];
  const rpcUrl = process.env[`${prefix}_RPC_URL`]?.trim();
  const tokenAddress = process.env[`${prefix}_USDT_CONTRACT`]?.trim();
  if (!rpcUrl || !tokenAddress) return null;
  normalizeAddress(tokenAddress, network);
  return {
    rpcUrl,
    tokenAddress,
    minimumConfirmations: network === "TRC20" ? 1n : minimumConfirmations(network),
  };
}

async function verifyEvmTransfer(network: SupportedNetwork, hash: string, amount: string | undefined, direction: "IN" | "OUT", counterparty?: string, expectedRecipient?: string) {
  const config = configFor(network);
  const expectedContract = normalizeAddress(config.tokenAddress, network);
  const target = direction === "IN" ? expectedRecipient || config.receivingAddress : config.sendingAddress;
  if (!target) throw new Error(direction === "IN" ? "A receiving address is required to verify this deposit" : "A sending address is required to verify this withdrawal");
  const expectedAddress = normalizeAddress(target, network);
  const receipt = await rpc(config.rpcUrl, "eth_getTransactionReceipt", [hash]);
  if (!receipt) throw new Error("Transaction is not mined yet");
  if (receipt.status !== "0x1") throw new Error("On-chain transaction failed");
  if (config.chainId !== undefined) {
    const chainId = BigInt(await rpc(config.rpcUrl, "eth_chainId", []));
    if (chainId !== config.chainId) throw new Error("Configured RPC is connected to the wrong network");
  }
  const head = BigInt(await rpc(config.rpcUrl, "eth_blockNumber", []));
  const confirmations = head - BigInt(receipt.blockNumber) + 1n;
  const block = await rpc(config.rpcUrl, "eth_getBlockByNumber", [receipt.blockNumber, false]);
  if (!block?.timestamp) throw new Error("Chain RPC did not return the transfer block timestamp");
  const blockTime = new Date(Number(BigInt(block.timestamp)) * 1000);
  const minimum = minimumConfirmations(network);
  if (confirmations < minimum) throw new Error(`Transaction needs ${minimum - confirmations} more confirmation(s)`);
  const sender = direction === "IN" ? undefined : topicAddress(expectedAddress);
  const recipient = direction === "IN" ? topicAddress(expectedAddress) : topicAddress(normalizeAddress(counterparty || "", network));
  const matching = (receipt.logs || []).filter((log: any) =>
    normalizeAddress(log.address, network) === expectedContract &&
    String(log.topics?.[0]).toLowerCase() === TRANSFER_TOPIC &&
    (sender === undefined || String(log.topics?.[1]).toLowerCase() === sender) &&
    String(log.topics?.[2]).toLowerCase() === recipient
  );
  if (matching.length === 0) throw new Error("Transaction does not contain the expected USDT transfer");
  const units = matching.reduce((total: bigint, log: any) => total + BigInt(log.data), 0n);
  if (amount !== undefined && units !== toUnits(amount, network)) throw new Error("On-chain USDT amount does not match the request");
  return { amount: fromUnits(units, network), network, hash: hash.toLowerCase(), confirmations: confirmations.toString(), blockTime };
}

function tronHexAddress(hex: string): string {
  const raw = hex.replace(/^0x/i, "").slice(-40);
  if (raw.length !== 40) return "";
  // TRON's 0x41 network prefix followed by the 20-byte account payload.
  const bytes = `41${raw}`;
  const payload = Buffer.from(bytes, "hex");
  const checksum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  const checked = Buffer.concat([payload, checksum]).toString("hex");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${checked}`), out = "";
  while (n > 0n) { out = alphabet[Number(n % 58n)] + out; n /= 58n; }
  for (let i = 0; i < checked.length && checked.slice(i, i + 2) === "00"; i += 2) out = `1${out}`;
  return out;
}

async function verifyTronTransfer(hash: string, amount: string | undefined, direction: "IN" | "OUT", counterparty?: string, expectedRecipient?: string) {
  const config = configFor("TRC20");
  const expectedContract = normalizeAddress(config.tokenAddress, "TRC20");
  const target = direction === "IN" ? expectedRecipient || config.receivingAddress : config.sendingAddress;
  if (!target) throw new Error(direction === "IN" ? "A receiving address is required to verify this deposit" : "A sending address is required to verify this withdrawal");
  const expectedAddress = normalizeAddress(target, "TRC20");
  const response = await fetch(`${config.rpcUrl.replace(/\/$/, "")}/walletsolidity/gettransactioninfobyid`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: hash }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`TRON RPC returned HTTP ${response.status}`);
  const info = await response.json() as any;
  if (!info?.id) throw new Error("Transaction is not confirmed on TRON yet");
  if (info.receipt?.result !== "SUCCESS") throw new Error("On-chain transaction failed");
  const blockTime = Number(info.blockTimeStamp);
  if (!Number.isFinite(blockTime) || blockTime <= 0) throw new Error("TRON RPC did not return the transfer block timestamp");
  const transferTopic = TRANSFER_TOPIC.slice(2);
  const matches = (info.log || []).filter((log: any) => {
    const contract = tronHexAddress(log.address);
    const topics = log.topics || [];
    const from = tronHexAddress(topics[1] || "");
    const to = tronHexAddress(topics[2] || "");
    return contract === expectedContract && String(topics[0]).toLowerCase() === transferTopic &&
      (direction === "IN" || from === expectedAddress) &&
      to === (direction === "IN" ? expectedAddress : normalizeAddress(counterparty || "", "TRC20"));
  });
  if (matches.length === 0) throw new Error("Transaction does not contain the expected USDT TRC20 transfer");
  const units = matches.reduce((total: bigint, log: any) => total + BigInt(`0x${log.data}`), 0n);
  if (amount !== undefined && units !== toUnits(amount, "TRC20")) throw new Error("On-chain USDT amount does not match the request");
  return { amount: fromUnits(units, "TRC20"), network: "TRC20" as const, hash: hash.toLowerCase(), confirmations: "solidified", blockTime: new Date(blockTime) };
}

export function isSupportedNetwork(value: string): value is SupportedNetwork {
  return value === "BEP20";
}

export function isKnownNetwork(value: string): value is SupportedNetwork {
  return (SUPPORTED_NETWORKS as readonly string[]).includes(value);
}

export async function verifyUsdtTransfer(network: string, hash: string, amount: string | undefined, direction: "IN" | "OUT", counterparty?: string, expectedRecipient?: string) {
  if (!isKnownNetwork(network)) throw new Error("Unsupported USDT network");
  if (network === "TRC20") {
    if (!/^[a-fA-F0-9]{64}$/.test(hash)) throw new Error("Invalid TRON transaction ID");
    return verifyTronTransfer(hash, amount, direction, counterparty, expectedRecipient);
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) throw new Error("Invalid EVM transaction hash");
  return verifyEvmTransfer(network, hash, amount, direction, counterparty, expectedRecipient);
}
