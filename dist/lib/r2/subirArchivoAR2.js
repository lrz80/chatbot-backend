"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.subirArchivoAR2 = subirArchivoAR2;
// src/lib/r2/subirArchivoAR2.ts
const r2Client_1 = require("./r2Client");
const mime_types_1 = __importDefault(require("mime-types"));
/**
 * Sube un archivo buffer a R2 o S3 y devuelve la URL pública
 * @param key Ruta destino dentro del bucket (ej. email-assets/tenant-id/filename.jpg)
 * @param buffer Contenido binario del archivo
 * @param mimeType Tipo MIME (opcional, se detecta si no se pasa)
 * @returns URL pública del archivo
 */
async function subirArchivoAR2(key, buffer, mimeType) {
    const tipo = mimeType || mime_types_1.default.lookup(key) || "application/octet-stream";
    const url = await r2Client_1.R2.put(key, buffer, { httpMetadata: { contentType: tipo } });
    return url;
}
