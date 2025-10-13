import { Router } from "express";
import { dbClient } from "../../db/client.js";
import { carts, cartItems, orders, orderItems } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const ordersRouter = Router();

/** ✅ POST /api/orders/checkout */
ordersRouter.post("/checkout", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    // 1️⃣ หาตะกร้าของ user
    const [cart] = await dbClient
      .select()
      .from(carts)
      .where(eq(carts.userID, userId))
      .limit(1);

    if (!cart) return res.status(400).json({ message: "Cart not found" });

    // 2️⃣ ดึงรายการสินค้าใน cart
    const items = await dbClient
      .select()
      .from(cartItems)
      .where(eq(cartItems.cartId, cart.id));

    if (!items.length)
      return res.status(400).json({ message: "Cart is empty" });

    // 3️⃣ คำนวณยอดรวม
    const subtotal = items.reduce(
      (sum, it) => sum + Number(it.lineTotal ?? 0),
      0
    );

    // 4️⃣ ✅ สร้าง order ใหม่
    const [order] = await dbClient
      .insert(orders)
      .values({
        userID: userId,
        status: "pending",
        subtotal: subtotal.toFixed(2),
        shippingFee: "0.00",
        discountTotal: "0.00",
        grandTotal: subtotal.toFixed(2),
      })
      .returning();

    // 5️⃣ ✅ ย้ายรายการจาก cart → order_items
    const orderItemsPayload = items.map((it) => ({
      orderId: order.id,
      variantId: it.variantId,
      qty: it.qty,
      unitPrice: it.unitPrice,
      lineTotal: it.lineTotal,
    }));
    await dbClient.insert(orderItems).values(orderItemsPayload);

    // 6️⃣ ✅ ล้าง cart
    await dbClient.delete(cartItems).where(eq(cartItems.cartId, cart.id));

    res.json({
      message: "Checkout successful",
      orderId: order.id,
      grandTotal: subtotal.toFixed(2),
    });
  } catch (err) {
    next(err);
  }
});

export default ordersRouter;
