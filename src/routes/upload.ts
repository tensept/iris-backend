import { Router } from "express";
import multer from "multer";
import { minioClient, BUCKET_NAME } from "../utils/minio.js";
import crypto from "crypto";

const uploadRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

// POST /files/upload
uploadRouter.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // ตั้งชื่อไฟล์ใหม่
    const ext = req.file.originalname.split(".").pop();
    const filename = `${crypto.randomUUID()}.${ext}`;

    await minioClient.putObject(BUCKET_NAME, filename, req.file.buffer);

    // public URL (MinIO Browser/NGINX)
    const fileUrl = `${process.env.MINIO_PUBLIC_URL || "http://localhost:9000"}/${BUCKET_NAME}/${filename}`;

    res.json({ url: fileUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

export { uploadRouter };
