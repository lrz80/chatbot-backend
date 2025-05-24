import axios from 'axios';
import pool from '../lib/db';

interface EnvioMensajeParams {
  tenantId: string;
  canal: 'facebook' | 'instagram' | 'whatsapp';
  senderId: string;
  messageId: string;
  respuesta: string;
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
  const limiteFacebook = 980;
  const limiteWhatsApp = 4096; // Twilio permite ~4096
  const limite = canal === 'whatsapp' ? limiteWhatsApp : limiteFacebook;

  const resumen = "Amy es tu asistente virtual que te ayudará con atención, ventas y marketing. Por favor, indícame sobre qué área necesitas información (por ejemplo: atención al cliente, marketing, seguimiento, etc.) para darte los detalles específicos.";

  let textoAEnviar = respuesta.trim();

  if (textoAEnviar.length > limite) {
    console.log(`El mensaje excede el límite permitido (${limite}). Enviando resumen.`);
    textoAEnviar = resumen;
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

      await new Promise((r) => setTimeout(r, 300)); // Pausa
    } catch (err: any) {
      console.error('❌ Error enviando mensaje:', err.response?.data || err.message || err);
    }
  }

  console.log(`✅ Respuesta enviada (${canal}): ${textoAEnviar.length} caracteres`);
}
