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
});

export async function guardarAudioEnCDN(buffer: Buffer, tenantId: string): Promise<string> {
  try {
    const filename = `audios/${tenantId}/${Date.now()}-${randomUUID()}.mp3`;

    const bucketName = process.env.AWS_BUCKET_NAME || '';
    const publicUrl = process.env.AWS_PUBLIC_URL || '';

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: filename,
      Body: buffer,
      ContentType: 'audio/mpeg',
      ACL: 'public-read',
    });

    await s3.send(command);
    return `${publicUrl}/${filename}`;
  } catch (error) {
    console.error('❌ Error al guardar audio en CDN:', error);
    return '';
  }
}
