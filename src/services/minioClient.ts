// src/services/minioClient.ts
import { Client } from "minio";

export const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || "localhost",
  port: Number(process.env.MINIO_PORT) || 9000,
  useSSL: false, // ถ้า MinIO ของคุณเปิด https ให้เปลี่ยนเป็น true
  accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
  secretKey: process.env.MINIO_SECRET_KEY || "minioadmin",
});

// ตั้งชื่อ bucket ที่จะใช้
export const BUCKET_NAME = "product-images";

export async function ensureBucket() {
  const exists = await minioClient.bucketExists(BUCKET_NAME);
  if (!exists) {
    await minioClient.makeBucket(BUCKET_NAME);
    console.log(`✅ Created bucket: ${BUCKET_NAME}`);
  } else {
    console.log(`ℹ️ Bucket already exists: ${BUCKET_NAME}`);
  }
}
