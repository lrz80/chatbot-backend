// src/lib/r2/subirArchivoAR2.ts
import { R2 } from "./r2Client";
import mime from "mime-types";

/**
 * Sube un archivo buffer a R2 o S3 y devuelve la URL pública
 * @param key Ruta destino dentro del bucket (ej. email-assets/tenant-id/filename.jpg)
 * @param buffer Contenido binario del archivo
 * @param mimeType Tipo MIME (opcional, se detecta si no se pasa)
 * @returns URL pública del archivo
 */
export async function subirArchivoAR2(key: string, buffer: Buffer, mimeType?: string): Promise<string> {
  const tipo = mimeType || mime.lookup(key) || "application/octet-stream";
  const url = await R2.put(key, buffer, { httpMetadata: { contentType: tipo } });
  return url;
}
