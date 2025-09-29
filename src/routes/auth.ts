import { Router } from "express";
import { dbClient } from "../../db/client.js";
import { users as usersTable } from "../../db/schema.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import nodemailer from "nodemailer";

const authRouter = Router();
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error("Missing JWT_SECRET in .env");

/* ============ REGISTER ============ */
authRouter.post("/register", async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body;

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      typeof name !== "string"
    ) {
      return res.status(400).json({ error: "Invalid input type" });
    }

    // ตรวจสอบ email ซ้ำ
    const existing = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    if (existing.length > 0) {
      return res.status(400).json({ error: "Email already registered" });
    }

    // hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // สร้าง verify token
    const verifyToken = crypto.randomBytes(32).toString("hex");

    // insert user (ยังไม่ verified)
    const inserted = await dbClient
      .insert(usersTable)
      .values({
        email,
        password: hashedPassword,
        name,
        role: role && role === "ADMIN" ? "ADMIN" : "CUSTOMER",
        verifyToken, // 👈 ใช้ verifyToken ตรงกับ schema
      })
      .returning({
        userID: usersTable.userID,
        email: usersTable.email,
        name: usersTable.name,
        role: usersTable.role,
      });

    // ส่ง email
    const transporter = nodemailer.createTransport({
      service: "gmail", // หรือใช้ SMTP server ของคุณเอง
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const verifyUrl = `${process.env.FRONTEND_URL}/verify?token=${verifyToken}&email=${email}`;

    await transporter.sendMail({
      from: `"No Reply" <${process.env.SMTP_USER}>`,
      to: email,
      subject: "Please verify your email",
      html: `<p>Hello ${name},</p>
             <p>Click below to verify your account:</p>
             <a href="${verifyUrl}">${verifyUrl}</a>`,
    });

    res.status(201).json({
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
      .set({
        emailVerifiedAt: new Date(),
        verifyToken: null, // 👈 clear
      })
      .where(eq(usersTable.userID, user.userID));

    res.json({ message: "Email verified successfully. You can now login." });
  } catch (err) {
    next(err);
  }
});

/* ============ LOGIN ============ */
authRouter.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

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

    const isMatch = await bcrypt.compare(password, user.password!);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid credentials" });
    }

    // สร้าง access token (อายุสั้น)
    const accessToken = jwt.sign(
      { userId: user.userID, email: user.email, role: user.role },
      JWT_SECRET!,
      { expiresIn: "1h" }
    );

    // สร้าง refresh token
    const refreshToken = crypto.randomBytes(40).toString("hex");
    await dbClient
      .update(usersTable)
      .set({ refreshToken })
      .where(eq(usersTable.userID, user.userID)); // 👈 fixed

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      message: "Login successful",
      accessToken,
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
    const refreshToken = req.cookies.refreshToken;
    if (!refreshToken)
      return res.status(401).json({ error: "Missing refresh token" });

    const found = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.refreshToken, refreshToken));

    if (found.length === 0)
      return res.status(401).json({ error: "Invalid refresh token" });

    const user = found[0];

    const newAccessToken = jwt.sign(
      { userId: user.userID, email: user.email, role: user.role },
      JWT_SECRET!,
      { expiresIn: "15m" }
    );

    res.json({ accessToken: newAccessToken });
  } catch (err) {
    next(err);
  }
});

/* ============ LOGOUT ============ */
authRouter.post("/logout", (req, res) => {
  res.clearCookie("refreshToken", { path: "/" });
  res.json({ message: "Logged out" });
});

/* ============ FORGOT PASSWORD ============ */
authRouter.post("/forgot-password", async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    const found = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));

    if (found.length === 0) {
      return res
        .status(200)
        .json({ message: "If this email is registered, reset link was sent" });
    }

    const user = found[0];
    const resetToken = crypto.randomBytes(32).toString("hex");

    await dbClient
      .update(usersTable)
      .set({
        resetToken, // 👈 ใช้ resetToken ตรงกับ schema
        updatedAt: new Date(),
      })
      .where(eq(usersTable.userID, user.userID));

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}&email=${email}`;

    await transporter.sendMail({
      from: `"No Reply" <${process.env.SMTP_USER}>`,
      to: email,
      subject: "Password Reset Request",
      html: `<p>Hello,</p>
             <p>You requested a password reset. Click the link below to reset your password:</p>
             <a href="${resetUrl}">${resetUrl}</a>
             <p>This link will expire in 1 hour.</p>`,
    });

    res.json({ message: "Reset password email sent if the account exists." });
  } catch (err) {
    next(err);
  }
});

/* ============ RESET PASSWORD ============ */
authRouter.post("/reset-password", async (req, res, next) => {
  try {
    const { email, token, password } = req.body;
    if (!email || !token || !password) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const found = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));

    if (found.length === 0) {
      return res.status(400).json({ error: "Invalid email or token" });
    }

    const user = found[0];

    if (user.resetToken !== token) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await dbClient
      .update(usersTable)
      .set({
        password: hashedPassword,
        resetToken: null, // 👈 clear
        updatedAt: new Date(),
      })
      .where(eq(usersTable.userID, user.userID));

    res.json({ message: "Password reset successful. Please login." });
  } catch (err) {
    next(err);
  }
});

/* ============ GET CURRENT USER ============ */
authRouter.get("/me", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET!) as {
      userId: number;
      email: string;
      role: string;
    };

    const found = await dbClient
      .select()
      .from(usersTable)
      .where(eq(usersTable.userID, payload.userId));

    if (found.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = found[0];
    res.json({
      id: user.userID,
      name: user.name,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
});


export { authRouter };
