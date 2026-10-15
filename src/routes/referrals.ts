import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId! }, select: { referralCode: true } });
    if (!user) return res.status(404).json({ error: "User not found" });

    const level1 = await prisma.user.findMany({ where: { referredById: req.userId! }, select: { id: true, name: true, createdAt: true } });
    const level1Ids = level1.map((x) => x.id);
    const level2 = level1Ids.length ? await prisma.user.findMany({ where: { referredById: { in: level1Ids } }, select: { id: true, name: true, createdAt: true } }) : [];
    const level2Ids = level2.map((x) => x.id);
    const level3 = level2Ids.length ? await prisma.user.findMany({ where: { referredById: { in: level2Ids } }, select: { id: true, name: true, createdAt: true } }) : [];

    return res.json({ referralCode: user.referralCode, levels: { level1, level2, level3 }, counts: { level1: level1.length, level2: level2.length, level3: level3.length, total: level1.length + level2.length + level3.length } });
  } catch (error) { next(error); }
});

export default router;
