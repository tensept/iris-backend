import { Router } from "express";
import { dbClient } from "../../db/client.js";
import {
  carts,
  cartItems,
  productVariants,
  orders,
  orderItems,
} from "../../db/schema.js";
import { eq, desc } from "drizzle-orm";

const paymentRouter = Router();

paymentRouter.get("/me", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    const [latestOrder] = await dbClient
      .select()
      .from(orders)
      .where(eq(orders.userID, userId))
      .orderBy(desc(orders.createdAt))
      .limit(1);

    if (!latestOrder)
      return res.status(404).json({ message: "No orders found" });

    const items = await dbClient
      .select({
        id: orderItems.id,
        name: orderItems.name,
        shadeName: orderItems.shadeName,
        unitPrice: orderItems.unitPrice,
        qty: orderItems.qty,
        lineTotal: orderItems.lineTotal,
        imageUrl: productVariants.imageUrl,
      })
      .from(orderItems)
      .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
      .where(eq(orderItems.orderId, latestOrder.id));

    const promptpayNumber = "0867945514";
    const qrPayload = generatePromptPayPayload(
      promptpayNumber,
      Number(latestOrder.grandTotal)
    );

    return res.json({
      orderId: latestOrder.id,
      items,
      subtotal: latestOrder.subtotal,
      grandTotal: latestOrder.grandTotal,
      promptpayQR: qrPayload,
      status: latestOrder.status,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  } catch (err) {
    next(err);
  }
});


paymentRouter.post("/create", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    const [cart] = await dbClient
      .select()
      .from(carts)
      .where(eq(carts.userID, userId))
      .limit(1);

    if (!cart) return res.status(404).json({ message: "Cart not found" });

    const items = await dbClient
      .select({
        id: cartItems.id,
        variantId: cartItems.variantId,
        qty: cartItems.qty,
        unitPrice: cartItems.unitPrice,
        lineTotal: cartItems.lineTotal,
        productId: productVariants.pId,
        name: productVariants.sku,
        shadeName: productVariants.shadeName,
      })
      .from(cartItems)
      .leftJoin(productVariants, eq(productVariants.id, cartItems.variantId))
      .where(eq(cartItems.cartId, cart.id));

    if (items.length === 0)
      return res.status(400).json({ message: "Cart is empty" });

    const subtotal = items.reduce((s, it) => s + Number(it.lineTotal), 0);
    const shippingFee = 0;
    const grandTotal = subtotal + shippingFee;

    // ✅ สร้าง order
    const [order] = await dbClient
      .insert(orders)
      .values({
        userID: userId,
        status: "PENDING",
        subtotal: subtotal.toFixed(2),
        shippingFee: shippingFee.toFixed(2),
        grandTotal: grandTotal.toFixed(2),
      })
      .returning({ id: orders.id });

    // ✅ insert order_items
    for (const it of items) {
      await dbClient.insert(orderItems).values({
        orderId: order.id,
        productId: it.productId,
        variantId: it.variantId,
        name: it.name,
        shadeName: it.shadeName,
        unitPrice: it.unitPrice,
        qty: it.qty,
        lineTotal: it.lineTotal,
      });
    }

    // ❌ อย่าล้าง cart ที่นี่

    // ✅ สร้าง QR PromptPay
    const promptpayNumber = "0867945514";
    const qrPayload = generatePromptPayPayload(promptpayNumber, grandTotal);

    return res.status(201).json({
      orderId: order.id,
      subtotal,
      grandTotal,
      promptpayQR: qrPayload,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
  } catch (err) {
    console.error("❌ Error create order:", err);
    next(err);
  }
});

paymentRouter.post("/confirm", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId;
    const { orderId } = req.body;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });
    if (!orderId) return res.status(400).json({ message: "Missing orderId" });

    // ✅ อัปเดตสถานะ order เป็น PAID
    await dbClient
      .update(orders)
      .set({ status: "PAID" })
      .where(eq(orders.id, orderId));

    // ✅ หา cart ของ user แล้วล้างของใน cart
    const [cart] = await dbClient
      .select()
      .from(carts)
      .where(eq(carts.userID, userId))
      .limit(1);

    if (cart) {
      await dbClient.delete(cartItems).where(eq(cartItems.cartId, cart.id));
    }

    return res.json({ message: "Payment confirmed and cart cleared." });
  } catch (err) {
    console.error("❌ Error confirming payment:", err);
    next(err);
  }
});


function generatePromptPayPayload(mobileNumber: string, amount?: number) {
  const digits = mobileNumber.replace(/\D/g, "");
  if (digits.length < 9) throw new Error("Invalid phone number");

  // 0812345678 → 66812345678
  const target = digits.startsWith("0") ? "66" + digits.slice(1) : digits;

  // 👇 โครงสร้าง Merchant Info (Tag 29)
  const merchantInfo =
    "0016A000000677010111" + // AID (PromptPay)
    "0115" +                 // ความยาวต่อไป = 15 ตัวอักษร (01 + 13 + เบอร์)
    "0113" + target;         // 01 = มือถือ, 13 = ความยาวเบอร์

  // รวม payload
  let payload =
    "000201" +               // Payload format indicator
    "010212" +               // Dynamic QR
    "29" + merchantInfo.length.toString().padStart(2, "0") + merchantInfo +
    "5303764";               // Currency (THB = 764)

  // เพิ่มจำนวนเงิน (ถ้ามี)
  if (amount && amount > 0) {
    const amt = amount.toFixed(2);
    payload += "54" + amt.length.toString().padStart(2, "0") + amt;
  }

  payload += "5802TH"; // Country code
  payload += "6304";   // CRC placeholder

  const crc = crc16(payload);
  return payload + crc.toUpperCase();
}

function crc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).padStart(4, "0");
}



export default paymentRouter;
