// src/routes/products.ts
import { Router } from "express";
import multer from "multer";
import crypto from "crypto";
import { dbClient } from "../../db/client.ts";
import { products, productVariants } from "../../db/schema.ts";
import { eq } from "drizzle-orm";
import { minioClient, BUCKET_NAME, ensureBucket } from "../services/minioClient.ts";

const productsRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

const BUCKET = "product-images";

/* ---------------- CREATE ---------------- */
productsRouter.post("/", upload.single("image"), async (req, res, next) => {
  try {
    const { pname, description, basePrice, pcId } = req.body;

    let imageUrl = req.body.primaryImageUrl || null;

    if (req.file) {
      const filename = `${crypto.randomUUID()}.jpg`;
      await minioClient.putObject(BUCKET, filename, req.file.buffer);
      imageUrl = `http://localhost:9000/${BUCKET}/${filename}`;
    }

    const inserted = await dbClient
      .insert(products)
      .values({
        pname,
        description,
        basePrice,
        pcId: pcId ? Number(pcId) : null,
        primaryImageUrl: imageUrl,
        images: imageUrl ? [imageUrl] : [],
      })
      .returning();

    res.status(201).json(inserted[0]);
  } catch (err) {
    next(err);
  }
});

/* ---------------- READ ---------------- */
productsRouter.get("/", async (_req, res, next) => {
  try {
    const all = await dbClient.select().from(products);
    res.json(all);
  } catch (err) {
    next(err);
  }
});

productsRouter.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const found = await dbClient
      .select()
      .from(products)
      .where(eq(products.pId, Number(id)));

    if (found.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    const variants = await dbClient
      .select()
      .from(productVariants)
      .where(eq(productVariants.pId, Number(id)));

    res.json({ ...found[0], variants });
  } catch (err) {
    next(err);
  }
});

/* ---------------- UPDATE ---------------- */
productsRouter.put("/:id", upload.single("image"), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { pname, description, basePrice, pcId } = req.body;

    let imageUrl = req.body.primaryImageUrl || null;

    if (req.file) {
      const filename = `${crypto.randomUUID()}.jpg`;
      await minioClient.putObject(BUCKET, filename, req.file.buffer);
      imageUrl = `http://localhost:9000/${BUCKET}/${filename}`;
    }

    const updated = await dbClient
      .update(products)
      .set({
        pname,
        description,
        basePrice,
        pcId: pcId ? Number(pcId) : null,
        primaryImageUrl: imageUrl,
      })
      .where(eq(products.pId, Number(id)))
      .returning();

    if (updated.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    res.json(updated[0]);
  } catch (err) {
    next(err);
  }
});

/* ---------------- Delete Product ---------------- */
productsRouter.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const pid = Number(id);

    if (!pid) return res.status(400).json({ message: "Invalid product id" });

    // หา product
    const found = await dbClient.select().from(products).where(eq(products.pId, pid));
    if (found.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    const product = found[0];

    // ลบ variants ก่อน (เพราะมี foreign key)
    await dbClient.delete(productVariants).where(eq(productVariants.pId, pid));

    // ลบรูปจาก MinIO ถ้ามี
    if (product.primaryImageUrl) {
      try {
        const key = product.primaryImageUrl.split("/").pop(); // ดึงชื่อไฟล์จาก URL
        if (key) {
          await minioClient.removeObject(BUCKET_NAME, key);
          console.log(`🗑️ Deleted image from MinIO: ${key}`);
        }
      } catch (e) {
        console.warn("⚠️ Failed to delete from MinIO:", e);
      }
    }

    // ลบ product ออกจาก DB
    await dbClient.delete(products).where(eq(products.pId, pid));

    res.json({ message: "✅ Product deleted successfully" });
  } catch (err) {
    next(err);
  }
});

export { productsRouter };