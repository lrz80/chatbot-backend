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
  const limiteCaracteres = 950;
  const partes: string[] = [];

  // 1️⃣ Numerar solo líneas con contenido
  const lineas = respuesta.split('\n');
  let contador = 1;
  const lineasNumeradas = lineas.map((linea) => {
    const texto = linea.trim();
    if (!texto) return '';
    return `${contador++}. ${texto.replace(/^\d+\.\s*/, '')}`;
  });

  // 2️⃣ Agrupar líneas sin cortar
  let bloqueActual = '';
  for (const linea of lineasNumeradas) {
    const tentativa = (bloqueActual ? bloqueActual + '\n' : '') + linea;
    if (tentativa.length > limiteCaracteres) {
      if (bloqueActual) {
        partes.push(bloqueActual.trim());
        bloqueActual = linea;
      } else {
        partes.push(linea.slice(0, limiteCaracteres));
        bloqueActual = linea.slice(limiteCaracteres);
      }
    } else {
      bloqueActual = tentativa;
    }
  }
  if (bloqueActual.trim()) partes.push(bloqueActual.trim());

  // 3️⃣ Enviar cada parte solo si no fue enviada
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
        if (canal === 'facebook' || canal === 'instagram') {
          await axios.post(
            `https://graph.facebook.com/v19.0/me/messages`,
            {
              recipient: { id: senderId },
              message: { text: parte },
            },
            { params: { access_token: accessToken } }
          );
        } else if (canal === 'whatsapp') {
          await axios.post(
            `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
            new URLSearchParams({
              To: `whatsapp:${senderId}`,
              From: `whatsapp:${process.env.TWILIO_NUMBER}`,
              Body: parte,
            }),
            {
              auth: {
                username: process.env.TWILIO_ACCOUNT_SID!,
                password: process.env.TWILIO_AUTH_TOKEN!,
              },
            }
          );
        }

        await new Promise((r) => setTimeout(r, 300)); // Espera para evitar rate limit
      } catch (err: any) {
        console.error('❌ Error enviando fragmento:', err.response?.data || err.message || err);
      }
    }
  }

  console.log(`✅ Respuesta enviada en ${partes.length} partes al usuario (${canal})`);
}
