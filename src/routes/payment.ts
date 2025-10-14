// src/routes/payment.ts
import express, { Router } from "express";
import type { Request, Response } from "express";

import crypto from "crypto";
import { dbClient } from "../../db/client.js";
import {
  carts,
  cartItems,
  productVariants,
  orders,
  orderItems,
} from "../../db/schema.js";
import { eq, desc, and } from "drizzle-orm";
import {
  getScbAccessToken,
  createScbQr30,
  verifyScbSignature,
  getScbQrTxStatus,
} from "../services/scb.ts";

const paymentRouter = Router();
// --- Simple SSE hub ---
const orderStreams = new Map<number, Set<Response>>();

function attachSse(res: Response, orderId: number) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // @ts-ignore - บาง runtime มี flushHeaders
  res.flushHeaders?.();

  const set = orderStreams.get(orderId) ?? new Set<Response>();
  set.add(res);
  orderStreams.set(orderId, set);

  res.write(`event: ping\ndata: "ok"\n\n`); // กัน proxy ตัด
  reqOnClose(res, () => {
    set.delete(res);
    if (set.size === 0) orderStreams.delete(orderId);
  });
}

function emitOrder(orderId: number, payload: any) {
  const set = orderStreams.get(orderId);
  if (!set) return;
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const r of set) r.write(line);
}

// helper ปิดเองเมื่อ client หลุด
function reqOnClose(res: Response, cb: () => void) {
  // @ts-ignore
  res.on?.("close", cb);
}

// ---------- helpers ----------
function makeRef1(orderId: number) {
  // [A-Z0-9], ≤ 20 ตัวอักษร
  return `ORD${String(orderId).padStart(10, "0")}`.slice(0, 20);
}

// ---------- GET /api/payment/me ----------
paymentRouter.get("/me", async (req: Request, res: Response, next) => {
  try {
    const userId = (req as any)?.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    const [latestOrder] = await dbClient
      .select()
      .from(orders)
      .where(eq(orders.userID, userId))
      .orderBy(desc(orders.createdAt))
      .limit(1);

    if (!latestOrder) {
      return res.status(404).json({ message: "No orders found" });
    }

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

    return res.json({
      orderId: latestOrder.id,
      items,
      subtotal: Number(latestOrder.subtotal),
      shippingFee: Number(latestOrder.shippingFee ?? 0),
      grandTotal: Number(latestOrder.grandTotal),
      status: latestOrder.status,
      scbTransactionId: (latestOrder as any).scbTransactionId ?? null,
      scbQrId: (latestOrder as any).scbQrId ?? null,
    });
  } catch (err) {
    next(err);
  }
});

paymentRouter.get("/events/:orderId", (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isFinite(orderId)) return res.status(400).end();
  // TODO: (ออปชัน) ตรวจสิทธิ์จาก query เช่น ?jwt=... หรือใช้ cookie
  attachSse(res, orderId);
});

/* -------------------------------------------------------
 * POST /api/payment/scb/qr
 * - ถ้ามีออเดอร์ PENDING ล่าสุดอยู่แล้ว => ใช้อันนั้นออก QR
 * - ถ้าไม่มี => ค่อยสร้างออเดอร์ใหม่จาก cart (ของเดิม)
 * ----------------------------------------------------- */
paymentRouter.post("/scb/qr", async (req: Request, res: Response, next) => {
  try {
    const userId = (req as any)?.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    // 0) หาออเดอร์ PENDING ล่าสุดก่อน
    const [pendingOrder] = await dbClient
      .select()
      .from(orders)
      .where(and(eq(orders.userID, userId), eq(orders.status, "PENDING")))
      .orderBy(desc(orders.createdAt))
      .limit(1);

    let orderId: number;
    let grandTotal: number;

    if (pendingOrder) {
      // ✅ มีออเดอร์แล้ว: ใช้ยอดจากออเดอร์ (ไม่ยุ่งกับ cart)
      orderId = pendingOrder.id;
      grandTotal = Number(pendingOrder.grandTotal);
    } else {
      // ❌ ไม่มีออเดอร์ => ทำ flow เดิมจาก cart
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

      if (items.length === 0) {
        return res.status(400).json({ message: "Cart is empty" });
      }

      const subtotal = items.reduce((s, it) => s + Number(it.lineTotal), 0);
      const shippingFee = 0;
      grandTotal = subtotal + shippingFee;

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

      orderId = order.id;

      for (const it of items) {
        await dbClient.insert(orderItems).values({
          orderId: orderId,
          productId: it.productId,
          variantId: it.variantId,
          name: it.name,
          shadeName: it.shadeName,
          unitPrice: it.unitPrice,
          qty: it.qty,
          lineTotal: it.lineTotal,
        });
      }
    }

    // 3) เรียก SCB ออก QR30 โดยอิงจาก "ออเดอร์" เสมอ + Fallback
    const accessToken = await getScbAccessToken();

    let result: any;
    try {
      // ลอง v2 ก่อน (ได้รูป)
      result = await createScbQr30({
        accessToken,
        amount: Number(grandTotal).toFixed(2),
        ref1: makeRef1(orderId),
        ref2: userId, // Two references → ต้องส่ง
        ref3: "WEB",
        version: 2,
      });
    } catch (e: any) {
      const msg = String(e?.message || "");
      // ถ้า v2 ล่ม (9990) → ถอยไป v1 (ได้ qrRawData)
      if (/9990|Service not available|maintenance/i.test(msg)) {
        result = await createScbQr30({
          accessToken,
          amount: Number(grandTotal).toFixed(2),
          ref1: orderId,
          ref2: userId,
          ref3: "WEB",
          version: 1,
        });
      } else {
        throw e; // error อื่นให้เด้งออกตามเดิม
      }
    }

    // (ออปชัน) เก็บ transaction/qrId ถ้ามีคอลัมน์
    try {
      await dbClient
        .update(orders)
        .set({
          scbTransactionId: (result as any).transactionId ?? (null as any),
          scbQrId: (result as any).qrId ?? (null as any),
        } as any)
        .where(eq(orders.id, orderId));
    } catch {
      /* ignore if columns not exist */
    }

    return res.status(201).json({
      orderId,
      amount: Number(grandTotal).toFixed(2),
      qrImageUrl: (result as any).qrImageUrl || null, // v2
      qrRawData: (result as any).qrRawData || null, // v1
      transactionId: (result as any).transactionId ?? null,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
  } catch (err) {
    // ส่งรายละเอียด error กลับไปให้เห็นชัด ๆ
    const msg = (err as any)?.message || "Create SCB QR failed";
    return res.status(400).json({ message: msg });
  }
});

// ---------- GET /api/payment/scb/status?orderId=123 ----------
paymentRouter.get("/scb/status", async (req, res, next) => {
  try {
    const userId = (req as any)?.user?.userId;
    if (!userId) return res.status(401).json({ message: "Unauthenticated" });

    let { transactionId, orderId } = req.query as any;
    if (!orderId) return res.status(400).json({ message: "Missing orderId" });

    const accessToken = await getScbAccessToken();

    // 1) ถ้ามี transactionId → เช็คตามเดิม
    if (transactionId) {
      try {
        const statusData = await getScbQrTxStatus(accessToken, String(transactionId));
        const status = String(statusData?.status || statusData?.transactionStatus || "").toUpperCase();

        if (status === "PAID" || status === "SUCCESS") {
          await dbClient.update(orders).set({ status: "PAID" }).where(eq(orders.id, Number(orderId)));
          // (ออปชัน) ล้าง cart
          const [cart] = await dbClient.select().from(carts).where(eq(carts.userID, userId)).limit(1);
          if (cart) await dbClient.delete(cartItems).where(eq(cartItems.cartId, cart.id));
        }
        return res.json({ status, raw: statusData });
      } catch (e: any) {
        const msg = String(e?.message || "");
        if (/9990|Service not available|maintenance/i.test(msg)) {
          return res.json({ status: "PENDING", raw: { note: "SCB sandbox maintenance (9990)" } });
        }
        throw e;
      }
    }

    // 2) ถ้าไม่มี transactionId → ใช้ Bill Payment Inquiry v3 ด้วย ref1/ref2
    try {
      const data = await inquiryBillPayment(accessToken, {
        reference1: String(orderId),           // เราส่ง ref1 เป็น orderId ตอนออก QR
        reference2: String(userId),            // sandbox ตั้ง Two references
        // amount: Number(optionalAmount).toFixed(2) // ถ้าโปรไฟล์คุณบังคับค่อยส่ง
      });

      const status = String(data?.status || data?.transactionStatus || "").toUpperCase();
      if (status === "PAID" || status === "SUCCESS") {
        await dbClient.update(orders).set({ status: "PAID" }).where(eq(orders.id, Number(orderId)));
        const [cart] = await dbClient.select().from(carts).where(eq(carts.userID, userId)).limit(1);
        if (cart) await dbClient.delete(cartItems).where(eq(cartItems.cartId, cart.id));
      }

      return res.json({ status, raw: data });
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (/9990|Service not available|maintenance/i.test(msg)) {
        return res.json({ status: "PENDING", raw: { note: "SCB sandbox maintenance (9990)" } });
      }
      throw e;
    }
  } catch (err) {
    next(err);
  }
});


// ---------- POST /api/payment/scb/callback ----------
paymentRouter.post(
  "/scb/callback",
  // ต้องได้ raw body เพื่อ verify ลายเซ็น
  express.raw({ type: "*/*" }),
  async (req: Request, res: Response) => {
    const rawBody = (req.body as any)?.toString?.("utf8") ?? "";
    const xSig = req.header("x-signature") || "";

    // แนะนำให้เปิดจริงใน Production
    const ok = verifyScbSignature(rawBody, xSig || "");
    if (!ok) return res.status(400).json({ message: "Invalid signature" });

    const payload = JSON.parse(rawBody);
    const data = payload?.data ?? payload ?? {};
    const orderId = Number(data?.ref1 ?? data?.reference1);
    const status = String(
      data?.status ?? data?.transactionStatus ?? ""
    ).toUpperCase();

    if (orderId && (status === "PAID" || status === "SUCCESS")) {
      await dbClient
        .update(orders)
        .set({ status: "PAID" })
        .where(eq(orders.id, orderId));
      emitOrder(orderId, { status: "PAID" }); // <<<<<<<<<<
    }

    return res.json({ received: true });
  }
);

// ===================== Helpers (SCB Inquiry v3) =====================
async function inquiryBillPayment(
  accessToken: string,
  params: {
    reference1: string;
    reference2?: string;
    amount?: string;
    transactionDate?: string; // 'YYYY-MM-DD' ถ้าบัญชีคุณบังคับ
  }
) {
  const { default: undici } = await import("undici");
  const { fetch } = undici as any;

  const SCB_BASE = process.env.SCB_BASE!;
  const SCB_API_KEY = process.env.SCB_API_KEY!;
  const requestUId = crypto.randomUUID();

  const res = await fetch(`${SCB_BASE}/v3/payment/billpayment/inquiry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${accessToken}`,
      resourceOwnerId: SCB_API_KEY,
      requestUId,
      "accept-language": "EN",
    },
    body: JSON.stringify(params),
  });

  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  })();

  if (!res.ok) {
    throw new Error(`[SCB] inquiry error ${res.status}: ${text}`);
  }
  return json?.data ?? json;
}

// src/routes/payment.ts (เพิ่มเฉพาะ DEV/SANDBOX)
paymentRouter.post(
  "/scb/simulate-paid",
  async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ message: "Forbidden" });
    }
    const { orderId } = req.body as { orderId: number };
    if (!orderId)
      return res.status(400).json({ message: "orderId is required" });

    await dbClient
      .update(orders)
      .set({ status: "PAID" })
      .where(eq(orders.id, Number(orderId)));
    return res.json({ ok: true });
  }
);

export default paymentRouter;

/* -----------------------------------------------------------------
หมายเหตุการตั้งค่า:
- .env ต้องมี
  SCB_BASE=https://api-sandbox.partners.scb/partners/sandbox
  SCB_API_KEY=...
  SCB_API_SECRET=...
  (BILLER/PREFIX จะใช้ใน services/scb.ts)

- อย่าใส่ app.use(express.json()) ก่อน route /scb/callback
  เพราะ callback ใช้ express.raw() แล้วค่อย parse JSON ภายใน

- ถ้าจะป้องกัน duplicate callback ให้เช็ค idempotency ที่ฝั่ง DB เพิ่มเติม
----------------------------------------------------------------- */
