// src/lib/r2/r2Client.ts
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { Upload } from "@aws-sdk/lib-storage";

const REGION = process.env.AWS_REGION!;
const BUCKET = process.env.AWS_BUCKET_NAME!;
const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID!;
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY!;
const PUBLIC_URL = process.env.AWS_PUBLIC_URL || ""; // ej: https://assets.aamy.ai

const client = new S3Client({
  region: REGION,
  credentials: {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  },
  ...(PUBLIC_URL.includes("r2.cloudflarestorage") && {
    endpoint: PUBLIC_URL.replace(/^https?:\/\//, "").split("/")[0],
    forcePathStyle: true,
  }),
});

export const R2 = {
  async put(key: string, buffer: Buffer, options?: { httpMetadata?: { contentType?: string } }) {
    const upload = new Upload({
      client,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: Readable.from(buffer),
        ContentType: options?.httpMetadata?.contentType || "application/octet-stream",
      },
    });

    await upload.done();

    // Devuelve la URL pública
    return `${PUBLIC_URL}/${key}`;
  },
};
