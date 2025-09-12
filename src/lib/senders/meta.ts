// src/lib/senders/meta.ts
import axios from "axios";
import pool from "../db";

type CanalMeta = "instagram" | "facebook";

/**
 * Lee credenciales desde tenants y decide el endpoint correcto según el canal.
 * Para IG se usa el *Instagram Business Account ID* como path: /{IG_BIZ_ID}/messages
 * El token es el *Facebook Page Access Token* (sirve para FB e IG).
 */
// Credenciales: usa las columnas reales que tienes en tenants
async function obtenerCredsMeta(tenantId: string): Promise<{
    token: string,
    page_id?: string,
    ig_biz_id?: string
  } | null> {
    const { rows } = await pool.query(
      `SELECT 
         facebook_access_token    AS token,
         facebook_page_id         AS page_id,
         instagram_business_account_id AS ig_biz_id
       FROM tenants
       WHERE id = $1
       LIMIT 1`,
      [tenantId]
    );
    const token = rows[0]?.token;
    if (!token) return null;
    return { token, page_id: rows[0]?.page_id, ig_biz_id: rows[0]?.ig_biz_id };
  }
  
  export async function enviarMeta(
    canal: "instagram" | "facebook",
    toPsid: string,
    mensaje: string,
    tenantId: string
  ) {
    const creds = await obtenerCredsMeta(tenantId);
    if (!creds?.token) {
      console.warn(`[META] ❌ Tenant ${tenantId} sin facebook_access_token`);
      return;
    }
  
    try {
      const url = `https://graph.facebook.com/v18.0/me/messages`;
  
      const payload =
        canal === "instagram"
          ? {
              messaging_product: "instagram",   // 👈 OBLIGATORIO en IG
              recipient: { id: toPsid },
              message: { text: mensaje },
            }
          : {
              messaging_type: "RESPONSE",       // 👈 Solo para Messenger
              recipient: { id: toPsid },
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
