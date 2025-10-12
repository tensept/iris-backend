import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import nodemailer from "nodemailer";
import { eq } from "drizzle-orm";

import { dbClient } from "../../db/client.js";
import { users as usersTable } from "../../db/schema.js";

/** --------- ENV / CONSTANTS --------- */
const { JWT_SECRET, NODE_ENV, FRONTEND_URL, SMTP_USER, SMTP_PASS } = process.env;
if (!JWT_SECRET) throw new Error("Missing JWT_SECRET in .env");
if (!FRONTEND_URL) throw new Error("Missing FRONTEND_URL in .env");

const isProd = NODE_ENV === "production";

/** --------- HELPERS --------- */
type JwtPayload = {
  userId: number;
  email: string;
  role: "ADMIN" | "CUSTOMER";
  name?: string | null;
  avatar?: string | null;
};

function signAccessToken(p: JwtPayload) {
  return jwt.sign(p, JWT_SECRET!, { expiresIn: "15m" });
}

function setRefreshCookie(res: any, token: string) {
  res.cookie("refreshToken", token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function setAccessCookie(res: any, accessToken: string) {
  res.cookie("token", accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    path: "/",
    maxAge: 15 * 60 * 1000,
  });
}

/** --------- ROUTER --------- */
const authRouter = Router();

/* ============ REGISTER ============ */
authRouter.post("/register", async (req, res, next) => {
  try {
    const { email, password, name } = req.body ?? {};
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      typeof name !== "string"
    ) {
      return res.status(400).json({ error: "Invalid input type" });
    }

    const existing = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    if (existing.length > 0) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(
      password,
      Number(process.env.BCRYPT_SALT_ROUNDS ?? 10)
    );

    const verifyToken = crypto.randomBytes(32).toString("hex");

    await dbClient.insert(usersTable).values({
      email,
      password: hashedPassword,
      name,
      role: "CUSTOMER",
      verifyToken,
    });

    if (SMTP_USER && SMTP_PASS) {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });

      const verifyUrl = `${FRONTEND_URL}/verify?token=${verifyToken}&email=${encodeURIComponent(
        email
      )}`;

      await transporter.sendMail({
        from: `"No Reply" <${SMTP_USER}>`,
        to: email,
        subject: "Please verify your email",
        html: `<p>Hello ${name},</p>
               <p>Click below to verify your account:</p>
               <a href="${verifyUrl}">${verifyUrl}</a>`,
      });
    }

    return res.status(201).json({
      message:
        "User registered successfully. Please check your email to verify.",
    });
  } catch (err) {
    next(err);
  }
});

authRouter.patch("/role/:id", async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);

    const updated = await dbClient
      .update(usersTable)
      .set({ role: "ADMIN" })
      .where(eq(usersTable.userID, userId))
      .returning({
        id: usersTable.userID,
        name: usersTable.name,
        email: usersTable.email,
        role: usersTable.role,
      });

    if (updated.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ message: "Role updated to ADMIN", user: updated[0] });
  } catch (err) {
    next(err);
  }
});

/* ============ VERIFY EMAIL ============ */
authRouter.get("/verify", async (req, res, next) => {
  try {
    const { token, email } = req.query;
    if (!token || !email) {
      return res.status(400).json({ error: "Invalid verification link" });
    }

    const found = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, String(email)));

    if (found.length === 0) {
      return res.status(400).json({ error: "User not found" });
    }

    const user = found[0];
    if (user.verifyToken !== token) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    await dbClient
      .update(usersTable)
      .set({ emailVerifiedAt: new Date(), verifyToken: null })
      .where(eq(usersTable.userID, user.userID));

    return res.json({ message: "Email verified successfully. You can now login." });
  } catch (err) {
    next(err);
  }
});

/* ============ LOGIN ============ */
authRouter.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body ?? {};

    const found = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));

    if (found.length === 0) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const user = found[0];

    if (!user.emailVerifiedAt) {
      return res
        .status(403)
        .json({ error: "Please verify your email before login" });
    }

    const isMatch = await bcrypt.compare(password, user.password ?? "");
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    const accessToken = jwt.sign(
      { userId: user.userID, email: user.email, role: user.role },
      JWT_SECRET!,
      { expiresIn: "15m" }
    );

    const refreshToken = crypto.randomBytes(40).toString("hex");
    await dbClient
      .update(usersTable)
      .set({ refreshToken })
      .where(eq(usersTable.userID, user.userID));

    setRefreshCookie(res, refreshToken);
    setAccessCookie(res, accessToken);

    return res.json({
      message: "Login successful",
      // ไม่จำเป็นต้องใช้ accessToken ฝั่ง client ถ้าใช้ cookie ล้วน
      user: {
        id: user.userID,
        email: user.email,
        name: user.name,
        role: user.role,
      },
      redirect: "/home",
    });
  } catch (err) {
    next(err);
  }
});

/* ============ REFRESH TOKEN ============ */
authRouter.post("/refresh", async (req, res, next) => {
  try {
    const rt = req.cookies?.refreshToken as string | undefined;
    if (!rt) return res.status(401).json({ error: "Missing refresh token" });

    const found = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.refreshToken, rt));

    if (found.length === 0) {
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    const user = found[0];

    const payload: JwtPayload = {
      userId: user.userID,
      email: user.email!,
      role: (user.role as "ADMIN" | "CUSTOMER") ?? "CUSTOMER",
      name: user.name ?? null,
      avatar: null,
    };

    const newAccessToken = signAccessToken(payload);

    // rotate refresh
    const newRefresh = crypto.randomBytes(40).toString("hex");
    await dbClient
      .update(usersTable)
      .set({ refreshToken: newRefresh })
      .where(eq(usersTable.userID, user.userID));

    setRefreshCookie(res, newRefresh);
    setAccessCookie(res, newAccessToken);

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ============ LOGOUT ============ */
authRouter.post("/logout", async (req, res, next) => {
  try {
    const rt = req.cookies?.refreshToken as string | undefined;

    // ล้างทั้ง 2 คุกกี้
    res.clearCookie("refreshToken", {
      path: "/",
      sameSite: "lax",
      secure: isProd,
    });
    res.clearCookie("token", {
      path: "/",
      sameSite: "lax",
      secure: isProd,
    });

    if (rt) {
      await dbClient
        .update(usersTable)
        .set({ refreshToken: null })
        .where(eq(usersTable.refreshToken, rt));
    }

    return res.json({ message: "Logged out" });
  } catch (err) {
    next(err);
  }
});

/* ============ FORGOT PASSWORD ============ */
authRouter.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (!email) return res.status(400).json({ error: "Email is required" });

    const found = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));

    // ตอบ 200 เสมอเพื่อความปลอดภัย
    if (found.length === 0) {
      return res
        .status(200)
        .json({ message: "If this email is registered, reset link was sent" });
    }

    const user = found[0];
    const resetToken = crypto.randomBytes(32).toString("hex");

    await dbClient
      .update(usersTable)
      .set({ resetToken, updatedAt: new Date() })
      .where(eq(usersTable.userID, user.userID));

    if (SMTP_USER && SMTP_PASS) {
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });

      const resetUrl = `${FRONTEND_URL}/reset-password?token=${resetToken}&email=${encodeURIComponent(
        email
      )}`;

      await transporter.sendMail({
        from: `"No Reply" <${SMTP_USER}>`,
        to: email,
        subject: "Password Reset Request",
        html: `<p>Hello,</p>
               <p>You requested a password reset. Click the link below to reset your password:</p>
               <a href="${resetUrl}">${resetUrl}</a>
               <p>This link will expire in 1 hour.</p>`,
      });
    }

    return res.json({ message: "Reset password email sent if the account exists." });
  } catch (err) {
    next(err);
  }
});

/* ============ GET CURRENT USER ============ */
authRouter.get("/me", async (req, res) => {
  // ✅ ทางเลือกที่ 1: อ่านจาก cookie 'token' ก่อน
  let raw = (req as any).cookies?.token as string | undefined;

  // ✅ เผื่อกรณีบางที่แนบ Authorization มาด้วย (ไม่บังคับ)
  if (!raw && req.headers.authorization?.startsWith("Bearer ")) {
    raw = req.headers.authorization.split(" ")[1];
  }

  if (!raw) {
    return res.status(401).json({ error: "Missing token" });
  }

  try {
    const payload = jwt.verify(raw, JWT_SECRET!) as JwtPayload;

    const found = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.userID, payload.userId));

    if (found.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = found[0];
    return res.json({
      id: user.userID,
      name: user.name,
      email: user.email,
      role: user.role,
      avatar: null,
    });
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
});

export { authRouter };
