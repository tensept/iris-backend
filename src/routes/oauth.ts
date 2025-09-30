// src/routes/oauth.ts
import { Router } from "express";
import passport from "passport";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { eq } from "drizzle-orm";

import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as FacebookStrategy } from "passport-facebook";

import { dbClient } from "../../db/client.js";
import { users as usersTable } from "../../db/schema.js";

const oauthRouter = Router();
const JWT_SECRET = process.env.JWT_SECRET!;
const FRONTEND_URL = process.env.FRONTEND_URL!;
const BACKEND_URL = process.env.BACKEND_URL!;

/* ---------------- Helpers ---------------- */
async function issueTokensAndRedirect(res: any, user: any, to = "/home") {
  // access token
  const accessToken = jwt.sign(
    {
      userId: user.userID,
      email: user.email,
      role: user.role,
       name: user.name, 
      avatar: user.avatar || null, // 👈 แนบ avatar เข้า token ด้วย
    },
    JWT_SECRET,
    { expiresIn: "1h" }
  );

  // refresh token -> เก็บใน DB + cookie
  const refreshToken = crypto.randomBytes(40).toString("hex");
  await dbClient
    .update(usersTable)
    .set({ refreshToken })
    .where(eq(usersTable.userID, user.userID));

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  // redirect กลับ frontend พร้อม accessToken + avatar
  res.redirect(
    `${FRONTEND_URL}${to}?token=${accessToken}&avatar=${
      encodeURIComponent(user.avatar || "")
    }`
  );
}

// หา/สร้าง user จากอีเมล
async function findOrCreateByEmail(email: string, displayName?: string) {
  const found = await dbClient.select().from(usersTable).where(eq(usersTable.email, email));
  if (found.length > 0) {
    // ensure verified
    if (!found[0].emailVerifiedAt) {
      await dbClient
        .update(usersTable)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(usersTable.userID, found[0].userID));
      const refreshed = await dbClient.select().from(usersTable).where(eq(usersTable.userID, found[0].userID));
      return refreshed[0];
    }
    return found[0];
  }
  const inserted = await dbClient
    .insert(usersTable)
    .values({
      email,
      name: displayName || email.split("@")[0],
      role: "CUSTOMER",
      emailVerifiedAt: new Date(),
    })
    .returning();
  return inserted[0];
}

/* ---------------- Google ---------------- */
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      callbackURL: `${BACKEND_URL}/auth/google/callback`,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) return done(new Error("No email from Google"));

        const avatar = profile.photos?.[0]?.value; // 👈 avatar จาก Google
        const user = await findOrCreateByEmail(email, profile.displayName || "Google User");

        return done(null, { ...user, avatar }); // 👈 inject avatar
      } catch (e) {
        return done(e);
      }
    }
  )
);

oauthRouter.get("/google",
  passport.authenticate("google", { scope: ["profile", "email"], session: false })
);

oauthRouter.get(
  "/google/callback",
  passport.authenticate("google", { session: false, failureRedirect: `${FRONTEND_URL}/login` }),
  async (req: any, res) => {
    await issueTokensAndRedirect(res, req.user);
  }
);

/* ---------------- Facebook ---------------- */
passport.use(
  new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_CLIENT_ID!,
      clientSecret: process.env.FACEBOOK_CLIENT_SECRET!,
      callbackURL: `${BACKEND_URL}/auth/facebook/callback`,
      profileFields: ["id", "displayName", "emails", "photos"], // ขอ name + email + avatar
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        const avatar = profile.photos?.[0]?.value;
        const name =
          profile.displayName ||
          (email ? email.split("@")[0] : "Facebook User"); // 👈 name เสมอ

        if (!email) {
          // ถ้าไม่มี email → ใช้ id จำลองเป็น email
          const pseudoEmail = `${profile.id}@facebook.local`;
          const user = await findOrCreateByEmail(pseudoEmail, name);
          return done(null, { ...user, avatar, name });
        }

        const user = await findOrCreateByEmail(email, name);
        return done(null, { ...user, avatar, name }); // 👈 inject name
      } catch (e) {
        return done(e);
      }
    }
  )
);


oauthRouter.get("/facebook",
  passport.authenticate("facebook", { scope: ["email"], session: false })
);

oauthRouter.get(
  "/facebook/callback",
  passport.authenticate("facebook", { session: false, failureRedirect: `${FRONTEND_URL}/login` }),
  async (req: any, res) => {
    await issueTokensAndRedirect(res, req.user);
  }
);

export { oauthRouter };
