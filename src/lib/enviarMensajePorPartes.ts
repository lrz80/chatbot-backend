// ✅ utils/enviarMensajePorPartes.ts

import axios from 'axios';
import pool from '../lib/db';

interface EnvioMensajeParams {
  tenantId: string;
  canal: 'facebook' | 'instagram' | 'whatsapp';
  senderId: string;
  messageId: string;
  respuesta: string; // ← CAMBIO aquí
  accessToken: string;
}

export async function enviarMensajePorPartes({
  tenantId,
  canal,
  senderId,
  messageId,
  respuesta,
  accessToken,
}: EnvioMensajeParams) {
  const partes: string[] = [];
  let temp = respuesta;
  const limiteCaracteres = 950;

  while (temp.length > 0) {
    let corte = temp.slice(0, limiteCaracteres);
    const saltoLinea = corte.lastIndexOf("\n");
    if (saltoLinea > 600) corte = corte.slice(0, saltoLinea);
    partes.push(corte);
    temp = temp.slice(corte.length).trimStart();
  }

  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    const messageFragmentId = `bot-${messageId}-${i}`;

    const yaExiste = await pool.query(
      `SELECT 1 FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`,
      [tenantId, messageFragmentId]
    );

    if (yaExiste.rows.length === 0) {
      await pool.query(
        `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number, message_id)
         VALUES ($1, 'bot', $2, NOW(), $3, $4, $5)`,
        [tenantId, parte, canal, senderId, messageFragmentId]
      );

      try {
        await axios.post(
          `https://graph.facebook.com/v19.0/me/messages`,
          {
            recipient: { id: senderId },
            message: { text: parte },
          },
          { params: { access_token: accessToken } }
        );
        await new Promise((r) => setTimeout(r, 300));
      } catch (err: any) {
        console.error('❌ Error enviando fragmento:', err.response?.data || err.message || err);
      }
    }
  }

  console.log(`✅ Respuesta enviada en ${partes.length} partes al usuario (${canal})`);
}
