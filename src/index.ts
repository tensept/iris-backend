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
import { and, eq, ilike } from "drizzle-orm";
import { authRouter } from "./routes/auth.ts";
import passport from "passport";
import { oauthRouter } from "./routes/oauth.ts";
import cookieParser from "cookie-parser";
import { dbClient } from "@db/client.js";
import { uploadRouter } from "./routes/upload.js";
import { productsRouter } from "./routes/products.js";
import crypto from "crypto";
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
const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

/* ======================= Init ======================= */
const app = express();
app.use(morgan("dev"));
app.use(helmet());
app.use(
  cors({
    origin: "http://localhost:5173", // frontend
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());
app.use("/files", uploadRouter);
app.use("/products", productsRouter);
/* ==================== Auth Router ==================== */
/* NOTE: คุณมี authRouter อยู่แล้ว ก็สามารถ mount ต่อไปได้
   เช่น app.use("/auth", authRouter) 
   ถ้ายังไม่พร้อม คอมเมนต์บรรทัดด้านล่างไว้ก่อนก็ได้ */
app.use("/auth", authRouter);
app.use(passport.initialize());
app.use("/auth", oauthRouter);
/* ================ 🔐 Auth Middleware ================ */
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ message: "Missing authorization header" });

  if (!authHeader.startsWith("Bearer "))
    return res
      .status(401)
      .json({ message: "Invalid authorization header format" });

  const token = authHeader.split(" ")[1];
  if (!token)
    return res.status(401).json({ message: "Invalid authorization header" });

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { userId: number };
    (req as any).user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

/* ==================== Users ==================== */
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = (req as any).user;
  if (!user || user.role !== "ADMIN") {
    return res.status(403).json({ message: "Admins only" });
  }
  next();
}

app.get("/users", authMiddleware, requireAdmin, async (req, res, next) => {
  const result = await dbClient.select().from(users);
  res.json(result);
});


/* ==================== Products ==================== */
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
    const { pname, description, basePrice, pcId, primaryImageUrl, images, shadeName, shadeCode, price, stockQty, imageUrl } = req.body;

    if (!pname || !basePrice) {
      return res.status(400).json({ message: "Missing pname or basePrice" });
    }

    // insert product
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

    // insert default variant
    const insertedVariant = await dbClient
      .insert(productVariants)
      .values({
        pId: insertedProduct[0].pId,
        sku: `SKU-${Date.now()}`,     // generate SKU
        shadeName: shadeName || null,
        shadeCode: shadeCode || null,
        price: price?.toString() || basePrice.toString(),
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

// ==================== PromptPay Generator ====================

// ✅ ใส่ type ให้ครบทุกพารามิเตอร์
function generatePromptPayPayload(mobileNumber: string, amount: number): string {
  const id = mobileNumber.replace(/[^0-9]/g, "");
  const amt = amount.toFixed(2);

  // payload มาตรฐานของ Bank of Thailand (EMVCo)
  const payload = `00020101021229370016A00000067701011101130066${id}5802TH530376454${amt
    .replace(".", "")
    .padStart(6, "0")}5802TH6304`;

  const crc = crc16(payload);
  return payload + crc.toUpperCase();
}

// ✅ ใส่ type ให้ str ด้วย
function crc16(str: string): string {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).padStart(4, "0");
}

// // ===== endpoint: get payment QR for specific order =====
// app.get("/orders/:id/payment", async (req, res, next) => {
//   try {
//     const orderId = Number(req.params.id);

//     const order = await dbClient.select().from(orders).where(eq(orders.id, orderId));
//     if (order.length === 0) {
//       return res.status(404).json({ message: "Order not found" });
//     }

//     const items = await dbClient.select().from(orderItems).where(eq(orderItems.orderId, orderId));

//     // mock: เบอร์ PromptPay ร้านค้า
//     const promptpayNumber = "0812345678";
//     const qrPayload = generatePromptPayPayload(promptpayNumber, parseFloat(order[0].grandTotal));

//     res.json({
//       ...order[0],
//       items,
//       promptpayQR: qrPayload,
//       expiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000), // หมดอายุใน 20 ชม.
//     });
//   } catch (err) {
//     next(err);
//   }
// });

// ============ Mock Order API ============ //
app.get("/orders/:id/payment", (req, res) => {
  const orderId = Number(req.params.id);

  // mock order
  const order = {
    id: orderId,
    userID: 1,
    status: "PENDING",
    subtotal: "56.00",
    shippingFee: "0.00",
    discountTotal: "0.00",
    grandTotal: "56.00",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // ✅ mock รายการสินค้าพร้อมรูป
 const items = [
  {
    id: 1,
    name: "Soft Pinch Cheek & Lip Trio",
    shadeName: "Rose Delight",
    unitPrice: "36.00",
    qty: 1,
    lineTotal: "36.00",
    imageUrl:
      "https://images.unsplash.com/photo-1585386959984-a4155223166d?auto=format&fit=crop&w=200&q=80",
  },
  {
    id: 2,
    name: "Rare Eau de Parfum Peel Away Card",
    unitPrice: "0.00",
    qty: 1,
    lineTotal: "0.00",
    imageUrl:
      "https://images.unsplash.com/photo-1615634260167-cd3b1b9e8a47?auto=format&fit=crop&w=200&q=80",
  },
  {
    id: 3,
    name: "Positive Light Luminizing Lip Gloss",
    shadeName: "Dazzle",
    unitPrice: "20.00",
    qty: 1,
    lineTotal: "20.00",
    imageUrl:
      "https://images.unsplash.com/photo-1622453954239-3b0a893deaea?auto=format&fit=crop&w=200&q=80",
  },
];


  const mockQR =
    "00020101021229370016A000000677010111011300668123456785802TH53037645456005802TH6304C3B3";

  res.json({
    ...order,
    items,
    promptpayQR: mockQR,
    expiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000),
  });
});


/* ============== ⚠️ JSON Error Handler ============== */
const jsonErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  debug(err.message);
  console.error("🔥 Error Handler:", err);
  res.status(500).send({
    message: err.message || "Internal Server Error",
    type: err.name || "Error",
    // ในโปรดักชัน ควรซ่อน stack
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
};
app.use(jsonErrorHandler);



/* =================== 🚀 Start =================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  debug(`Listening on port ${PORT}: http://localhost:${PORT}`);
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});