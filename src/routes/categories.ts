import { Router } from "express";
import { dbClient } from "../../db/client.ts";
import { categories } from "../../db/schema.ts";

const categoriesRouter = Router();

// GET /api/categories
categoriesRouter.get("/", async (req, res) => {
  try {
    // ดึง column cId และ pcname ออกมา
    const result = await dbClient
      .select({
        id: categories.cId,
        name: categories.pcname,
      })
      .from(categories);

    // แปลงค่าว่างหรือ undefined เป็น string ปลอดภัย
    const mapped = result.map((c) => ({
      id: c.id,
      name: c.name || "",
    }));

    res.json(mapped);
  } catch (err) {
    console.error("Error fetching categories:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default categoriesRouter;
