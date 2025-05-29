"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.guardarAudioEnCDN = guardarAudioEnCDN;
const client_s3_1 = require("@aws-sdk/client-s3");
const crypto_1 = require("crypto");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const s3 = new client_s3_1.S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    },
});
async function guardarAudioEnCDN(buffer, tenantId) {
    try {
        const filename = `audios/${tenantId}/${Date.now()}-${(0, crypto_1.randomUUID)()}.mp3`;
        const bucketName = process.env.AWS_BUCKET_NAME || '';
        const publicUrl = process.env.AWS_PUBLIC_URL || '';
        const command = new client_s3_1.PutObjectCommand({
            Bucket: bucketName,
            Key: filename,
            Body: buffer,
            ContentType: 'audio/mpeg',
            // ❌ NO USES ACL si el bucket no lo permite
        });
        await s3.send(command);
        return `${publicUrl}/${filename}`;
    }
    catch (error) {
        console.error('❌ Error al guardar audio en CDN:', error);
        return '';
    }
}
