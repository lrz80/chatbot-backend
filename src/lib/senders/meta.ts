// src/lib/senders/meta.ts
import axios from "axios";
import pool from "../db";

type CanalMeta = "instagram" | "facebook";

/**
 * Lee credenciales desde tenants y decide el endpoint correcto según el canal.
 * Para IG se usa el *Instagram Business Account ID* como path: /{IG_BIZ_ID}/messages
 * El token es el *Facebook Page Access Token* (sirve para FB e IG).
 */
async function obtenerCredsMeta(
  tenantId: string,
  canal: CanalMeta
): Promise<{ token: string; endpointId: string; pageId?: string } | null> {
  try {
    const { rows } = await pool.query(
      `
      SELECT
        facebook_access_token,
        facebook_page_id,
        instagram_page_id,
        instagram_business_account_id
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [tenantId]
    );

    const r = rows[0] || {};
    // El token a usar (page access token). Válido para FB y también para IG Messaging.
    const token =
      r.facebook_access_token ||
      process.env.FACEBOOK_PAGE_TOKEN ||
      process.env.META_PAGE_TOKEN ||
      null;

    if (!token) {
      console.warn(`[META] ❌ No hay facebook_access_token (ni ENV) para tenant=${tenantId}`);
      return null;
    }

    if (canal === "facebook") {
      // Para Messenger usamos /me/messages con el page access token.
      const pageId = r.facebook_page_id || process.env.FACEBOOK_PAGE_ID;
      return { token, endpointId: "me", pageId };
    } else {
      // Para Instagram usamos /{IG_BUSINESS_ACCOUNT_ID}/messages
      const igBizId =
        r.instagram_business_account_id ||
        r.instagram_page_id || // fallback por si tu schema usa este
        process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ||
        process.env.INSTAGRAM_PAGE_ID ||
        null;

      if (!igBizId) {
        console.warn(
          `[META] ❌ Falta instagram_business_account_id (o fallback) para tenant=${tenantId}`
        );
        return null;
      }
      return { token, endpointId: igBizId };
    }
  } catch (e) {
    console.error(`[META] ❌ Error leyendo credenciales Meta:`, e);
    return null;
  }
}  

export async function enviarMeta(
    canal: CanalMeta,            // "instagram" | "facebook"
    toPsid: string,              // PSID (FB) o IGSID (IG) del destinatario
    mensaje: string,
    tenantId: string
  ) {
    const creds = await obtenerCredsMeta(tenantId, canal);
    if (!creds?.token) return;
  
    try {
      const url =
        canal === "instagram"
          ? `https://graph.facebook.com/v18.0/${creds.endpointId}/messages`
          : `https://graph.facebook.com/v18.0/me/messages`;
  
      // Para IG, el cuerpo no requiere page_id; para FB usamos /me/messages.
      const payload =
        canal === "instagram"
          ? {
              recipient: { id: toPsid },       // IGSID
              message: { text: mensaje },
            }
          : {
              messaging_type: "RESPONSE",
              recipient: { id: toPsid },       // PSID
              message: { text: mensaje },
            };
  
      const { data } = await axios.post(url, payload, {
        params: { access_token: creds.token },
      });
  
      console.log(
        `[META] ✅ Enviado a ${canal} id=${toPsid} message_id=${data?.message_id || "?"}`
      );
    } catch (err: any) {
      console.error(
        `[META] ❌ Error enviando a ${canal} id=${toPsid}:`,
        err?.response?.data || err?.message || err
      );
    }
  }

/** Envío seguro con particionado por límite de caracteres por canal */
export async function enviarMetaSeguro(
  canal: CanalMeta,
  toPsid: string,
  text: string,
  tenantId: string
) {
  // Límites seguros (aprox): IG ~1000, FB ~2000
  const LIMIT = canal === "instagram" ? 900 : 1900;

  const chunkByLimit = (t: string, limit: number) => {
    const blocks = t.replace(/\r\n/g, "\n").split(/\n\n+/);
    const chunks: string[] = [];
    let cur = "";

    const push = () => { if (cur) { chunks.push(cur); cur = ""; } };

    for (const b0 of blocks) {
      let b = b0;
      if ((cur ? cur.length + 2 : 0) + b.length <= limit) {
        cur = cur ? `${cur}\n\n${b}` : b;
        continue;
      }
      push();
      if (b.length <= limit) { cur = b; continue; }

      const lines = b.split("\n");
      let acc = "";
      for (let line of lines) {
        if ((acc ? acc.length + 1 : 0) + line.length <= limit) {
          acc = acc ? `${acc}\n${line}` : line;
        } else {
          if (acc) chunks.push(acc);
          while (line.length > limit) {
            chunks.push(line.slice(0, limit));
            line = line.slice(limit);
          }
          acc = line;
        }
      }
      if (acc) chunks.push(acc);
    }
    push();
    return chunks;
  };

  const parts = chunkByLimit(text, LIMIT);
  for (let i = 0; i < parts.length; i++) {
    console.log(`[META] TX ${canal} chunk ${i + 1}/${parts.length} len=${parts[i].length}`);
    await enviarMeta(canal, toPsid, parts[i], tenantId);
  }
}
