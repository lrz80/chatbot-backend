// ✅ utils/guardarAudioEnCDN.ts

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
  endpoint: process.env.AWS_ENDPOINT || undefined, // 👈 necesario si usas Cloudflare R2 u otro S3 compatible
  forcePathStyle: true, // 👈 para compatibilidad con R2 o Wasabi
});

export async function guardarAudioEnCDN(
  buffer: Buffer,
  tenantId: string = 'default'
): Promise<string> {
  try {
    const filename = `audios/${tenantId}/${Date.now()}-${randomUUID()}.mp3`;

    const bucketName = process.env.AWS_BUCKET_NAME || '';
    const publicUrl = process.env.AWS_PUBLIC_URL || '';

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: filename,
      Body: buffer,
      ContentType: 'audio/mpeg',
      ACL: 'public-read', // acceso directo desde Twilio
    });

    await s3.send(command);

    return `${publicUrl}/${filename}`;
  } catch (error) {
    console.error('❌ Error al guardar audio en CDN:', error);
    return '';
  }
}
