import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { signToken } from "../middleware/auth.js";
import { createRateLimiter } from "../middleware/rate-limit.js";
import { buildEmailLink, requireEmailConfiguration, sendVaultEmail } from "../lib/email.js";

const router = Router();
const registrationLimiter = createRateLimiter(5, 15 * 60 * 1000);
const loginLimiter = createRateLimiter(10, 15 * 60 * 1000);
const recoveryLimiter = createRateLimiter(5, 15 * 60 * 1000);
const verificationLimiter = createRateLimiter(5, 15 * 60 * 1000);

const registerSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(12).max(128),
  confirmPassword: z.string().min(1).max(128),
  referralCode: z.string().trim().max(32).optional().or(z.literal(""))
}).refine((value) => value.password === value.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match"
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128)
});

const forgotSchema = z.object({
  email: z.string().trim().toLowerCase().email()
});

const resetSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(128),
  confirmPassword: z.string().min(1).max(128)
}).refine((value) => value.password === value.confirmPassword, {
  path: ["confirmPassword"],
  message: "Passwords do not match"
});

function makeReferralCode() {
  return `VX${randomBytes(5).toString("hex").toUpperCase()}`;
}

function hashResetToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

router.post("/register", registrationLimiter, async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid registration details" });
    }

    requireEmailConfiguration();
    const { name, email, password, referralCode } = parsed.data;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: "An account with that email already exists" });

    let referredById: string | null = null;
    if (referralCode) {
      const referrer = await prisma.user.findUnique({ where: { referralCode } });
      if (!referrer) return res.status(400).json({ error: "Invalid referral code" });
      referredById = referrer.id;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const verificationToken = randomBytes(32).toString("hex");
    let user;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        user = await prisma.user.create({
          data: {
            name, email, passwordHash, referralCode: makeReferralCode(), referredById,
            emailVerificationTokenHash: hashResetToken(verificationToken),
            emailVerificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            wallet: { create: { asset: "USDT" } }
          },
          select: { id: true, name: true, email: true, role: true, referralCode: true, createdAt: true }
        });
        break;
      } catch (error: any) {
        if (error?.code === "P2002" && attempt < 4) continue;
        throw error;
      }
    }
    if (!user) throw new Error("Could not create account");

    const verificationLink = buildEmailLink("verify", verificationToken);
    try {
      await sendVaultEmail(
        email,
        "Verify your VaultX email",
        "Confirm your email address to finish creating your VaultX account.",
        "Verify email address",
        verificationLink,
      );
    } catch (error) {
      await prisma.user.delete({ where: { id: user.id } });
      throw error;
    }

    await prisma.notification.create({
      data: {
        userId: user.id,
        title: "Welcome to VaultX",
        body: "Verify your email address to finish setting up your account.",
        kind: "ACCOUNT"
      }
    });

    if (referredById) {
      await prisma.notification.create({
        data: {
          userId: referredById,
          title: "New referral joined",
          body: `${user.name || user.email} joined your referral network using your invite code.`,
          kind: "REFERRAL"
        }
      });
    }

    return res.status(201).json({ message: "Account created. Check your email for a verification link." });
  } catch (error) { next(error); }
});

router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid login details" });
    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    if (!user.emailVerifiedAt) {
      return res.status(403).json({ error: "Verify your email before logging in. You can request a new verification email below.", code: "EMAIL_NOT_VERIFIED" });
    }
    const token = signToken(user.id);
    return res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, referralCode: user.referralCode }, token });
  } catch (error) { next(error); }
});

router.post("/resend-verification", verificationLimiter, async (req, res, next) => {
  try {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter a valid email address" });
    requireEmailConfiguration();
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (user && !user.emailVerifiedAt) {
      const verificationToken = randomBytes(32).toString("hex");
      await prisma.user.update({
        where: { id: user.id },
        data: {
          emailVerificationTokenHash: hashResetToken(verificationToken),
          emailVerificationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      await sendVaultEmail(
        user.email,
        "Verify your VaultX email",
        "Confirm your email address to finish setting up your VaultX account.",
        "Verify email address",
        buildEmailLink("verify", verificationToken),
      );
    }
    return res.json({ message: "If that account needs verification, a link has been sent." });
  } catch (error) { next(error); }
});

router.post("/verify-email", verificationLimiter, async (req, res, next) => {
  try {
    const token = z.string().min(20).max(200).safeParse(req.body?.token);
    if (!token.success) return res.status(400).json({ error: "Invalid verification link" });
    const user = await prisma.user.findFirst({
      where: {
        emailVerificationTokenHash: hashResetToken(token.data),
        emailVerificationExpiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!user) return res.status(400).json({ error: "This verification link is invalid or has expired" });
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date(), emailVerificationTokenHash: null, emailVerificationExpiresAt: null },
    });
    return res.json({ message: "Email verified. You can now log in." });
  } catch (error) { next(error); }
});

router.post("/forgot-password", recoveryLimiter, async (req, res, next) => {
  try {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter a valid email address" });
    requireEmailConfiguration();
    const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user) return res.json({ message: "If an account exists for that email, password reset instructions have been sent." });

    const resetToken = randomBytes(32).toString("hex");
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetTokenHash: hashResetToken(resetToken), passwordResetExpiresAt: new Date(Date.now() + 30 * 60 * 1000) }
    });

    await sendVaultEmail(
      user.email,
      "Reset your VaultX password",
      "We received a request to reset your VaultX password. This link expires in 30 minutes.",
      "Reset password",
      buildEmailLink("reset", resetToken),
    );
    return res.json({ message: "If an account exists for that email, password reset instructions have been sent." });
  } catch (error) { next(error); }
});

router.post("/reset-password", recoveryLimiter, async (req, res, next) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid password reset details" });
    const tokenHash = hashResetToken(parsed.data.token);
    const user = await prisma.user.findFirst({
      where: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (!user) return res.status(400).json({ error: "This password reset code is invalid or has expired" });
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const resetApplied = await prisma.$transaction(async (tx) => {
      const consumed = await tx.user.updateMany({
        where: {
          id: user.id,
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: { gt: new Date() },
        },
        data: { passwordHash, passwordResetTokenHash: null, passwordResetExpiresAt: null },
      });
      if (consumed.count !== 1) return false;

      await tx.notification.create({
        data: {
          userId: user.id,
          title: "Password changed",
          body: "Your account password was changed successfully.",
          kind: "SECURITY",
        },
      });
      return true;
    });
    if (!resetApplied) return res.status(400).json({ error: "This password reset code is invalid or has expired" });

    return res.json({ message: "Password updated successfully. You can now log in." });
  } catch (error) { next(error); }
});

export default router;
