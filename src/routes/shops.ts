// src/routes/shop.ts
import { Router } from "express";
import { dbClient } from "../../db/client.ts";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { products, categories, } from "../../db/schema.ts"; // ถ้าไม่มี orderItems ให้คอมเมนต์ส่วน bestsellers แบบสรุปได้

const shopsRouter = Router();

/** GET /api/products?category=&q=&sort=&page=&pageSize= */
shopsRouter.get("/products", async (req, res, next) => {
  try {
    const { category, q, sort } = req.query as {
      category?: string;
      q?: string;
      sort?: "priceAsc" | "priceDesc";
    };

    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 24));
    const offset = (page - 1) * pageSize;

    const wheres: any[] = [];
    if (q && q.trim()) wheres.push(ilike(products.pname, `%${q.trim()}%`));

    let useJoin = false;
    if (category) {
      if (/^\d+$/.test(category)) {
        wheres.push(eq(products.pcId, Number(category)));
      } else {
        useJoin = true;
        // ไม่สนตัวพิมพ์
        wheres.push(ilike(categories.pcname, String(category)));
      }
    }

    const orderBy =
      sort === "priceAsc" ? asc(products.basePrice)
      : sort === "priceDesc" ? desc(products.basePrice)
      : asc(products.pId);

    const baseSelect = dbClient
      .select({
        id: products.pId,
        name: products.pname,
        price: products.basePrice,
        primary_image_url: products.primaryImageUrl,
      })
      .from(products);

    const rows = await (useJoin
      ? baseSelect.leftJoin(categories, eq(products.pcId, categories.cId))
      : baseSelect
    )
      .where(wheres.length ? and(...wheres) : undefined)
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset);

    const countQuery = dbClient
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(products);

    const [{ count }] = await (useJoin
      ? countQuery.leftJoin(categories, eq(products.pcId, categories.cId))
      : countQuery
    ).where(wheres.length ? and(...wheres) : undefined);

    res.json({
      page,
      pageSize,
      total: count,
      items: rows.map(r => ({
        id: r.id,
        name: r.name,
        price: Number(r.price ?? 0),
        primary_image_url: r.primary_image_url,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/** GET /api/shop/bestsellers  (ตัวอย่าง: ยอดขายรวมสูงสุด 8 ชิ้น) */
shopsRouter.get("/bestsellers", async (req, res, next) => {
  try {
    // ถ้ามีตาราง order_items
    const rows = await dbClient.execute(sql`
      SELECT p."p_id" as id,
             p."pname" as name,
             p."base_price" as price,
             p."primary_image_url" as primary_image_url,
             COALESCE(SUM(oi."qty"), 0) as sold
      FROM "products" p
      LEFT JOIN "order_items" oi ON oi."product_id" = p."p_id"
      GROUP BY p."p_id", p."pname", p."base_price", p."primary_image_url"
      ORDER BY sold DESC
      LIMIT 8
    `);

    // ถ้าไม่มีข้อมูลขาย ให้ fallback เป็นสินค้าใหม่ล่าสุด
    const data = (rows as any[]).length ? rows as any[] : await dbClient
      .select({
        id: products.pId,
        name: products.pname,
        price: products.basePrice,
        primary_image_url: products.primaryImageUrl,
      })
      .from(products)
      .orderBy(desc(products.createdAt))
      .limit(8);

    res.json({ items: data.map((r:any)=>({
      id: Number(r.id),
      name: r.name,
      price: Number(r.price ?? 0),
      primary_image_url: r.primary_image_url
    })) });
  } catch (e) {
    next(e);
  }
});

export { shopsRouter } ;
