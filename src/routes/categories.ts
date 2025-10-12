// src/routes/categories.ts
import { Router } from "express";
import { dbClient } from "../../db/client.js";
import { categories, products, productVariants } from "../../db/schema.js";
import { eq, ilike, sql } from "drizzle-orm";

const categoriesRouter = Router();

/** GET /api/categories */
categoriesRouter.get("/", async (req, res, next) => {
  try {
    const rows = await dbClient.select().from(categories);
    const mapped = rows.map(r => ({
      id: r.cId,
      name: r.pcname
    }));
    res.json(mapped);
  } catch (err) {
    next(err);
  }
});


/** ✅ GET /api/categories/:slugOrId */
categoriesRouter.get("/:slugOrId", async (req, res, next) => {
  try {
    const slug = req.params.slugOrId;

    const [category] = await dbClient
      .select()
      .from(categories)
      .where(
        eq(
          sql`LOWER(${categories.pcname})`, // แปลงเป็น lowercase ฝั่ง SQL
          slug.toLowerCase()                // เทียบ lowercase slug
        )
      )
  .limit(1);

    if (!category)
      return res.status(404).json({ message: "Category not found" });

    // ✅ ดึงสินค้าเฉพาะหมวดนั้น โดยไม่ JOIN variant ซ้ำ
    const prods = await dbClient
      .selectDistinctOn([products.pId]) // ✅ ป้องกันซ้ำ
      .from(products)
      .where(eq(products.pcId, category.cId));

    res.json({
      category,
      products: prods,
    });
  } catch (err) {
    next(err);
  }
});


export default categoriesRouter;
