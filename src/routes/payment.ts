// src/routes/payment.ts
import { Router } from "express";
import { dbClient } from "../../db/client.js";
import { carts, cartItems, productVariants } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const paymentRouter = Router();

/** ✅ ดึงข้อมูลตะกร้าเพื่อใช้สร้าง QR Payment */
paymentRouter.get("/me", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId as number | undefined;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    // หา cart ของผู้ใช้
    const [cart] = await dbClient
      .select()
      .from(carts)
      .where(eq(carts.userID, userId))
      .limit(1);

    if (!cart) return res.status(404).json({ message: "Cart not found" });

    // ดึงสินค้าภายใน cart
    const items = await dbClient
      .select({
        id: cartItems.id,
        name: productVariants.sku,
        shadeName: productVariants.shadeName,
        unitPrice: cartItems.unitPrice,
        qty: cartItems.qty,
        lineTotal: cartItems.lineTotal,
        imageUrl: productVariants.imageUrl,
      })
      .from(cartItems)
      .leftJoin(productVariants, eq(productVariants.id, cartItems.variantId))
      .where(eq(cartItems.cartId, cart.id));

    const subtotal = items.reduce((sum, it) => sum + Number(it.lineTotal), 0);
    const grandTotal = subtotal; // เพิ่ม logic คำนวณส่วนลด/ค่าส่งได้ในอนาคต

    // ✅ สร้าง PromptPay QR
    const promptpayNumber = "0867945514"; // เบอร์ร้านหรือบัญชีจริงของคุณ
    const qrPayload = generatePromptPayPayload(promptpayNumber, grandTotal);

    return res.json({
      userID: userId,
      items,
      subtotal: subtotal.toFixed(2),
      grandTotal: grandTotal.toFixed(2),
      promptpayQR: qrPayload,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // QR หมดอายุ 1 ชม.
    });
  } catch (err) {
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
