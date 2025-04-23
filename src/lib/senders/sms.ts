import twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID!;
const authToken = process.env.TWILIO_AUTH_TOKEN!;

const client = twilio(accountSid, authToken);

/**
 * Envía un mensaje SMS a una lista de destinatarios usando el número SMS del tenant.
 * @param contenido Contenido del mensaje
 * @param contactos Lista de objetos con { telefono: string }
 * @param fromNumber Número SMS de Twilio del tenant (formato: +1XXX...)
 */
export async function sendSMS(
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
        to: contacto.telefono,
      });
      console.log(`✅ SMS enviado a ${contacto.telefono}`);
    } catch (err) {
      console.error(`❌ Error enviando a ${contacto.telefono}:`, err);
    }
  }
}
