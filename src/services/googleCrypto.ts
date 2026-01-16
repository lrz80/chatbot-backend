import crypto from "crypto";

const KEY_B64 = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "";

function getKey(): Buffer {
  const key = Buffer.from(KEY_B64, "base64");
  if (key.length !== 32) {
    throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY debe ser 32 bytes en base64 (AES-256-GCM).");
  }
  return key;
}

export function encryptToken(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12); // GCM recommended
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // iv:ciphertext:tag en base64
  return `${iv.toString("base64")}:${ciphertext.toString("base64")}:${tag.toString("base64")}`;
}

export function decryptToken(enc: string): string {
  const key = getKey();
  const [ivB64, ctB64, tagB64] = (enc || "").split(":");
  if (!ivB64 || !ctB64 || !tagB64) throw new Error("Token cifrado inválido");

  const iv = Buffer.from(ivB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const tag = Buffer.from(tagB64, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plain.toString("utf8");
}
