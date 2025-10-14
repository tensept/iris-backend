// src/services/scb.ts
import crypto from "crypto";
import { fetch, Response, type RequestInit as UndiciRequestInit } from "undici";

/** ============ ENV / Defaults ============ */
const SCB_BASE = process.env.SCB_BASE ?? "https://api-sandbox.partners.scb/partners/sandbox";

// Portal: API Key / API Secret (จำเป็น)
const SCB_API_KEY = mustGet("SCB_API_KEY");
const SCB_API_SECRET = mustGet("SCB_API_SECRET");

// ถ้า Portal แยก Client ID/Secret ให้ใส่ได้; ถ้าไม่ใส่ จะ fallback เป็น API Key/Secret อัตโนมัติ
const SCB_CLIENT_ID = process.env.SCB_CLIENT_ID ?? SCB_API_KEY;
const SCB_CLIENT_SECRET = process.env.SCB_CLIENT_SECRET ?? SCB_API_SECRET;

// Merchant profile (จำเป็นสำหรับ QR30)
const SCB_BILLER_ID = mustGet("SCB_BILLER_ID"); // 15 หลัก
const SCB_REF3_PREFIX = az09(mustGet("SCB_REF3_PREFIX")); // sanitize ให้เป็น A-Z0-9 เสมอ

// Optional
const SCB_CALLBACK_URL = process.env.SCB_CALLBACK_URL ?? "";

/** ============ Helpers ============ */
function mustGet(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`[SCB] Missing required env: ${name}`);
  return v;
}
const reqUid32 = () => crypto.randomBytes(16).toString("hex"); // 32 alnum, ไม่มีขีด

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function scbFetch(url: string, init: UndiciRequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e: any) {
    const msg = [
      e?.name, e?.message, e?.code, e?.errno, e?.syscall,
      e?.cause?.code, e?.cause?.errno, e?.cause?.message,
    ].filter(Boolean).join(" | ");
    console.error("❌ [SCB] fetch failed:", msg);
    throw new Error(`SCB network error: ${msg}`);
  }
}

function az09(s: string, max = 20) {
  return s.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, max);
}
export function makeRef1(orderId: number | string) {
  return az09(`ORD${String(orderId).padStart(10, "0")}`, 20);
}

/** ============ Public APIs ============ */

/** 1) ขอ Access Token (partners sandbox spec) */
export async function getScbAccessToken(): Promise<string> {
  const url = `${SCB_BASE}/v1/oauth/token`;
  const res = await scbFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      resourceOwnerId: SCB_API_KEY,   // ✅ ต้องเป็น API_KEY
      requestUId: reqUid32(),         // ✅ 32 ตัว, ไม่มีขีด
      "accept-language": "EN",
    },
    body: JSON.stringify({
      applicationKey: SCB_CLIENT_ID,
      applicationSecret: SCB_CLIENT_SECRET,
    }),
  });

  const raw = await readJson(res);
  if (!res.ok) throw new Error(`[SCB] token error: ${res.status} ${JSON.stringify(raw)}`);

  const token = raw?.data?.accessToken ?? raw?.accessToken;
  if (!token) throw new Error("[SCB] token missing in response");
  return token;
}

/** 2) สร้าง QR30 (v1: คืน qrRawData, v2: คืน qrImageUrl) */
type CreateQrParams = {
  accessToken: string;
  amount: number | string;      // บาท
  ref1: string | number;        // orderId
  ref2?: string | number;       // userId (จำเป็นถ้าโปรไฟล์ตั้ง Two references)
  ref3?: string;                // เช่น "WEB" (จะต่อ prefix ให้)
  version?: 1 | 2;              // เลือก endpoint (default v2)
};

export async function createScbQr30(params: CreateQrParams) {
  const version = params.version ?? 2; // ค่าเริ่มต้นใช้ v2 ที่ได้ qrImageUrl
  const requestUId = reqUid32();

  const amount = Number(params.amount);
  if (Number.isNaN(amount)) throw new Error("[SCB] amount is not a number");

  const ref1 = az09(String(params.ref1));
  const ref2 = params.ref2 != null ? az09(String(params.ref2)) : undefined;
  const ref3 = az09(`${SCB_REF3_PREFIX}${params.ref3 ? String(params.ref3) : ""}`);

  if (!SCB_BILLER_ID || SCB_BILLER_ID.length !== 15) {
    throw new Error("[SCB] SCB_BILLER_ID must be 15 digits");
  }
  if (!ref1) throw new Error("[SCB] ref1 is required");
  // โปรไฟล์คุณตั้ง Two references → ถ้าไม่ส่ง ให้ throw
  if (!ref2) throw new Error("[SCB] ref2 is required (Supporting Reference = Two references)");

  if (version === 1) {
    const url = `${SCB_BASE}/v1/payment/qrcode/create`;
    const body: any = {
      qrType: "PP",
      amount: amount.toFixed(2), // v1: string
      ppType: "BILLERID",
      ppId: SCB_BILLER_ID,
      ref1,
      ref2,
      ref3,
    };
    if (SCB_CALLBACK_URL) body.merchantMetaData = { callbackUrl: SCB_CALLBACK_URL };

    const res = await scbFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: `Bearer ${params.accessToken}`,
        resourceOwnerId: SCB_API_KEY,
        requestUId,
        "accept-language": "EN",
      },
      body: JSON.stringify(body),
    });

    const raw = await readJson(res);
    if (!res.ok) {
      console.error("[SCB] create QR v1 error:", res.status, raw);
      throw new Error(`[SCB] create QR v1 error: ${res.status} ${JSON.stringify(raw)}`);
    }

    return {
      mode: "v1" as const,
      qrRawData: raw?.data?.qrRawData ?? raw?.qrRawData ?? null,
      transactionId: raw?.data?.transactionId ?? raw?.transactionId ?? null,
      qrId: raw?.data?.qrId ?? raw?.qrId ?? null,
      raw,
    };
  }

  // v2
  const url = `${SCB_BASE}/v2/payment/qrcode/create`;
  const body: any = {
    qrType: "PP",
    amount: Number(amount.toFixed(2)), // v2: Number(13,2)
    ppType: "BILLERID",
    ppId: SCB_BILLER_ID,
    ref1,
    ref2,
    ref3,
  };

  const res = await scbFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${params.accessToken}`,
      resourceOwnerId: SCB_API_KEY,
      requestUId,
      "accept-language": "EN",
    },
    body: JSON.stringify(body),
  });

  const raw = await readJson(res);
  if (!res.ok) {
    console.error("[SCB] create QR v2 error:", res.status, raw);
    throw new Error(`[SCB] create QR v2 error: ${res.status} ${JSON.stringify(raw)}`);
  }

  return {
    mode: "v2" as const,
    qrImageUrl: raw?.data?.qrImageUrl ?? null,
    transactionId: raw?.data?.transactionId ?? raw?.transactionId ?? null,
    qrId: raw?.data?.qrId ?? raw?.qrId ?? null,
    raw,
  };
}

/** 3) ตรวจลายเซ็น x-signature (รองรับทั้ง base64 และ hex) */
export function verifyScbSignature(rawBody: string, signatureHeader?: string): boolean {
  if (!signatureHeader) return false;
  const h = crypto.createHmac("sha256", SCB_API_SECRET).update(rawBody, "utf8").digest();

  // พยายามเทียบทั้ง base64 และ hex
  const given = signatureHeader.trim();
  const variants: Buffer[] = [];
  try { variants.push(Buffer.from(given, "base64")); } catch {}
  try { variants.push(Buffer.from(given.toLowerCase(), "hex")); } catch {}

  for (const b of variants) {
    if (b.length === h.length && crypto.timingSafeEqual(b, h)) return true;
  }
  return false;
}
/** 4) ตรวจสอบสถานะการชำระเงิน (Bill Payment Inquiry) */
export async function getScbQrTxStatus(accessToken: string, transactionId: string) {
  const url = `${SCB_BASE}/v2/payment/billpayment/inquiry`;

  const body = {
    transactionId, // ได้จาก createScbQr30
  };

  const res = await scbFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${accessToken}`,
      resourceOwnerId: SCB_API_KEY,
      requestUId: crypto.randomUUID(),
      "accept-language": "EN",
    },
    body: JSON.stringify(body),
  });

  const raw = await readJson(res);
  if (!res.ok) {
    throw new Error(`[SCB] inquiry error ${res.status}: ${JSON.stringify(raw)}`);
  }

  return raw?.data ?? raw;
}
