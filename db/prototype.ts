import { eq } from "drizzle-orm";
import { dbClient, dbConn } from "@db/client.js";
import { users } from "@db/schema.js";

/* INSERT */
async function insertUser() {
  await dbClient.insert(users).values({
    name: "Alice",
    email: "alice@example.com",
    password: "hashed_password_here",
  });
  console.log("✅ Inserted user Alice");
  dbConn.end();
}

/* QUERY */
async function queryUsers() {
  const results = await dbClient.query.users.findMany();
  console.log("📌 Users:", results);
  dbConn.end();
}

/* UPDATE */
async function updateUser() {
  const results = await dbClient.query.users.findMany();
  if (results.length === 0) return dbConn.end();

  const id = results[0].userID;
  await dbClient
    .update(users)
    .set({ name: "Alice Wonderland" })
    .where(eq(users.userID, id));

  console.log(`✏️ Updated userID ${id}`);
  dbConn.end();
}

/* DELETE */
async function deleteUser() {
  const results = await dbClient.query.users.findMany();
  if (results.length === 0) return dbConn.end();

  const id = results[0].userID;
  await dbClient.delete(users).where(eq(users.userID, id));

  console.log(`🗑️ Deleted userID ${id}`);
  dbConn.end();
}

// 🔽 ลองสลับคอมเมนต์ เพื่อรันทดสอบทีละฟังก์ชัน
// insertUser();
// queryUsers();
// updateUser();
// deleteUser();
