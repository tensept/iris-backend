// src/routes/products.ts
import { Router } from "express";
import multer from "multer";
import crypto from "crypto";
import { and, eq, ilike, sql } from "drizzle-orm";
import { dbClient } from "../../db/client.ts";
import { products, productVariants, categories } from "../../db/schema.ts";
import { minioClient, BUCKET_NAME } from "../services/minioClient.ts";

const newSku = crypto.randomUUID(); // สร้าง SKU แบบง่าย
const productsRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

/* ---------- MinIO URL base จาก .env ---------- */
const MINIO_PUBLIC_BASE = (
  process.env.MINIO_PUBLIC_URL ||
  `http://${process.env.MINIO_ENDPOINT || "localhost"}:${
    process.env.MINIO_PORT || 9000
  }`
).replace(/\/$/, "");

const makePublicUrl = (key: string) =>
  `${MINIO_PUBLIC_BASE}/${BUCKET_NAME}/${key}`;

/* ---------- helper: upload buffer -> MinIO ---------- */
async function uploadBufferToMinio(buf: Buffer, contentType?: string) {
  const key = `${crypto.randomUUID()}.jpg`;
  await minioClient.putObject(
    BUCKET_NAME,
    key,
    buf,
    buf.length, // ✅ ต้องส่งความยาวบัฟเฟอร์
    { "Content-Type": contentType || "application/octet-stream" } // ✅ header
  );
  return makePublicUrl(key);
}

/* ========================= CREATE ========================= */
// productsRouter.post("/", upload.single("image"), async (req, res, next) => {
//   try {
//     const { pname, description, basePrice, pcId } = req.body;

//     let imageUrl: string | null =
//       (req.body.primaryImageUrl as string | undefined) || null;

//     if (req.file) {
//       imageUrl = await uploadBufferToMinio(req.file.buffer, req.file.mimetype);
//     }

//     const inserted = await dbClient
//       .insert(products)
//       .values({
//         pname,
//         description: description ?? null,
//         basePrice: String(basePrice ?? "0.00"),
//         pcId: pcId ? Number(pcId) : null,
//         primaryImageUrl: imageUrl,
//         images: imageUrl ? [imageUrl] : [],
//       })
//       .returning();

//     res.status(201).json(inserted[0]);
//   } catch (err) {
//     next(err);
//   }
// });


/* ========================= CREATE ========================= */
productsRouter.post("/", upload.single("image"), async (req, res, next) => {
  try {
    const { pname, description, basePrice, pcId, primaryImageUrl, images } = req.body;

    // --- แปลง variants เป็น array จริง ---
    let variants: any[] = [];
    if (req.body.variants) {
      variants = typeof req.body.variants === "string" ? JSON.parse(req.body.variants) : req.body.variants;
    }
    console.log("Variants received:", variants);

    // --- อัปโหลด primary image ---
    let finalImageUrl: string | null = primaryImageUrl || null;
    if (req.file) {
      finalImageUrl = await uploadBufferToMinio(req.file.buffer, req.file.mimetype);
    }

    // --- Insert product ---
    const inserted = await dbClient.insert(products).values({
      pname,
      description: description ?? null,
      basePrice: basePrice ? String(basePrice) : "0.00",
      pcId: pcId ? Number(pcId) : null,
      primaryImageUrl: finalImageUrl,
      images: images ? images : finalImageUrl ? [finalImageUrl] : [],
    }).returning();

    const productId = inserted[0].pId;

    // --- Insert variants ---
    if (variants.length) {
      for (const v of variants) {
        await dbClient.insert(productVariants).values({
          pId: productId,
          sku: crypto.randomUUID(),
          shadeName: v.shadeName ?? "",
          shadeCode: v.shadeCode ?? "",
          price: v.price ? String(v.price) : "0",
          stockQty: v.stockQty ? Number(v.stockQty) : 0,
          imageUrl: v.imageUrl ?? null,
        });
      }
    }

    res.status(201).json({ ...inserted[0], variants });
  } catch (err) {
    next(err);
  }
});



/* =================== LIST (filters/sort) ===================
   GET /products?category=LIPS&q=lip&sort=priceAsc|priceDesc|newest&limit=24&page=1
*/
productsRouter.get("/", async (req, res, next) => {
  try {
    const {
      category,
      q,
      sort,
      limit = "24",
      page = "1",
    } = req.query as Record<string, string | undefined>;

    const lim = Math.min(Math.max(Number(limit) || 24, 1), 100);
    const pg = Math.max(Number(page) || 1, 1);
    const offset = (pg - 1) * lim;

    const conds: any[] = [];

    // filter by category (ถ้ามี)
    if (category) {
      const cat = await dbClient
        .select()
        .from(categories)
        .where(eq(categories.pcname, String(category).toUpperCase()));
      if (!cat.length) return res.json([]);
      conds.push(eq(products.pcId, cat[0].cId));
    }

    // search (ถ้ามี)
    if (q && q.trim()) {
      conds.push(ilike(products.pname, `%${q.trim()}%`));
    }

    // เตรียม orderBy (ถ้าไม่มีจะเป็นอาร์เรย์ว่าง → ชนิดไม่พัง)
    const orderExpr: any[] = [];
    if (sort === "priceAsc") {
      orderExpr.push(sql`(${products.basePrice}::numeric) ASC`);
    } else if (sort === "priceDesc") {
      orderExpr.push(sql`(${products.basePrice}::numeric) DESC`);
    } else if (sort === "newest") {
      orderExpr.push(sql`${products.createdAt} DESC`);
    }

    const rows = await dbClient
      .select()
      .from(products)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(...orderExpr) // ✅ ใส่ก่อน limit/offset และไม่ส่ง undefined
      .limit(lim)
      .offset(offset);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/* ================ DETAIL + VARIANTS ================= */
productsRouter.get("/:id", async (req, res, next) => {
  try {
    const pid = Number(req.params.id);
    const found = await dbClient
      .select()
      .from(products)
      .where(eq(products.pId, pid));
    if (!found.length)
      return res.status(404).json({ message: "Product not found" });

    const variants = await dbClient
      .select()
      .from(productVariants)
      .where(eq(productVariants.pId, pid));

    res.set("Cache-Control", "no-store").json({ ...found[0], variants });
  } catch (err) {
    next(err);
  }
});

/* ================ RELATED (same category) =================
   GET /products/:id/related?limit=8
*/
productsRouter.get("/:id/related", async (req, res, next) => {
  try {
    const pid = Number(req.params.id);
    const lim = Math.min(Math.max(Number(req.query.limit) || 8, 1), 20);

    const base = await dbClient
      .select()
      .from(products)
      .where(eq(products.pId, pid));
    if (!base.length || base[0].pcId == null) return res.json([]);

    const same = await dbClient
      .select()
      .from(products)
      .where(
        and(eq(products.pcId, base[0].pcId), sql`${products.pId} <> ${pid}`)
      )
      .limit(lim);

    res.set("Cache-Control", "no-store").json(same);
  } catch (err) {
    next(err);
  }
});

/* ========================= UPDATE ========================= */
// productsRouter.put("/:id", upload.single("image"), async (req, res, next) => {
//   try {
//     const pid = Number(req.params.id);
//     const ex = await dbClient.select().from(products).where(eq(products.pId, pid));
//     if (!ex.length) return res.status(404).json({ message: "Product not found" });

//     const { pname, description, basePrice, pcId } = req.body;

//     let imageUrl: string | null =
//       (req.body.primaryImageUrl as string | undefined) ?? ex[0].primaryImageUrl;

//     if (req.file) {
//       imageUrl = await uploadBufferToMinio(req.file.buffer, req.file.mimetype);
//     }

//     const updated = await dbClient
//       .update(products)
//       .set({
//         pname: pname ?? ex[0].pname,
//         description: description ?? ex[0].description,
//         basePrice: String(basePrice ?? ex[0].basePrice),
//         pcId: pcId ? Number(pcId) : ex[0].pcId,
//         primaryImageUrl: imageUrl,
//       })
//       .where(eq(products.pId, pid))
//       .returning();

//     res.json(updated[0]);
//   } catch (err) {
//     next(err);
//   }
// });

// productsRouter.put("/:id", upload.single("image"), async (req, res, next) => {
//   try {
//     const pid = Number(req.params.id);
//     const ex = await dbClient
//       .select()
//       .from(products)
//       .where(eq(products.pId, pid));
//     if (!ex.length)
//       return res.status(404).json({ message: "Product not found" });

//     const {
//       pname,
//       description,
//       basePrice,
//       pcId,
//       primaryImageUrl,
//       images,
//       shadeName,
//       shadeCode,

//       stockQty,
//       imageUrl,
//     } = req.body;

//     // --- อัปเดตรูปถ้ามี ---
//     let finalImageUrl = primaryImageUrl ?? ex[0].primaryImageUrl;
//     if (req.file) {
//       finalImageUrl = await uploadBufferToMinio(
//         req.file.buffer,
//         req.file.mimetype
//       );
//     }

//     // --- update product ---
//     const updatedProduct = await dbClient
//       .update(products)
//       .set({
//         pname: pname ?? ex[0].pname,
//         description: description ?? ex[0].description,
//         basePrice: basePrice ? String(basePrice) : ex[0].basePrice,
//         pcId: pcId ? Number(pcId) : ex[0].pcId,
//         primaryImageUrl: finalImageUrl,
//         images: images ? images : ex[0].images,
//       })
//       .where(eq(products.pId, pid))
//       .returning();

//     // --- update / insert variant ---
//     if (shadeName || shadeCode || basePrice || stockQty || imageUrl) {
//       const existingVariants = await dbClient
//         .select()
//         .from(productVariants)
//         .where(eq(productVariants.pId, pid));

//       if (existingVariants.length) {
//         // update first variant
//         await dbClient
//           .update(productVariants)
//           .set({
//             shadeName: shadeName ?? existingVariants[0].shadeName,
//             shadeCode: shadeCode ?? existingVariants[0].shadeCode,
//             price: basePrice ? String(basePrice) : existingVariants[0].price,
//             stockQty: stockQty
//               ? Number(stockQty)
//               : existingVariants[0].stockQty,
//             imageUrl: imageUrl ?? existingVariants[0].imageUrl,
//           })
//           .where(eq(productVariants.id, existingVariants[0].id));
//       } else {
//         // insert new variant
//         await dbClient.insert(productVariants).values({
//           pId: pid,
//           sku: `SKU-${pid}-${crypto.randomUUID().slice(0, 8)}`, // ✅ สร้างใหม่ทุก variant
//           shadeName: shadeName ?? "",
//           shadeCode: shadeCode ?? "",
//           price: basePrice ? String(basePrice) : "0",
//           stockQty: stockQty ? Number(stockQty) : 0,
//           imageUrl: imageUrl ?? null,
//         });
//       }
//     }

//     res.json({
//       message: "✅ Product updated",
//       product: updatedProduct[0],
//     });
//   } catch (err) {
//     next(err);
//   }
// });

productsRouter.put("/:id", upload.single("image"), async (req, res, next) => {
  try {
    const pid = Number(req.params.id);
    const ex = await dbClient.select().from(products).where(eq(products.pId, pid));
    if (!ex.length) return res.status(404).json({ message: "Product not found" });

    const { pname, description, basePrice, pcId, primaryImageUrl, images } = req.body;

    let variants: any[] = [];
    if (req.body.variants) {
      variants = typeof req.body.variants === "string" ? JSON.parse(req.body.variants) : req.body.variants;
    }

    // --- อัปโหลด primary image ---
    let finalImageUrl = primaryImageUrl ?? ex[0].primaryImageUrl;
    if (req.file) {
      finalImageUrl = await uploadBufferToMinio(req.file.buffer, req.file.mimetype);
    }

    // --- Update product ---
    const updatedProduct = await dbClient.update(products).set({
      pname: pname ?? ex[0].pname,
      description: description ?? ex[0].description,
      basePrice: basePrice ? String(basePrice) : ex[0].basePrice,
      pcId: pcId ? Number(pcId) : ex[0].pcId,
      primaryImageUrl: finalImageUrl,
      images: images ? images : ex[0].images,
    }).where(eq(products.pId, pid)).returning();

    // --- Update / Insert variants ---
    for (const v of variants) {
      if (v.id) {
        // update existing
        await dbClient.update(productVariants).set({
          shadeName: v.shadeName ?? "",
          shadeCode: v.shadeCode ?? "",
          price: v.price ? String(v.price) : "0",
          stockQty: v.stockQty ? Number(v.stockQty) : 0,
          imageUrl: v.imageUrl ?? null,
        }).where(eq(productVariants.id, v.id));
      } else {
        // insert new
        await dbClient.insert(productVariants).values({
          pId: pid,
          sku: crypto.randomUUID(),
          shadeName: v.shadeName ?? "",
          shadeCode: v.shadeCode ?? "",
          price: v.price ? String(v.price) : "0",
          stockQty: v.stockQty ? Number(v.stockQty) : 0,
          imageUrl: v.imageUrl ?? null,
        });
      }
    }

    res.json({ message: "✅ Product updated", product: updatedProduct[0] });
  } catch (err) {
    next(err);
  }
});


/* ========================= DELETE ========================= */
productsRouter.delete("/:id", async (req, res, next) => {
  try {
    const pid = Number(req.params.id);
    if (!pid) return res.status(400).json({ message: "Invalid product id" });

    const found = await dbClient
      .select()
      .from(products)
      .where(eq(products.pId, pid));
    if (!found.length)
      return res.status(404).json({ message: "Product not found" });

    await dbClient.delete(productVariants).where(eq(productVariants.pId, pid));
    await dbClient.delete(products).where(eq(products.pId, pid));

    // (ถ้าจะลบไฟล์ MinIO ด้วย ให้ดึง key แล้ว removeObject ที่นี่)
    res.json({ message: "✅ Product deleted successfully" });
  } catch (err) {
    next(err);
  }
});

export { productsRouter };
