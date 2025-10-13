import { Router } from "express";
import { dbClient } from "../../db/client.js";
import {
  carts,
  cartItems,
  orders,
  orderItems,
  productVariants,
  products,
} from "../../db/schema.js";
import { and, desc, eq, inArray } from "drizzle-orm";

const ordersRouter = Router();

/** ✅ POST /api/orders/checkout */
ordersRouter.post("/checkout", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    // หา cart + items
    const [cart] = await dbClient.select().from(carts).where(eq(carts.userID, userId)).limit(1);
    if (!cart) return res.status(400).json({ message: "Cart not found" });

    const items = await dbClient.select().from(cartItems).where(eq(cartItems.cartId, cart.id));
    if (!items.length) return res.status(400).json({ message: "Cart is empty" });

    const subtotal = items.reduce((sum, it) => sum + Number(it.lineTotal ?? 0), 0);

    // ✅ ทำทุกอย่างใน transaction
    const result = await dbClient.transaction(async (tx) => {
      // 1) create order
      const [order] = await tx
        .insert(orders)
        .values({
          userID: userId,
          status: "PENDING",
          subtotal: subtotal.toFixed(2),
          shippingFee: "0.00",
          discountTotal: "0.00",
          grandTotal: subtotal.toFixed(2),
        })
        .returning();

      // 2) เตรียม snapshot (เหมือนเดิม)
      const variantIds = items
        .map((it) => it.variantId)
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

      let variants: Array<typeof productVariants.$inferSelect> = [];
      if (variantIds.length) {
        variants = await tx
          .select()
          .from(productVariants)
          .where(inArray(productVariants.id, variantIds));
      }
      const vMap = new Map<number, typeof productVariants.$inferSelect>();
      for (const v of variants) vMap.set(v.id, v);

      const payload: Array<typeof orderItems.$inferInsert> = [];
      for (const it of items) {
        const v = vMap.get(it.variantId as number);
        let pRow: typeof products.$inferSelect | null = null;
        if (v?.pId) {
          const [p] = await tx.select().from(products).where(eq(products.pId, v.pId)).limit(1);
          pRow = p ?? null;
        }
        payload.push({
          orderId: order.id,
          productId: v?.pId ?? null,
          variantId: it.variantId,
          name: pRow?.pname ?? v?.sku ?? `SKU-${it.variantId}`,
          shadeName: v?.shadeName ?? null,
          unitPrice: it.unitPrice,
          qty: it.qty,
          lineTotal: it.lineTotal,
        });
      }
      await tx.insert(orderItems).values(payload);

      // 3) ล้าง cart_items แล้วคืนจำนวนที่ลบ
      const deleted = await tx
        .delete(cartItems)
        .where(eq(cartItems.cartId, cart.id))
        .returning({ id: cartItems.id });

      // (ออปชัน) จะลบแถว carts ทิ้งเลยก็ได้ถ้าต้องการเริ่มใหม่จริง ๆ:
      await tx.delete(carts).where(eq(carts.id, cart.id));

      return { order, deletedCount: deleted.length };
    });

    res.json({
      message: "Checkout successful",
      orderId: result.order.id,
      grandTotal: subtotal.toFixed(2),
      cleared: result.deletedCount,  // 👉 debug ง่าย
    });
  } catch (err) {
    next(err);
  }
});


/** ✅ GET /api/orders/me : ลิสต์คำสั่งซื้อของ user ปัจจุบัน */
ordersRouter.get("/me", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    const rows = await dbClient
      .select({
        id: orders.id,
        status: orders.status,
        subtotal: orders.subtotal,
        shipping_fee: orders.shippingFee,
        discount_total: orders.discountTotal,
        grand_total: orders.grandTotal,
        created_at: orders.createdAt,
        updated_at: orders.updatedAt,
      })
      .from(orders)
      .where(eq(orders.userID, userId))
      .orderBy(desc(orders.createdAt));

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** ✅ GET /api/orders/:id : รายละเอียดคำสั่งซื้อ + items */
ordersRouter.get("/:id", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });
    const orderId = Number(req.params.id);

    // ตรวจว่าเป็นของ user นี้
    const [ord] = await dbClient
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.userID, userId)))
      .limit(1);

    if (!ord) return res.status(404).json({ message: "Order not found" });

    // ดึง items + join variant/product เพื่อเติมรูป (ถ้าเก็บไว้ใน order_items แล้วก็อ่านตรง ๆ ได้เลย)
    const rawItems = await dbClient
      .select({
        id: orderItems.id,
        product_id: orderItems.productId,
        variant_id: orderItems.variantId,
        name: orderItems.name,
        shade_name: orderItems.shadeName,
        unit_price: orderItems.unitPrice,
        qty: orderItems.qty,
        line_total: orderItems.lineTotal,
        pv_image_url: productVariants.imageUrl, // จาก variant
        p_image_url: products.primaryImageUrl, // fallback จาก product
      })
      .from(orderItems)
      .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
      .leftJoin(products, eq(productVariants.pId, products.pId))
      .where(eq(orderItems.orderId, orderId));

    const items = rawItems.map((r) => ({
      id: r.id,
      product_id: r.product_id,
      variant_id: r.variant_id,
      name: r.name,
      shade_name: r.shade_name,
      unit_price: Number(r.unit_price),
      qty: Number(r.qty),
      line_total: Number(r.line_total),
      image_url: r.pv_image_url ?? r.p_image_url ?? null, // ✅ ใส่ใน response เท่านั้น
    }));

    res.json({
      id: ord.id,
      status: ord.status,
      subtotal: Number(ord.subtotal),
      shipping_fee: Number(ord.shippingFee),
      discount_total: Number(ord.discountTotal),
      grand_total: Number(ord.grandTotal),
      created_at: ord.createdAt,
      updated_at: ord.updatedAt,
      items,
    });
  } catch (err) {
    next(err);
  }
});

export default ordersRouter;
