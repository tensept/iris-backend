import "dotenv/config";
import bcrypt from "bcrypt";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { users } from "../db/schema.ts";

const DB_URL = process.env.DATABASE_URL!;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL!;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!;
const ADMIN_NAME = process.env.ADMIN_NAME ?? "Administrator";
const SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS ?? 10);

if (!DB_URL) throw new Error("Missing DATABASE_URL in .env");
if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  throw new Error("Please set ADMIN_EMAIL and ADMIN_PASSWORD in .env");
}

async function main() {
  const sql = postgres(DB_URL, { max: 1 });
  const db = drizzle(sql);

  const hashed = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);

  const existing = await db.select().from(users).where(eq(users.email, ADMIN_EMAIL));
  if (existing.length) {
    await db
      .update(users)
      .set({
        password: hashed,
        role: "ADMIN",
        emailVerifiedAt: new Date(),
        verifyToken: null,
        updatedAt: new Date(),
      })
      .where(eq(users.email, ADMIN_EMAIL));
    console.log(`✅ Upgraded ${ADMIN_EMAIL} to ADMIN & reset password.`);
  } else {
    await db.insert(users).values({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL,
      password: hashed,
      role: "ADMIN",
      emailVerifiedAt: new Date(),
    });
    console.log(`✅ Created ADMIN user: ${ADMIN_EMAIL}`);
  }

  await sql.end({ timeout: 5 });
}

main().catch((e) => {
  console.error("❌ admin:seed failed:", e);
  process.exit(1);
});
