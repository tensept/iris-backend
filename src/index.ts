// src/index.ts
import "dotenv/config";
import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import Debug from "debug";
import jwt from "jsonwebtoken";
import passport from "passport";
import cookieParser from "cookie-parser";

import { and, eq, ilike } from "drizzle-orm";
import { dbClient } from "@db/client.js";

import { authRouter } from "./routes/auth.ts";
import { oauthRouter } from "./routes/oauth.ts";
import { uploadRouter } from "./routes/upload.ts";
import { productsRouter } from "./routes/products.ts";
import { shopsRouter } from "./routes/shops.ts";
import categoriesRouter from "./routes/categories.ts";
import cartRouter from "./routes/cart.ts"; // ✅ นำเข้า cartRouter (default export)
import paymentRouter from "./routes/payment.js";
import ordersRouter from "./routes/orders.js";

import {
  users,
  products,
  productVariants,
  carts,
  cartItems,
  orders,
  orderItems,
} from "@db/schema.js";

const debug = Debug("fs-backend");
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173"; // ✅ ใช้ env/ค่าดีฟอลต์

/* ======================= Init ======================= */
const app = express();

app.set("etag", false); // ป้องกัน 304 ที่อาจกวน API

// Logging มาก่อนเพื่อเห็นทุก request
app.use(morgan("dev"));

// CORS ต้องมาก่อน routers ทั้งหมด
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "X-CSRF-Token",
    ],
    optionsSuccessStatus: 204,
  })
);

// ความปลอดภัยเบื้องต้น
app.use(helmet());

// ต้องมีเพื่ออ่าน cookies ใน authMiddleware
app.use(cookieParser());

// body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// กัน cache สำหรับ API ทั้งหมด
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  next();
});

/* ================ 🔐 Auth Middleware (Header + Cookie) ================ */
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // 1) Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  let token: string | undefined = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : undefined;

  // 2) หรืออ่านจาก cookie
  if (!token) {
    token = (req as any).cookies?.token || (req as any).cookies?.access_token;
  }

  if (!token) {
    return res.status(401).json({ message: "Missing token" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      userId: number;
      role?: string;
    };
    (req as any).user = payload; // { userId, role? }
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

/* ======================= Routers ======================= */

// สาธารณะ (ไม่ต้องล็อกอิน)
app.use("/files", uploadRouter);
app.use("/api/products", productsRouter);

// Auth
app.use("/auth", authRouter);
app.use(passport.initialize());
app.use("/auth", oauthRouter);

// ตัวอย่าง route admin
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user || user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admins only" });
  }
  next();
}

app.get("/users", authMiddleware, requireAdmin, async (req, res, next) => {
  try {
    const result = await dbClient.select().from(users);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// products (ตัวอย่างสั้น ๆ ที่เหลือคุณมีอยู่แล้ว)
app.get("/products", async (req, res, next) => {
  try {
    const result = await dbClient.select().from(products);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post("/products", authMiddleware, async (req, res, next) => {
  try {
    const {
      pname,
      description,
      basePrice,
      pcId,
      primaryImageUrl,
      images,
      shadeName,
      shadeCode,
      price,
      stockQty,
      imageUrl,
    } = req.body;

    if (!pname || basePrice == null) {
      return res.status(400).json({ message: "Missing pname or basePrice" });
    }

    const insertedProduct = await dbClient
      .insert(products)
      .values({
        pname,
        description: description || "",
        basePrice: basePrice.toString(),
        pcId: pcId || null,
        primaryImageUrl: primaryImageUrl || null,
        images: images || null,
      })
      .returning();

    const insertedVariant = await dbClient
      .insert(productVariants)
      .values({
        pId: insertedProduct[0].pId,
        sku: `SKU-${Date.now()}`,
        shadeName: shadeName || null,
        shadeCode: shadeCode || null,
        price: (price ?? basePrice).toString(),
        stockQty: stockQty ?? 0,
        imageUrl: imageUrl || null,
      })
      .returning();

    res.status(201).json({
      product: insertedProduct[0],
      variant: insertedVariant[0],
    });
  } catch (err) {
    next(err);
  }
});

// ร้านค้าอื่น ๆ
app.use("/api/shop", shopsRouter);

/* Product details + variants */
app.get("/products/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const product = await dbClient
      .select()
      .from(products)
      .where(eq(products.pId, Number(id)));

    if (product.length === 0) {
      return res.status(404).json({ message: "Product not found" });
    }

    const variants = await dbClient
      .select()
      .from(productVariants)
      .where(eq(productVariants.pId, Number(id)));

    res.json({ ...product[0], variants });
  } catch (err) {
    next(err);
  }
});

/* ==================== Cart ==================== */
app.get("/cart", authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).user.userId;

    const cart = await dbClient
      .select()
      .from(carts)
      .where(eq(carts.userID, userId));

    if (cart.length === 0) {
      return res.json({ items: [] });
    }

    const items = await dbClient
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, cart[0].id));

    res.json({ ...cart[0], items });
  } catch (err) {
    next(err);
  }
});


// ตรงนี้ต้อง mount หลังจาก init express
app.use("/api/categories", categoriesRouter);


app.post("/cart/add", authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).user.userId;
    const { variantId, qty } = req.body;

    if (!variantId || !qty) {
      return res.status(400).json({ message: "Missing variantId or qty" });
    }

    // หา cart ของ user
    let cart = await dbClient
      .select()
      .from(carts)
      .where(eq(carts.userID, userId));

    if (cart.length === 0) {
      const inserted = await dbClient
        .insert(carts)
        .values({ userID: userId })
        .returning();
      cart = inserted;
    }

    // ดึงราคาจาก variant
    const variant = await dbClient
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, variantId));

    if (variant.length === 0) {
      return res.status(404).json({ message: "Variant not found" });
    }

    const unitPrice = parseFloat(variant[0].price);
    const lineTotal = unitPrice * qty;

    // insert cart item
    const insertedItem = await dbClient
      .insert(cartItems)
      .values({
        cartId: cart[0].id,
        variantId,
        qty,
        unitPrice: unitPrice.toFixed(2),
        lineTotal: lineTotal.toFixed(2),
      })
      .returning();

    res.status(201).json(insertedItem[0]);
  } catch (err) {
    next(err);
  }
});
// 🛒 Cart (ต้องล็อกอิน)
app.use("/api/cart", authMiddleware, cartRouter);
app.use("/api/payment", authMiddleware, paymentRouter);
app.use("/api/orders", ordersRouter);

/* ==================== Orders ==================== */
app.get("/orders", authMiddleware, async (req, res, next) => {
  try {
    const userId = (req as any).user.userId;
    const result = await dbClient
      .select()
      .from(orders)
      .where(eq(orders.userID, userId));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get("/orders/:id", authMiddleware, async (req, res, next) => {
  try {
    const { id } = req.params;
    const order = await dbClient
      .select()
      .from(orders)
      .where(eq(orders.id, Number(id)));

    if (order.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    const items = await dbClient
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, Number(id)));

    res.json({ ...order[0], items });
  } catch (err) {
    next(err);
  }
});
/* ============== 404 ============== */
app.use((req, res) => {
  res.status(404).json({ message: "Not found" });
});



/* ============== ⚠️ JSON Error Handler ============== */
const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  debug(err?.message);
  console.error("🔥 Error Handler:", err);
  res.status(500).send({
    message: err?.message || "Internal Server Error",
    type: err?.name || "Error",
    stack: process.env.NODE_ENV === "development" ? err?.stack : undefined,
  });
};
app.use(jsonErrorHandler);



/* =================== 🚀 Start =================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  debug(`Listening on port ${PORT}: http://localhost:${PORT}`);
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
