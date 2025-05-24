import axios from 'axios';
import pool from '../lib/db';

interface EnvioMensajeParams {
  tenantId: string;
  canal: 'facebook' | 'instagram' | 'whatsapp';
  senderId: string;
  messageId: string;
  respuesta: string; // Este campo ya no es relevante
  accessToken: string;
}

export async function enviarMensajePorPartes({
  tenantId,
  canal,
  senderId,
  messageId,
  accessToken,
}: EnvioMensajeParams) {
  const limiteFacebook = 980;
  const limiteWhatsApp = 4096;
  const limite = canal === 'whatsapp' ? limiteWhatsApp : limiteFacebook;

  // 🔍 Obtener el prompt por canal
  const result = await pool.query(
    `SELECT prompt, prompt_meta FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  const tenant = result.rows[0];
  if (!tenant) {
    console.error("❌ Tenant no encontrado");
    return;
  }

  const prompt = canal === 'whatsapp' ? tenant.prompt : tenant.prompt_meta;
  if (!prompt) {
    console.error("❌ Prompt no configurado para el canal");
    return;
  }

  // 🔎 Limitar longitud del mensaje
  let textoAEnviar = prompt.trim();
  if (textoAEnviar.length > limite) {
    textoAEnviar = textoAEnviar.slice(0, limite - 3) + "...";
  }

  const messageFragmentId = `bot-${messageId}`;
  const yaExiste = await pool.query(
    `SELECT 1 FROM messages WHERE tenant_id = $1 AND message_id = $2 LIMIT 1`,
    [tenantId, messageFragmentId]
  );

  if (yaExiste.rows.length === 0) {
    await pool.query(
      `INSERT INTO messages (tenant_id, sender, content, timestamp, canal, from_number, message_id)
       VALUES ($1, 'bot', $2, NOW(), $3, $4, $5)`,
      [tenantId, textoAEnviar, canal, senderId, messageFragmentId]
    );

    try {
      if (canal === 'facebook' || canal === 'instagram') {
        await axios.post(
          `https://graph.facebook.com/v19.0/me/messages`,
          {
            recipient: { id: senderId },
            message: { text: textoAEnviar },
          },
          { params: { access_token: accessToken } }
        );
      } else if (canal === 'whatsapp') {
        await axios.post(
          `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
          new URLSearchParams({
            To: `whatsapp:${senderId}`,
            From: `whatsapp:${process.env.TWILIO_NUMBER}`,
            Body: textoAEnviar,
          }),
          {
            auth: {
              username: process.env.TWILIO_ACCOUNT_SID!,
              password: process.env.TWILIO_AUTH_TOKEN!,
            },
          }
        );
      }

      await new Promise((r) => setTimeout(r, 300));
    } catch (err: any) {
      console.error('❌ Error enviando mensaje:', err.response?.data || err.message || err);
    }
  }

  console.log(`✅ Respuesta enviada (${canal}): ${textoAEnviar.length} caracteres`);
}
