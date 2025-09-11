// src/lib/senders/meta.ts
import axios from "axios";
import pool from "../db";

type CanalMeta = "instagram" | "facebook";

/**
 * Obtiene el Page Access Token (y opcionalmente page_id) del tenant.
 * Ajusta los nombres de columnas a lo que tengas en tu tabla tenants.
 */
async function obtenerCredsMeta(
    tenantId: string
  ): Promise<{ token: string; page_id?: string } | null> {
    const { rows } = await pool.query(
      `
      SELECT
        COALESCE(t.facebook_access_token, mc.page_access_token) AS token,
        COALESCE(t.facebook_page_id,   mc.page_id)             AS page_id
      FROM tenants t
      LEFT JOIN meta_configs mc ON mc.tenant_id = t.id
      WHERE t.id = $1
      LIMIT 1
      `,
      [tenantId]
    );
  
    const token = rows[0]?.token;
    if (!token) return null;
    return { token, page_id: rows[0]?.page_id || undefined };
  }  

export async function enviarMeta(
  canal: CanalMeta,                 // "instagram" | "facebook"
  toPsid: string,                   // PSID del destinatario (sender.id)
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
    const payload = {
      messaging_type: "RESPONSE",
      recipient: { id: toPsid },
      message: { text: mensaje },
    };

    const { data } = await axios.post(url, payload, {
      params: { access_token: creds.token }
    });

    console.log(`[META] ✅ Enviado a ${canal} psid=${toPsid} message_id=${data?.message_id || "?"}`);
  } catch (err: any) {
    console.error(`[META] ❌ Error enviando a ${canal} psid=${toPsid}:`, err?.response?.data || err?.message || err);
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
