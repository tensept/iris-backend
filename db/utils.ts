// import "dotenv/config";

// const dbUser = process.env.POSTGRES_APP_USER;
// const dbPassword = process.env.POSTGRES_APP_PASSWORD;
// const dbHost = process.env.POSTGRES_HOST;
// const dbPort = process.env.POSTGRES_PORT;
// const dbName = process.env.POSTGRES_DB;

// console.log({
//   dbUser,
//   dbPassword,
//   dbHost,
//   dbPort,
//   dbName,
// });

// if (!dbUser || !dbPassword || !dbHost || !dbName || !dbName) {
//   throw new Error("Invalid DB env.");
// }

// export const connectionString = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

import "dotenv/config";

let connectionString: string;

if (process.env.DATABASE_URL) {
  connectionString = process.env.DATABASE_URL!;
} else {
  const dbUser = process.env.POSTGRES_APP_USER || process.env.POSTGRES_USER;
  const dbPassword =
    process.env.POSTGRES_APP_PASSWORD || process.env.POSTGRES_PASSWORD;
  const dbHost = process.env.POSTGRES_HOST || "localhost";
  const dbPort = process.env.POSTGRES_PORT || "5432";
  const dbName = process.env.POSTGRES_DB || process.env.POSTGRES_APP_DB; // อย่างน้อยให้มี POSTGRES_DB

  const missing: string[] = [];
  if (!dbUser) missing.push("POSTGRES_APP_USER/POSTGRES_USER");
  if (!dbPassword) missing.push("POSTGRES_APP_PASSWORD/POSTGRES_PASSWORD");
  if (!dbName) missing.push("POSTGRES_DB");

  if (missing.length) {
    throw new Error(`Invalid DB env: missing ${missing.join(", ")}`);
  }

  connectionString = `postgres://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;
}

export { connectionString };
