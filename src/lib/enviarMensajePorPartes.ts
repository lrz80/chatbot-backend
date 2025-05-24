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

  // 🔹 Separar por párrafos naturales (saltos dobles)
  const bloques = respuesta.split(/\n{2,}/).map(b => b.trim()).filter(b => b);

  for (const bloque of bloques) {
    if (bloque.length <= limiteCaracteres) {
      partes.push(bloque);
    } else {
      // Si un bloque es demasiado largo, dividirlo por líneas individuales
      const lineas = bloque.split('\n').map(l => l.trim()).filter(l => l);
      let parteActual = '';

      for (const linea of lineas) {
        const tentativa = parteActual ? `${parteActual}\n${linea}` : linea;
        if (tentativa.length > limiteCaracteres) {
          if (parteActual) partes.push(parteActual);
          parteActual = linea;
        } else {
          parteActual = tentativa;
        }
      }

      if (parteActual) partes.push(parteActual);
    }
  }

  // 🔸 Enviar y guardar cada parte
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

        await new Promise((r) => setTimeout(r, 300)); // Evitar bloqueos
      } catch (err: any) {
        console.error('❌ Error enviando fragmento:', err.response?.data || err.message || err);
      }
    }
  }

  console.log(`✅ Respuesta enviada en ${partes.length} partes al usuario (${canal})`);
}
