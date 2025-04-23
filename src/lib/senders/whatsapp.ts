import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;

const client = twilio(accountSid, authToken);

/**
 * Envía un mensaje de WhatsApp a una lista de destinatarios usando el número Twilio del tenant.
 * @param contenido Contenido del mensaje
 * @param contactos Lista de objetos con { telefono: string }
 * @param fromNumber Número de Twilio del tenant (formato: whatsapp:+123456789)
 */
export async function sendWhatsApp(
  contenido: string,
  contactos: { telefono: string }[],
  fromNumber: string
) {
  for (const contacto of contactos) {
    if (!contacto.telefono) continue;

    try {
      await client.messages.create({
        body: contenido,
        from: fromNumber,
        to: `whatsapp:${contacto.telefono}`,
      });
      console.log(`✅ WhatsApp enviado a ${contacto.telefono}`);
    } catch (err) {
      console.error(`❌ Error enviando a ${contacto.telefono}:`, err);
    }
  }
}
