// src/routes/admin/users.ts
import { Router } from "express";
import { dbClient } from "../../../db/client.ts";
import { users } from "../../../db/schema.ts";

const usersRouter = Router();

usersRouter.get("/", async (req, res) => {
  try {
    const allUsers = await dbClient.select().from(users);
    res.json(allUsers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch users" });
  }
});

export default usersRouter;
