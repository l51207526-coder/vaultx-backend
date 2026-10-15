import "dotenv/config";
import express from "express";
import cors from "cors";
import { prisma } from "./lib/prisma.js";

import authRoutes from "./routes/auth.js";
import meRoutes from "./routes/me.js";
import walletRoutes from "./routes/wallet.js";
import marketRoutes from "./routes/market.js";
import transactionRoutes from "./routes/transactions.js";
import adminRoutes from "./routes/admin.js";
import investmentRoutes from "./routes/investments.js";
import referralRoutes from "./routes/referrals.js";
import notificationRoutes from "./routes/notifications.js";
import payoutRoutes from "./routes/payouts.js";
import { notifyDueInvestmentReviews } from "./lib/maturity-review.js";
import { startAutomaticDepositMonitor } from "./lib/automatic-deposits.js";
import { expirePendingDeposits } from "./lib/deposit-expiry.js";
import { startAutomaticWithdrawalMonitor } from "./lib/automatic-withdrawals.js";
import { authorizeTatumKmsRequest, startTatumPayoutSender } from "./lib/tatum-payout-sender.js";

const app = express();
const port = Number(process.env.PORT || 4000);

app.disable("x-powered-by");

app.use(express.json({ limit: "100kb" }));

const allowedOrigins = (process.env.FRONTEND_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin is not allowed by CORS"));
    },
  })
);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "vaultx-api",
  });
});

app.get("/api/ready", async (_req, res) => {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    return res.json({ ok: true, service: "vaultx-api", database: "ready" });
  } catch {
    return res.status(503).json({ ok: false, service: "vaultx-api", database: "unavailable" });
  }
});

// Tatum KMS calls this URL before signing each mainnet payout. Return 2xx only
// when the opaque Tatum request ID belongs to an exact, still-pending VaultX payout.
app.get("/api/tatum/kms-approve/:id", async (req, res) => {
  try {
    if (await authorizeTatumKmsRequest(String(req.params.id))) return res.sendStatus(200);
    return res.sendStatus(403);
  } catch (error) {
    console.error("Tatum KMS request authorization failed:", error);
    return res.sendStatus(503);
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/me", meRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/investments", investmentRoutes);
app.use("/api/referrals", referralRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/payouts", payoutRoutes);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err);

    const status =
      typeof err === "object" && err !== null && "status" in err &&
      typeof (err as { status?: unknown }).status === "number"
        ? Number((err as { status: number }).status)
        : 500;

    if (status >= 400 && status < 500) {
      const message =
        typeof err === "object" && err !== null && "message" in err
          ? String((err as { message: unknown }).message)
          : "Request could not be processed";

      return res.status(status).json({ error: message });
    }

    if (status === 503) {
      return res.status(503).json({ error: "Email delivery is unavailable right now. Please try again later." });
    }

    return res.status(500).json({
      error: "Internal server error",
    });
  }
);

// Maturity review alerts are persisted and idempotent. The scan only notifies admins;
// investment wallet credits remain an explicit, separately reviewed operation.
void notifyDueInvestmentReviews();
setInterval(() => {
  void notifyDueInvestmentReviews();
}, 15 * 60 * 1000).unref();

startAutomaticDepositMonitor();
startAutomaticWithdrawalMonitor();
startTatumPayoutSender();
void expirePendingDeposits().catch((error) => console.error("Deposit expiry scan failed:", error));
setInterval(() => {
  void expirePendingDeposits().catch((error) => console.error("Deposit expiry scan failed:", error));
}, 15_000).unref();

app.listen(port, () => {
  console.log(`VaultX API listening on http://localhost:${port}`);
});
