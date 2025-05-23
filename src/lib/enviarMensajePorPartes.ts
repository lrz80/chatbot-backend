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
  const partes: string[] = [];
  const limiteCaracteres = 950;

  // 📦 Paso 1: Fragmentar por párrafos dobles
  const bloques = respuesta.split(/\n{2,}/); 
  let parteActual = '';

  for (const bloque of bloques) {
    const texto = bloque.trim();

    if ((parteActual + '\n\n' + texto).length <= limiteCaracteres) {
      parteActual += (parteActual ? '\n\n' : '') + texto;
    } else {
      if (parteActual.trim()) partes.push(parteActual.trim());

      if (texto.length <= limiteCaracteres) {
        parteActual = texto;
      } else {
        // Fragmentar por líneas si un bloque es demasiado largo
        const subLineas = texto.split('\n');
        let subParte = '';
        for (const linea of subLineas) {
          if ((subParte + '\n' + linea).length <= limiteCaracteres) {
            subParte += (subParte ? '\n' : '') + linea;
          } else {
            partes.push(subParte.trim());
            subParte = linea;
          }
        }
        if (subParte) partes.push(subParte.trim());
        parteActual = '';
      }
    }
  }

  if (parteActual.trim()) partes.push(parteActual.trim());

  // 📤 Paso 2: Enviar y registrar cada fragmento
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
        await new Promise((r) => setTimeout(r, 300)); // ⏱ evita rate limit
      } catch (err: any) {
        console.error('❌ Error enviando fragmento:', err.response?.data || err.message || err);
      }
    }
  }

  console.log(`✅ Respuesta enviada en ${partes.length} partes al usuario (${canal})`);
}
