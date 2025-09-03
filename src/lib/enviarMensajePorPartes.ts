import axios from 'axios';

interface EnvioMensajeParams {
  tenantId: string;
  canal: 'facebook' | 'instagram' | 'whatsapp' | 'meta';
  senderId: string;
  messageId: string;
  accessToken: string;
  respuesta: string;
}

function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

function getMaxLen(canal: EnvioMensajeParams['canal']) {
  if (canal === 'instagram') return 900;      // seguro para IG
  if (canal === 'whatsapp') return 4096;      // Twilio
  // 'facebook' y 'meta'
  return 1800;                                // seguro para FB
}

function getDelayMs(canal: EnvioMensajeParams['canal']) {
  if (canal === 'instagram') return 600;
  if (canal === 'whatsapp') return 100;
  return 300; // facebook/meta
}

// Evita cortar emojis/acentos (usa codepoints), prioriza '\n\n' -> '\n' -> ' '.
// Si detecta que está cortando una URL (http...) sin espacio al final, retrocede al espacio previo.
function splitSmart(text: string, maxLen: number): string[] {
  const cps = Array.from((text || '').replace(/\r\n/g, '\n'));
  const out: string[] = [];
  let start = 0;

  while (start < cps.length) {
    let end = Math.min(start + maxLen, cps.length);
    let slice = cps.slice(start, end).join('');

    if (end < cps.length) {
      // Intentar corte "lindo"
      let cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'));
      if (cut < 0) cut = slice.lastIndexOf(' ');

      // Evitar cortar URL: si dentro del slice hay "http" y no hay espacio después, retroceder
      const httpIdx = slice.lastIndexOf('http');
      if (httpIdx >= 0) {
        const after = slice.slice(httpIdx).match(/\s/);
        if (!after) {
          const prevSpace = slice.lastIndexOf(' ', httpIdx - 1);
          if (prevSpace > 0) {
            cut = cut === -1 ? prevSpace : Math.min(cut, prevSpace);
          }
        }
      }

      if (cut > 0) {
        end = start + Array.from(slice.slice(0, cut)).length;
        slice = cps.slice(start, end).join('');
      }
    }

    const trimmed = slice.replace(/[ \t]+\n/g, '\n').trimEnd();
    if (trimmed) out.push(trimmed);
    start = end;
  }
  return out;
}

async function sendTyping(recipientId: string, accessToken: string, on: boolean) {
  try {
    await axios.post(
      'https://graph.facebook.com/v19.0/me/messages',
      {
        recipient: { id: recipientId },
        sender_action: on ? 'typing_on' : 'typing_off',
      },
      { params: { access_token: accessToken } }
    );
  } catch {
    // no-op
  }
}

export async function enviarMensajePorPartes({
  tenantId,
  canal,
  senderId,
  messageId,
  accessToken,
  respuesta,
}: EnvioMensajeParams) {
  const maxLen = getMaxLen(canal);
  const partes = splitSmart((respuesta || '').trim(), maxLen);
  const delay = getDelayMs(canal);

  if (partes.length === 0) return;

  for (let i = 0; i < partes.length; i++) {
    const text = partes[i];

    try {
      if (canal === 'facebook' || canal === 'instagram' || canal === 'meta') {
        await sendTyping(senderId, accessToken, true);

        await axios.post(
          'https://graph.facebook.com/v19.0/me/messages',
          {
            recipient: { id: senderId },
            message: { text },
          },
          { params: { access_token: accessToken } }
        );

        await sendTyping(senderId, accessToken, false);
      } else if (canal === 'whatsapp') {
        await axios.post(
          `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
          new URLSearchParams({
            To: `whatsapp:${senderId}`,
            From: `whatsapp:${process.env.TWILIO_NUMBER}`,
            Body: text,
          }),
          {
            auth: {
              username: process.env.TWILIO_ACCOUNT_SID!,
              password: process.env.TWILIO_AUTH_TOKEN!,
            },
          }
        );
      }

      console.log(`✅ Mensaje enviado por ${canal}: ${text.length} caracteres (parte ${i + 1}/${partes.length})`);
      if (i < partes.length - 1) await sleep(delay);
    } catch (err: any) {
      console.error('❌ Error enviando mensaje:', err?.response?.data || err?.message || err);
      // continuar con la siguiente parte para no bloquear toda la conversación
    }
  }
}
