import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../dist/src/generated/prisma/client.js";

const requestId = String(process.argv[2] || "").trim();
if (!/^[a-f0-9]{24}$/i.test(requestId)) {
  console.error("Pass the 24-character Tatum KMS transaction ID shown in the KMS error.");
  process.exit(2);
}

const apiKey = process.env.TATUM_API_KEY?.trim();
const connectionString = process.env.DATABASE_URL?.trim();
if (!apiKey || !connectionString) {
  console.error("TATUM_API_KEY or DATABASE_URL is missing from this backend's .env file.");
  process.exit(2);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
async function tatumFetch(url, init) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  const cause = lastError?.cause;
  const detail = cause && typeof cause === "object"
    ? [cause.code, cause.message].filter(Boolean).join(": ")
    : lastError instanceof Error ? lastError.message : "unknown network error";
  throw new Error(`Could not reach Tatum after 3 attempts (${detail}). No payout data was changed.`);
}

try {
  const rows = await prisma.transaction.findMany({
    where: { type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: null, description: { contains: requestId } },
    select: { id: true, description: true },
  });
  const match = rows.find((row) => {
    try {
      const meta = JSON.parse(row.description || "{}");
      return meta.payoutMode === "TATUM" && meta.tatumPayout?.state === "SUBMITTED" && meta.tatumPayout?.requestId === requestId;
    } catch { return false; }
  });
  if (!match) throw new Error("No matching pending VaultX Tatum payout was found; nothing was changed.");

  const detailsResponse = await tatumFetch(`https://api.tatum.io/v3/kms/${encodeURIComponent(requestId)}`, {
    headers: { accept: "application/json", "x-api-key": apiKey },
  });
  if (!detailsResponse.ok) throw new Error(`Tatum status check returned HTTP ${detailsResponse.status}; nothing was changed.`);
  const details = await detailsResponse.json();
  if (details?.txId || details?.transactionId) {
    throw new Error("Tatum already reports a transaction hash. Nothing was deleted or retried; reconcile that hash first.");
  }

  const deleteResponse = await tatumFetch(`https://api.tatum.io/v3/kms/${encodeURIComponent(requestId)}?revert=true`, {
    method: "DELETE",
    headers: { accept: "application/json", "x-api-key": apiKey },
  });
  if (!deleteResponse.ok) throw new Error(`Tatum could not remove the failed unsigned request (HTTP ${deleteResponse.status}); VaultX was not reset.`);

  const meta = JSON.parse(match.description || "{}");
  const payout = { ...meta.tatumPayout, state: "PREPARING", index: 0 };
  delete payout.requestId;
  delete payout.startedAt;
  delete payout.transactionHash;
  const updated = await prisma.transaction.updateMany({
    where: { id: match.id, type: "WITHDRAWAL", status: "PENDING", externalId: null, payoutTxHash: null, description: match.description },
    data: { description: JSON.stringify({ ...meta, tatumPayout: payout }) },
  });
  if (updated.count !== 1) throw new Error("The failed Tatum request was removed, but the VaultX order changed at the same time. Stop and reconcile before retrying.");
  console.log("Removed the unsigned failed Tatum request and reset the same VaultX order for one corrected retry using index 0.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Recovery failed safely.");
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
