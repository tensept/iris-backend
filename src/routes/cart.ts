// src/routes/cart.ts
import { Router } from "express";
import { dbClient } from "../../db/client.js";
import { carts, cartItems, productVariants } from "../../db/schema.js";
import { and, eq } from "drizzle-orm";

const cartRouter = Router();

/** ดึงหรือสร้าง cart ของผู้ใช้ */
async function findOrCreateCartForUser(userId: number) {
  const [existing] = await dbClient
    .select()
    .from(carts)
    .where(eq(carts.userID, userId))
    .limit(1);

  if (existing) return existing;

  const [inserted] = await dbClient
    .insert(carts)
    .values({ userID: userId })
    .returning();

  return inserted;
}

/** รวม payload ตะกร้า */
async function buildCartMePayload(userId: number) {
  const cart = await findOrCreateCartForUser(userId);

  const items = await dbClient
    .select({
      id: cartItems.id,
      cart_id: cartItems.cartId,
      variant_id: cartItems.variantId,
      qty: cartItems.qty,
      unit_price: cartItems.unitPrice,
      line_total: cartItems.lineTotal,
      created_at: cartItems.createdAt,
      updated_at: cartItems.updatedAt,
      sku: productVariants.sku,
      shade_name: productVariants.shadeName,
      shade_code: productVariants.shadeCode,
      image_url: productVariants.imageUrl,
      price_now: productVariants.price,
      stock_qty: productVariants.stockQty,
    })
    .from(cartItems)
    .leftJoin(productVariants, eq(productVariants.id, cartItems.variantId))
    .where(eq(cartItems.cartId, cart.id));

  const subtotal = items.reduce((a, it) => a + Number(it.line_total), 0);
  const total_qty = items.reduce((a, it) => a + Number(it.qty), 0);

  return {
    id: cart.id,
    userID: cart.userID!,
    session_id: cart.sessionId ?? null,
    created_at: cart.createdAt,
    updated_at: cart.updatedAt,
    items,
    summary: { total_qty, subtotal },
  };
}

/* --------------------- Routes --------------------- */

// GET /api/cart/me
cartRouter.get("/me", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    const payload = await buildCartMePayload(userId);
    return res.json(payload);
  } catch (e) {
    next(e);
  }
});

// POST /api/cart/items  { variant_id, qty }
cartRouter.post("/items", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    const { variant_id, qty } = req.body ?? {};
    const addQty = Math.max(1, Number(qty ?? 1));
    const variantId = Number(variant_id);

    if (!variantId) {
      return res.status(400).json({ message: "Missing variant_id" });
    }

    const myCart = await findOrCreateCartForUser(userId);

    // หา variant + ราคา/สต็อก
    const [variant] = await dbClient
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, variantId))
      .limit(1);

    if (!variant) return res.status(404).json({ message: "Variant not found" });

    const price = Number(variant.price);
    const stock = Number(variant.stockQty ?? 0);

    // มี item เดิมไหม?
    const [existing] = await dbClient
      .select()
      .from(cartItems)
      .where(
        and(eq(cartItems.cartId, myCart.id), eq(cartItems.variantId, variantId))
      )
      .limit(1);

    if (existing) {
      const newQty = Math.min(stock, Number(existing.qty) + addQty);
      const newLine = (price * newQty).toFixed(2);

      await dbClient
        .update(cartItems)
        .set({
          qty: newQty,
          unitPrice: price.toFixed(2),
          lineTotal: newLine,
          updatedAt: new Date(),
        })
        .where(eq(cartItems.id, existing.id));
    } else {
      const newQty = Math.min(stock, addQty);
      await dbClient.insert(cartItems).values({
        cartId: myCart.id,
        variantId,
        qty: newQty,
        unitPrice: price.toFixed(2),
        lineTotal: (price * newQty).toFixed(2),
      });
    }

    const payload = await buildCartMePayload(userId);
    return res.json(payload);
  } catch (e) {
    next(e);
  }
});

// PATCH /api/cart/items/:itemId  { qty }
cartRouter.patch("/items/:itemId", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    const itemId = Number(req.params.itemId);
    const qty = Math.max(1, Number((req.body ?? {}).qty));

    if (!itemId || !Number.isFinite(qty)) {
      return res.status(400).json({ message: "Invalid params" });
    }

    // โหลด item + เจ้าของ cart
    const [row] = await dbClient
      .select({
        id: cartItems.id,
        cart_id: cartItems.cartId,
        variant_id: cartItems.variantId,
      })
      .from(cartItems)
      .where(eq(cartItems.id, itemId))
      .limit(1);

    if (!row) return res.status(404).json({ message: "Item not found" });

    const [owner] = await dbClient
      .select({ user_id: carts.userID })
      .from(carts)
      .where(eq(carts.id, Number(row.cart_id))) // 👈 แก้ชนิดให้เป็น number
      .limit(1);

    if (!owner || owner.user_id !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    // เช็คราคา/สต็อกจาก variant
    const [variant] = await dbClient
      .select({ price: productVariants.price, stock: productVariants.stockQty })
      .from(productVariants)
      .where(eq(productVariants.id, Number(row.variant_id)))
      .limit(1);

    if (!variant) return res.status(404).json({ message: "Variant not found" });

    const unitPrice = Number(variant.price);
    const maxStock = Number(variant.stock);
    const safeQty = Math.min(maxStock, qty);

    await dbClient
      .update(cartItems)
      .set({
        qty: safeQty,
        unitPrice: unitPrice.toFixed(2),
        lineTotal: (unitPrice * safeQty).toFixed(2),
        updatedAt: new Date(),
      })
      .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, Number(row.cart_id))));

    const payload = await buildCartMePayload(userId);
    return res.json(payload);
  } catch (e) {
    next(e);
  }
});

// DELETE /api/cart/items/:itemId
cartRouter.delete("/items/:itemId", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    const itemId = Number(req.params.itemId);
    if (!itemId) return res.status(400).json({ message: "Invalid itemId" });

    // ตรวจสิทธิ์เจ้าของ
    const [row] = await dbClient
      .select({
        id: cartItems.id,
        cart_id: cartItems.cartId,
      })
      .from(cartItems)
      .where(eq(cartItems.id, itemId))
      .limit(1);

    if (!row) return res.status(404).json({ message: "Item not found" });

    const [owner] = await dbClient
      .select({ user_id: carts.userID })
      .from(carts)
      .where(eq(carts.id, Number(row.cart_id)))
      .limit(1);

    if (!owner || owner.user_id !== userId) {
      return res.status(403).json({ message: "Forbidden" });
    }

    await dbClient
      .delete(cartItems)
      .where(and(eq(cartItems.id, itemId), eq(cartItems.cartId, Number(row.cart_id))));

    const payload = await buildCartMePayload(userId);
    return res.json(payload);
  } catch (e) {
    next(e);
  }
});

export default cartRouter;
