import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createHash } from "node:crypto";
import { prisma } from "./prisma.js";
import type { SupportedNetwork } from "./chain-verification.js";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_CHILD_INDEX = 0x7fffffff;

/** Shared Trust Wallet receiving addresses for the manual transaction-ID flow. */
export function getSharedDepositAddress(network: SupportedNetwork): string {
  const variable = network === "BEP20" ? "BSC_RECEIVE_ADDRESS" : "TRON_RECEIVE_ADDRESS";
  const address = process.env[variable]?.trim();
  if (!address) throw new Error(`${variable} is not configured`);
  if (network === "BEP20" && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`${variable} is not a valid BNB Smart Chain address`);
  }
  if (network === "TRC20" && !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) {
    throw new Error(`${variable} is not a valid TRON address`);
  }
  return address;
}

function base58Check(payload: Uint8Array): string {
  const first = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([Buffer.from(payload), first]);
  let number = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (number > 0n) {
    encoded = BASE58[Number(number % 58n)] + encoded;
    number /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i += 1) encoded = `1${encoded}`;
  return encoded;
}

function xpubFor(network: SupportedNetwork): string {
  const variable = network === "BEP20" ? "BSC_DEPOSIT_XPUB" : "TRON_DEPOSIT_XPUB";
  const value = process.env[variable]?.trim();
  if (!value) throw new Error(`Unique ${network} deposit addresses are not configured. Set ${variable} to a public extended key.`);
  return value;
}

function deriveAddress(network: SupportedNetwork, index: number): string {
  let node: HDKey;
  try {
    node = HDKey.fromExtendedKey(xpubFor(network));
  } catch (error) {
    if (error instanceof Error && error.message.includes("not configured")) throw error;
    const variable = network === "BEP20" ? "BSC_DEPOSIT_XPUB" : "TRON_DEPOSIT_XPUB";
    throw new Error(`${variable} is invalid. Set it to a public extended key at the receiving branch.`);
  }
  if (node.privateKey) throw new Error("Deposit derivation keys must be public extended keys (xpub), never private keys.");
  if (node.depth !== 4 || node.index !== 0) {
    throw new Error("Deposit xpub must be exported at the BIP44 receiving branch m/44'/coin'/0'/0.");
  }
  const publicKey = node.deriveChild(index).publicKey;
  if (!publicKey) throw new Error("Could not derive a public deposit address.");
  const uncompressed = secp256k1Uncompressed(publicKey);
  const account = keccak_256(uncompressed.subarray(1)).subarray(12);
  if (network === "BEP20") return `0x${Buffer.from(account).toString("hex")}`;
  return base58Check(Buffer.concat([Buffer.from([0x41]), Buffer.from(account)]));
}

function secp256k1Uncompressed(publicKey: Uint8Array): Uint8Array {
  // scure-bip32 validates public child derivation; this conversion is only for address hashing.
  return secp256k1Point(publicKey);
}

function secp256k1Point(publicKey: Uint8Array): Uint8Array {
  // Imported lazily from the same audited curve implementation used by scure-bip32.
  return secp256k1.Point.fromBytes(publicKey).toBytes(false);
}

export async function getUserDepositAddress(userId: string, network: SupportedNetwork) {
  const existing = await prisma.depositAddress.findUnique({ where: { userId_network: { userId, network } } });
  if (existing) return existing;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = await prisma.depositAddress.aggregate({ where: { network, derivationIndex: { not: null } }, _max: { derivationIndex: true } });
    let index = (state._max.derivationIndex ?? -1) + 1;
    for (let candidate = index; candidate <= Math.min(index + 1000, MAX_CHILD_INDEX); candidate += 1) {
      index = candidate;
      const address = deriveAddress(network, index);
      const occupied = await prisma.depositAddress.findFirst({ where: { network, OR: [{ address }, { derivationIndex: index }] } });
      if (occupied) {
        if (occupied.userId === userId) return occupied;
        continue;
      }
      try {
        return await prisma.depositAddress.create({ data: { userId, network, address, derivationIndex: index } });
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "P2002") throw error;
        const raced = await prisma.depositAddress.findUnique({ where: { userId_network: { userId, network } } });
        if (raced) return raced;
      }
    }
  }
  throw new Error(`Could not allocate a unique ${network} deposit address. Please retry.`);
}

export async function listDepositAddresses(network: SupportedNetwork) {
  return prisma.depositAddress.findMany({ where: { network }, select: { userId: true, address: true, derivationIndex: true } });
}
