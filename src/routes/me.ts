import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { id: true, name: true, email: true, role: true, referralCode: true, emailVerifiedAt: true, createdAt: true, withdrawalPasswordHash: true, wallet: { select: { id: true, asset: true } } }
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json({ user: { ...user, withdrawalPasswordSet: Boolean(user.withdrawalPasswordHash), withdrawalPasswordHash: undefined } });
  } catch (error) { next(error); }
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  withdrawalPassword: z.string().min(6).max(128),
  confirmWithdrawalPassword: z.string().min(1).max(128)
}).refine((v) => v.withdrawalPassword === v.confirmWithdrawalPassword, { path: ["confirmWithdrawalPassword"], message: "Withdrawal passwords do not match" });

router.post("/withdrawal-password", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid withdrawal password details" });
    const user = await prisma.user.findUnique({ where: { id: req.userId! } });
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) return res.status(401).json({ error: "Incorrect account password" });
    const withdrawalPasswordHash = await bcrypt.hash(parsed.data.withdrawalPassword, 12);
    await prisma.user.update({ where: { id: user.id }, data: { withdrawalPasswordHash } });
    await prisma.notification.create({ data: { userId: user.id, title: "Withdrawal password updated", body: "Your withdrawal password was changed successfully.", kind: "SECURITY" } });
    return res.json({ message: "Withdrawal password updated successfully" });
  } catch (error) { next(error); }
});

export default router;
