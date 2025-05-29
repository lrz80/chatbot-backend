"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.R2 = void 0;
// src/lib/r2/r2Client.ts
const client_s3_1 = require("@aws-sdk/client-s3");
const stream_1 = require("stream");
const lib_storage_1 = require("@aws-sdk/lib-storage");
const REGION = process.env.AWS_REGION;
const BUCKET = process.env.AWS_BUCKET_NAME;
const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const PUBLIC_URL = process.env.AWS_PUBLIC_URL || ""; // ej: https://assets.aamy.ai
const client = new client_s3_1.S3Client({
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
exports.R2 = {
    async put(key, buffer, options) {
        const upload = new lib_storage_1.Upload({
            client,
            params: {
                Bucket: BUCKET,
                Key: key,
                Body: stream_1.Readable.from(buffer),
                ContentType: options?.httpMetadata?.contentType || "application/octet-stream",
            },
        });
        await upload.done();
        // Devuelve la URL pública
        return `${PUBLIC_URL}/${key}`;
    },
};
