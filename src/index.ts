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
import {
  users,
  products,
  productVariants,
  carts,
  cartItems,
  orders,
  orderItems,
} from "@db/schema.js";
import { cartRouter } from "./routes/cart.ts";

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
// app.get("/products", async (req, res, next) => {
//   try {
//     const result = await dbClient.select().from(products);
//     res.json(result);
//   } catch (err) {
//     next(err);
//   }
// });

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
app.use("/cart", authMiddleware, cartRouter);

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