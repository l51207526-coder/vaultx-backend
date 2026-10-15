import type { NextFunction, Response } from "express";
import { prisma } from "../lib/prisma.js";
import type { AuthenticatedRequest } from "./auth.js";

export async function requirePayoutOperator(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.userId) return res.status(401).json({ error: "Authentication required" });
    const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { role: true, email: true } });
    if (!user) return res.status(401).json({ error: "Account not found" });
    const allowedEmails = new Set((process.env.PAYOUT_OPERATOR_EMAILS || "")
      .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean));
    if (user.role !== "ADMIN" && !allowedEmails.has(user.email.toLowerCase())) {
      return res.status(403).json({ error: "This account is not authorized to process payouts" });
    }
    next();
  } catch (error) {
    next(error);
  }
}
