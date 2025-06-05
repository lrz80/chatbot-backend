import axios from 'axios';
import pool from '../lib/db';

interface EnvioMensajeParams {
  tenantId: string;
  canal: 'facebook' | 'instagram' | 'whatsapp' | 'meta'; // 🎉 Se agrega 'meta'
  senderId: string;
  messageId: string;
  accessToken: string;
  respuesta: string; // Añadimos esta propiedad para recibir el mensaje procesado
}

export async function enviarMensajePorPartes({
  tenantId,
  canal,
  senderId,
  messageId,
  accessToken,
  respuesta,
}: EnvioMensajeParams) {
  const limiteFacebook = 980;
  const limiteWhatsApp = 4096;
  const limite = canal === 'whatsapp' ? limiteWhatsApp : limiteFacebook;

  let textoAEnviar = respuesta.trim();
  if (textoAEnviar.length > limite) {
    textoAEnviar = textoAEnviar.slice(0, limite - 3) + "...";
  }

  try {
    if (canal === 'facebook' || canal === 'instagram' || canal === 'meta') {
      const url = `https://graph.facebook.com/v19.0/me/messages`;
      const payload = {
        recipient: { id: senderId },
        message: { text: textoAEnviar },
      };

      await axios.post(url, payload, {
        params: { access_token: accessToken },
      });

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

    console.log(`✅ Mensaje enviado por ${canal}: ${textoAEnviar.length} caracteres`);
    await new Promise((r) => setTimeout(r, 300));
  } catch (err: any) {
    console.error('❌ Error enviando mensaje:', err.response?.data || err.message || err);
  }
}