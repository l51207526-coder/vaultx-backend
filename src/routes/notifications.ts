import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.get("/", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { OR: [{ userId: req.userId! }, { userId: null }] },
      orderBy: { createdAt: "desc" },
      take: 40,
    });
    const globalNotificationIds = notifications.filter((item) => item.userId === null).map((item) => item.id);
    const reads = globalNotificationIds.length
      ? await prisma.notificationRead.findMany({
          where: { userId: req.userId!, notificationId: { in: globalNotificationIds } },
          select: { notificationId: true, readAt: true },
        })
      : [];
    const readAtByNotification = new Map(reads.map((read) => [read.notificationId, read.readAt]));

    return res.json({
      notifications: notifications.map((notification) => ({
        id: notification.id,
        title: notification.title,
        body: notification.body,
        kind: notification.kind,
        createdAt: notification.createdAt,
        readAt: notification.userId === null
          ? readAtByNotification.get(notification.id) ?? null
          : notification.readAt,
      })),
    });
  } catch (error) { next(error); }
});

router.post("/:id/read", requireAuth, async (req: AuthenticatedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    if (id.startsWith("tx-")) return res.json({ message: "Notification acknowledged" });
    const notification = await prisma.notification.findFirst({
      where: { id, OR: [{ userId: req.userId! }, { userId: null }] },
      select: { id: true, userId: true },
    });
    if (!notification) return res.status(404).json({ error: "Notification not found" });
    if (notification.userId === null) {
      await prisma.notificationRead.upsert({
        where: { userId_notificationId: { userId: req.userId!, notificationId: id } },
        create: { userId: req.userId!, notificationId: id },
        update: { readAt: new Date() },
      });
    } else {
      await prisma.notification.updateMany({
        where: { id, userId: req.userId! },
        data: { readAt: new Date() },
      });
    }
    return res.json({ message: "Notification marked as read" });
  } catch (error) { next(error); }
});

export default router;
