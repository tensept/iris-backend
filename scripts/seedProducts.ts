/* eslint-disable no-console */
import "dotenv/config";

import { dbClient } from "../db/client";
import { products, productVariants, categories } from "../db/schema";
import { sql, eq } from "drizzle-orm";
import { Client } from "minio";
import crypto from "crypto";

// ใช้ fetch ของ Node 18+ (ลบ import จาก "undici")
// import { fetch } from "undici";

const SEED_TO_MINIO = String(process.env.SEED_TO_MINIO || "false") === "true";

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || "localhost";
const MINIO_PORT = Number(process.env.MINIO_PORT || 9000);
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || "minioadmin";
const MINIO_USE_SSL =
  String(process.env.MINIO_USE_SSL || "false").toLowerCase() === "true";
const BUCKET_NAME = process.env.MINIO_BUCKET || "product-images";

// URL สำหรับเปิดไฟล์จากฝั่ง browser
const MINIO_PUBLIC_BASE = (
  process.env.MINIO_PUBLIC_URL ||
  `${MINIO_USE_SSL ? "https" : "http"}://${MINIO_ENDPOINT}:${MINIO_PORT}`
).replace(/\/$/, "");

const minioClient = new Client({
  endPoint: MINIO_ENDPOINT,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
});

async function ensureBucket() {
  if (!SEED_TO_MINIO) return;
  const exists = await minioClient.bucketExists(BUCKET_NAME);
  if (!exists) {
    await minioClient.makeBucket(BUCKET_NAME, "us-east-1");
    console.log(`✅ Created bucket: ${BUCKET_NAME}`);
  } else {
    console.log(`ℹ️ Bucket exists: ${BUCKET_NAME}`);
  }

  // เปิดสิทธิ์อ่านไฟล์แบบสาธารณะ (เพื่อให้เปิดรูปผ่าน HTTP ได้)
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "PublicRead",
        Effect: "Allow",
        Principal: { AWS: ["*"] },
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${BUCKET_NAME}/*`],
      },
    ],
  };
  try {
    // @ts-ignore - method มีใน minio sdk v7
    await minioClient.setBucketPolicy(BUCKET_NAME, JSON.stringify(policy));
    console.log("🔓 Set bucket policy: public-read");
  } catch (e) {
    console.warn(
      "⚠️ setBucketPolicy failed (อาจตั้งไว้แล้ว):",
      (e as Error).message
    );
  }
}

function makePublicUrl(key: string) {
  return `${MINIO_PUBLIC_BASE}/${BUCKET_NAME}/${key}`;
}

async function uploadFromUrlToMinio(url: string | null | undefined) {
  if (!SEED_TO_MINIO || !url) return url ?? null;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${url} (${res.status})`);

  const buf = Buffer.from(await res.arrayBuffer());
  const key = `${crypto.randomUUID()}.jpg`;
  const contentType =
    res.headers.get("content-type") || "application/octet-stream";

  // ✅ ระบุขนาดไฟล์เป็นอาร์กิวเมนต์ที่ 4 แล้วค่อยส่ง metadata เป็นตัวที่ 5
  await minioClient.putObject(BUCKET_NAME, key, buf, buf.length, {
    "Content-Type": contentType,
  });

  const finalUrl = makePublicUrl(key);
  console.log("⬆️ uploaded:", finalUrl);
  return finalUrl;
}

/** หมวดหมู่ที่ต้องมีในระบบ */
const CATEGORY_NAMES = [
  "LIPS",
  "EYES",
  "FACE",
  "CHEEKS",
  "BODY",
  "TOOLS",
] as const;
type PcName = (typeof CATEGORY_NAMES)[number];

const rand = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const toPrice = (v: string | number | undefined | null): string => {
  if (v == null) return "0.00";
  if (typeof v === "number") return v.toFixed(2);
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
};

async function ensureCategories(): Promise<Map<PcName, number>> {
  for (const name of CATEGORY_NAMES) {
    const found = await dbClient
      .select()
      .from(categories)
      .where(eq(categories.pcname, name));
    if (found.length === 0) {
      await dbClient.insert(categories).values({ pcname: name });
    }
  }
  const rows = await dbClient.select().from(categories);
  const map = new Map<PcName, number>();
  for (const r of rows) {
    const n = r.pcname as PcName;
    if ((CATEGORY_NAMES as readonly string[]).includes(n)) map.set(n, r.cId);
  }
  for (const n of CATEGORY_NAMES) {
    if (!map.get(n)) throw new Error(`Category not found after ensure: ${n}`);
  }
  return map;
}

/** ---------- ข้อมูล SEED: ใช้ pcName เสมอ ---------- */
type SeedItem = {
  pname: string;
  description?: string;
  basePrice: string | number;
  pcName: PcName; // ✅ ใช้ชื่อหมวดเท่านั้น
  primaryImageUrl?: string | null;
  images?: string[];
  variants?: Array<{
    sku?: string;
    shadeName?: string | null;
    shadeCode?: string | null;
    price?: string | number;
    stockQty?: number;
    isActive?: boolean;
    imageUrl?: string | null;
  }>;
};

const SEED: SeedItem[] = [
  // ---------- LIPS ----------
  {
    pname: "Gloss Tint",
    description: "Lightweight glossy tint with comfy wear.",
    basePrice: 350,
    pcName: "LIPS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1631214524049-0ebbbe6d81aa?q=80&w=1074&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1692464897435-ec117f40438f?q=80&w=687&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1631214524085-17874764a0e5?q=80&w=1074&auto=format&fit=crop",
      "https://images.unsplash.com/photo-1631214499500-2e34edcaccfe?q=80&w=715&auto=format&fit=crop",
    ],
    variants: [
    {
      shadeName: "01",
      shadeCode: "#b85a5a",
      price: 350,
      stockQty: 20,
      imageUrl: "https://images.unsplash.com/photo-1561382936-53b1c2e537c3?q=80&w=1074&auto=format&fit=crop",
    },
    {
      shadeName: "02",
      shadeCode: "#c65a6b",
      price: 350,
      stockQty: 20,
      imageUrl: "https://images.unsplash.com/photo-1574156984874-16bbbf980c55?q=80&w=1130&auto=format&fit=crop",
    },
    {
      shadeName: "03",
      shadeCode: "#d36c7a",
      price: 350,
      stockQty: 20,
      imageUrl: "https://images.unsplash.com/photo-1692365866388-b9cb65db614c?q=80&w=687&auto=format&fit=crop",
    },
    {
      shadeName: "04",
      shadeCode: "#e07f8b",
      price: 350,
      stockQty: 20,
      imageUrl: "https://plus.unsplash.com/premium_photo-1743025736906-897f737b5ee8?q=80&w=1170&auto=format&fit=crop",
    },
    {
      shadeName: "05",
      shadeCode: "#f09296",
      price: 350,
      stockQty: 20,
      imageUrl: "https://images.unsplash.com/photo-1557797405-891f09b308bc?q=80&w=1025&auto=format&fit=crop",
    },
  ],
  },
  {
    pname: "Velvet Matte Lipstick",
    description: "Intense pigment, matte but comfy.",
    basePrice: 420,
    pcName: "LIPS",
    primaryImageUrl:
      "https://plus.unsplash.com/premium_photo-1677350811721-4ff958ef5588?q=80&w=1332&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1671797022913-b211151c875c?q=80&w=723&auto=format&fit=crop",
      "https://plus.unsplash.com/premium_photo-1738065061341-12f258ef930f?q=80&w=1170&auto=format&fit=crop",
    ],
    variants: [
      { shadeName: "Brick", shadeCode: "#8a3b33", price: 420, stockQty: 15 },
      { shadeName: "Rose", shadeCode: "#b85a6b", price: 420, stockQty: 15 },
    ],
  },
  {
    pname: "Dewy Lip Balm",
    description: "Moisturizing balm with natural tint.",
    basePrice: 290,
    pcName: "LIPS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1666594171486-858f82f5b191?q=80&w=765&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1716635159355-0e2f39db71e0?q=80&w=1074&auto=format&fit=crop",
    ],
  },
  {
    pname: "Plumping Lip Oil",
    description: "Glossy oil with plumping effect.",
    basePrice: 390,
    pcName: "LIPS",
    primaryImageUrl:
      "https://plus.unsplash.com/premium_photo-1701193525924-11037ec0a8c2?q=80&w=765&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1677525515458-1c668700b67b?q=80&w=1171&auto=format&fit=crop",
    ],
  },
  {
    pname: "Lip Liner",
    description: "Creamy liner for precise definition.",
    basePrice: 220,
    pcName: "LIPS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1654374504608-67c4cfe65fca?q=80&w=765&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1682001110131-14c033d4e584?q=80&w=687&auto=format&fit=crop",
    ],
  },

  // ---------- EYES ----------
  {
    pname: "Everyday Eyeshadow Palette",
    description: "Neutral palette for daily looks.",
    basePrice: 690,
    pcName: "EYES",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1625093525885-282384697917?q=80&w=1101&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1664451177155-8247ae799c8b?q=80&w=687&auto=format&fit=crop",
    ],
    variants: [
      { shadeName: "Warm", price: 690, stockQty: 12 },
      { shadeName: "Cool", price: 690, stockQty: 12 },
    ],
  },
  {
    pname: "Lengthening Mascara",
    description: "Smudge-proof lengthening formula.",
    basePrice: 350,
    pcName: "EYES",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1650664370914-f026578ec2a4?q=80&w=769&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1664874603231-9d137ca41322?q=80&w=687&auto=format&fit=crop",
    ],
  },
  {
    pname: "Waterproof Eyeliner",
    description: "Matte black, all-day wear.",
    basePrice: 290,
    pcName: "EYES",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1631237535134-e009a5939d9c?q=80&w=1025&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1709477542149-f4e0e21d590b?q=80&w=687&auto=format&fit=crop",
    ],
    variants: [
      { shadeName: "Black", price: 290, stockQty: 20 },
      { shadeName: "Brown", price: 290, stockQty: 20 },
    ],
  },
  {
    pname: "Brow Pencil",
    description: "Micro tip for hair-like strokes.",
    basePrice: 280,
    pcName: "EYES",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1597225335960-8a9970732de1?q=80&w=687&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1703483854271-44b6a1de388a?q=80&w=1170&auto=format&fit=crop",
    ],
  },
  {
    pname: "Glitter Topper",
    description: "Eye topper with fine shimmer.",
    basePrice: 320,
    pcName: "EYES",
    primaryImageUrl:
      "https://plus.unsplash.com/premium_photo-1670006626742-64170846e39e?q=80&w=1074&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1703521302674-e16cea300044?q=80&w=687&auto=format&fit=crop",
    ],
  },

  // ---------- FACE ----------
  {
    pname: "Cushion Foundation",
    description: "Buildable coverage with natural glow.",
    basePrice: 890,
    pcName: "FACE",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1557205465-f3762edea6d3?q=80&w=687&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1677175230595-87f8721ff703?q=80&w=784&auto=format&fit=crop",
    ],
    variants: [
      { shadeName: "01 Porcelain", price: 890, stockQty: 10 },
      { shadeName: "02 Ivory", price: 890, stockQty: 10 },
      { shadeName: "03 Beige", price: 890, stockQty: 10 },
    ],
  },
  {
    pname: "Soft Matte Foundation",
    description: "Long-wear matte finish.",
    basePrice: 750,
    pcName: "FACE",
    primaryImageUrl:
      "https://plus.unsplash.com/premium_photo-1679750866885-d3b7d2177711?q=80&w=687&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1701271482230-5ecaec3cd3e1?q=80&w=880&auto=format&fit=crop",
    ],
  },
  {
    pname: "Hydrating Primer",
    description: "Plump & grip makeup.",
    basePrice: 520,
    pcName: "FACE",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1530863138121-03aea5f46fd4?q=80&w=1170&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1661493906453-76a234c1c850?q=80&w=880&auto=format&fit=crop",
    ],
  },
  {
    pname: "Loose Setting Powder",
    description: "Smooth blur, no flashback.",
    basePrice: 450,
    pcName: "FACE",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1658848437792-3255618874b5?q=80&w=1170&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1661493906453-76a234c1c850?q=80&w=880&auto=format&fit=crop",
    ],
  },
  {
    pname: "Concealer",
    description: "High coverage, natural finish.",
    basePrice: 390,
    pcName: "FACE",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1547887538-e3a2f32cb1cc?q=80&w=1170&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1661493906453-76a234c1c850?q=80&w=880&auto=format&fit=crop",
    ],
  },

  // ---------- CHEEKS ----------
  {
    pname: "Satin Blush",
    description: "Silky blush with soft sheen.",
    basePrice: 380,
    pcName: "CHEEKS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1606876430311-6b09172238b9?q=80&w=1170&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1596462502278-27bfdc403348?q=80&w=880&auto=format&fit=crop",
    ],
    variants: [
      { shadeName: "Peach", price: 380, stockQty: 18 },
      { shadeName: "Rose", price: 380, stockQty: 18 },
    ],
  },
  {
    pname: "Cream Blush",
    description: "Dewy cream texture.",
    basePrice: 420,
    pcName: "CHEEKS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1512207037870-c006a7631ae0?q=80&w=730&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1594465919760-441fe5908ab0?q=80&w=764&auto=format&fit=crop",
    ],
  },
  {
    pname: "Highlighter",
    description: "Glass-skin glow.",
    basePrice: 420,
    pcName: "CHEEKS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1690214392602-796cff6b4e8a?q=80&w=687&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1674867506194-665878140856?q=80&w=687&auto=format&fit=crop",
    ],
  },
  {
    pname: "Contour Stick",
    description: "Creamy & blendable.",
    basePrice: 390,
    pcName: "CHEEKS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1634282347052-58ef7fa1704a?q=80&w=1170&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1692318601456-1d2bbc8e0250?q=80&w=687&auto=format&fit=crop",
    ],
  },
  {
    pname: "Bronzer",
    description: "Sun-kissed warmth.",
    basePrice: 420,
    pcName: "CHEEKS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1583241800804-8eea95214a87?q=80&w=1170&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1692318520072-7de43d4462ca?q=80&w=687&auto=format&fit=crop",
    ],
  },

  // ---------- BODY ----------
  {
    pname: "Shimmer Body Oil",
    description: "Subtle shimmer & hydration.",
    basePrice: 590,
    pcName: "BODY",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1608571423539-e951b9b3871e?q=80&w=680&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1556760544-74068565f05c?q=80&w=1170&auto=format&fit=crop",
    ],
  },
  {
    pname: "Body Lotion",
    description: "Fast-absorbing everyday lotion.",
    basePrice: 350,
    pcName: "BODY",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1620916566398-39f1143ab7be?q=80&w=687&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1679046949251-e562f2e30fa4?q=80&w=687&auto=format&fit=crop",
    ],
  },
  {
    pname: "Hand Cream",
    description: "Non-greasy, silky feel.",
    basePrice: 180,
    pcName: "BODY",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1679580569570-bdcb63025bd0?q=80&w=709&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1679046949251-e562f2e30fa4?q=80&w=687&auto=format&fit=crop",
    ],
  },
  {
    pname: "Body Mist",
    description: "Light fragrance for daily refresh.",
    basePrice: 290,
    pcName: "BODY",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1671642605304-2a0a812b5529?q=80&w=627&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1679046949251-e562f2e30fa4?q=80&w=687&auto=format&fit=crop",
    ],
  },
  {
    pname: "Body Scrub",
    description: "Polish & smooth skin.",
    basePrice: 420,
    pcName: "BODY",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1667803552102-00de1188d66f?q=80&w=880&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1677849925911-43bac3473aee?q=80&w=1171&auto=format&fit=crop",
    ],
  },

  // ---------- TOOLS ----------
  {
    pname: "Makeup Brush Set",
    description: "Professional soft bristles.",
    basePrice: 890,
    pcName: "TOOLS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1653295501005-f1681bc095de?q=80&w=1123&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1600228390270-970186129936?q=80&w=880&auto=format&fit=crop",
    ],
  },
  {
    pname: "Beauty Blender Sponge",
    description: "Seamless foundation.",
    basePrice: 220,
    pcName: "TOOLS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1631120234265-83988f58b8af?q=80&w=1170&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1625435784621-08cec1189729?q=80&w=735&auto=format&fit=crop",
    ],
  },
  {
    pname: "Eyelash Curler",
    description: "Gentle curve design.",
    basePrice: 390,
    pcName: "TOOLS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1602573991396-fb69ee6d7a0d?q=80&w=1170&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1726812011251-d0c8d9e5d7d4?q=80&w=1124&auto=format&fit=crop",
    ],
  },
  {
    pname: "Tweezers",
    description: "Precision stainless tips.",
    basePrice: 250,
    pcName: "TOOLS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1620531940052-d0d9aff03c32?q=80&w=735&auto=format&fit=crop",
    images: [
      "https://plus.unsplash.com/premium_photo-1718626726854-452ba90f3c53?q=80&w=1170&auto=format&fit=crop",
    ],
  },
  {
    pname: "Makeup Organizer Box",
    description: "Compact storage.",
    basePrice: 490,
    pcName: "TOOLS",
    primaryImageUrl:
      "https://images.unsplash.com/photo-1617220374460-573b04b37916?q=80&w=687&auto=format&fit=crop",
    images: [
      "https://images.unsplash.com/photo-1623884167410-ea10ba23466a?q=80&w=798&auto=format&fit=crop",
    ],
  },
];

// ---------- main ----------
async function main() {
  console.log("🧹 Truncating tables…");
  // รีเซ็ต id และจัดการ FK ให้เรียบร้อย
  await dbClient.execute(
    sql`TRUNCATE TABLE ${productVariants}, ${products} RESTART IDENTITY CASCADE`
  );

  console.log("🗂️ Ensuring categories…");
  const catMap = await ensureCategories();

  console.log("🪣 Ensuring MinIO bucket…");
  await ensureBucket();

  console.log("🌱 Seeding products…");
  for (const item of SEED) {
    const pcId = catMap.get(item.pcName)!;

    // 1) อัพโหลดรูปหลัก (ครั้งเดียว) แล้วใช้ URL ที่ได้ต่อไป
    const primaryImageUrl = await uploadFromUrlToMinio(item.primaryImageUrl ?? null);

    // 2) ทำความสะอาด images[] — เอา duplicate ออก, ไม่ให้ซ้ำกับ primary, แล้วค่อยอัพโหลด
    const rawImages = Array.isArray(item.images) ? item.images : [];
    const uniqueImages = Array.from(
      new Set(
        rawImages.filter(u => u && u !== item.primaryImageUrl)
      )
    );
    const uploadedImages = uniqueImages.length
      ? await Promise.all(uniqueImages.map(u => uploadFromUrlToMinio(u)))
      : [];

    // 3) insert product
    const inserted = await dbClient
      .insert(products)
      .values({
        pname: item.pname,
        description: item.description ?? null,
        basePrice: toPrice(item.basePrice),
        pcId,
        primaryImageUrl: primaryImageUrl ?? item.primaryImageUrl ?? null,
        images: uploadedImages, // ใช้รายการที่กรองและอัพโหลดแล้ว
      })
      .returning({ pId: products.pId });

    const pid = inserted[0].pId;

    // 4) insert variants
    if (item.variants?.length) {
      for (const v of item.variants) {
        // อัพโหลดเฉพาะกรณีมีรูปของเฉดเอง; ถ้าไม่มีให้ใช้ primary ที่อัพโหลดแล้ว
        let vImg: string | null = null;
        if (v.imageUrl) {
          vImg = await uploadFromUrlToMinio(v.imageUrl);
        } else {
          vImg = primaryImageUrl ?? null;
        }

        await dbClient.insert(productVariants).values({
          pId: pid,
          sku: v.sku ?? `SKU-${pid}-${Date.now().toString().slice(-5)}-${rand(100, 999)}`,
          shadeName: v.shadeName ?? null,
          shadeCode: v.shadeCode ?? null,
          price: toPrice(v.price ?? item.basePrice),
          stockQty: v.stockQty ?? rand(5, 30),
          isActive: v.isActive ?? true,
          imageUrl: vImg,
        });
      }
    } else {
      // ไม่มี variant เฉพาะ: สร้าง default variant 1 ตัว ใช้รูปหลักที่อัพโหลดแล้ว
      await dbClient.insert(productVariants).values({
        pId: pid,
        sku: `SKU-${pid}-${rand(100, 999)}`,
        shadeName: null,
        shadeCode: null,
        price: toPrice(item.basePrice),
        stockQty: rand(8, 25),
        isActive: true,
        imageUrl: primaryImageUrl ?? null,
      });
    }
  }

  console.log("✅ Seed complete.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
