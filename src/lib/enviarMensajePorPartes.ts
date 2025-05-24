import axios from 'axios';
import pool from '../lib/db';
import OpenAI from 'openai';

interface EnvioMensajeParams {
  tenantId: string;
  canal: 'facebook' | 'instagram' | 'whatsapp';
  senderId: string;
  messageId: string;
  respuesta: string;
  accessToken: string;
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function obtenerInformacionTenant(tenantId: string, canal: string) {
  try {
    const result = await pool.query(
      `SELECT name, telefono, horario, website, descripcion, servicios, prompt, prompt_meta FROM tenants WHERE id = $1 LIMIT 1`,
      [tenantId]
    );
    const tenant = result.rows[0];
    if (!tenant) return null;

    const promptCanal = canal === 'whatsapp' ? tenant.prompt : tenant.prompt_meta;

    return {
      nombre: tenant.name || "Nuestro negocio",
      telefono: tenant.telefono || "No disponible",
      horario: tenant.horario || "No disponible",
      website: tenant.website || "",
      descripcion: tenant.descripcion || "",
      servicios: tenant.servicios || "",
      promptCanal: promptCanal || "",
    };
  } catch (error) {
    console.error("❌ Error obteniendo información del tenant:", error);
    return null;
  }
}

async function generarResumenInteligente(texto: string, limite: number, canal: string, tenantInfo: any): Promise<string> {
  try {
    const promptBase = `
Resumen adaptado para ${canal} del negocio:
📌 Nombre: ${tenantInfo.nombre}
📞 Teléfono: ${tenantInfo.telefono}
🕒 Horario: ${tenantInfo.horario}
${tenantInfo.website ? `🌐 Web: ${tenantInfo.website}` : ""}
${tenantInfo.servicios ? `💼 Servicios: ${tenantInfo.servicios}` : ""}
${tenantInfo.descripcion ? `📝 Descripción: ${tenantInfo.descripcion}` : ""}
${tenantInfo.promptCanal ? `🤖 Configuración: ${tenantInfo.promptCanal}` : ""}

🔍 Información solicitada:
${texto}
`;

    const completion = await openai.chat.completions.create({
      messages: [{ role: 'user', content: `Resume el siguiente contenido en menos de ${limite} caracteres de forma clara y adaptada al canal ${canal}. No repitas el mensaje original, sino resume los datos clave:\n${promptBase}` }],
      model: 'gpt-3.5-turbo',
      max_tokens: Math.floor(limite / 4),
    });

    let resumen = completion.choices[0]?.message?.content?.trim() || "Lamentablemente no puedo generar un resumen en este momento.";

    if (resumen.length > limite) {
      resumen = resumen.slice(0, limite - 3) + '...';
    }

    return resumen;
  } catch (error) {
    console.error("❌ Error generando resumen:", error);
    return texto.length > limite ? texto.slice(0, limite - 3) + '...' : texto;
  }
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
  const limiteWhatsApp = 4096;
  const limite = canal === 'whatsapp' ? limiteWhatsApp : limiteFacebook;

  let tenantInfo = await obtenerInformacionTenant(tenantId, canal);
  if (!tenantInfo) {
    tenantInfo = { nombre: "Nuestro negocio", telefono: "No disponible", horario: "No disponible", website: "", descripcion: "", servicios: "", promptCanal: "" };
  }

  let textoAEnviar = respuesta.trim();

  // 🔍 Verificar si el cliente pide toda la información
  const lowerRespuesta = textoAEnviar.toLowerCase();
  const frasesClave = ['quiero toda la información', 'toda la información', 'toda la info', 'información completa'];
  const pideTodo = frasesClave.some(frase => lowerRespuesta.includes(frase));

  if (pideTodo) {
    textoAEnviar = "Claro, ¿qué información específica necesitas? Por ejemplo: servicios, horarios, contacto, promociones, etc.";
  } else if (textoAEnviar.length > limite) {
    console.log(`El mensaje excede el límite de ${limite} caracteres. Generando resumen...`);
    textoAEnviar = await generarResumenInteligente(respuesta, limite, canal, tenantInfo);
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
