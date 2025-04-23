import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

/**
 * Envía correos masivos a contactos seleccionados.
 * @param contenido Contenido del mensaje
 * @param contactos Lista de objetos con { email: string }
 */
export async function sendEmail(
  contenido: string,
  contactos: { email: string }[]
) {
  for (const contacto of contactos) {
    if (!contacto.email) continue;

    try {
      await transporter.sendMail({
        from: `"Aamy AI" <noreply@aamy.ai>`,
        to: contacto.email,
        subject: "📣 Nueva campaña de tu negocio",
        html: `<p>${contenido}</p>`,
      });
      console.log(`✅ Email enviado a ${contacto.email}`);
    } catch (err) {
      console.error(`❌ Error enviando a ${contacto.email}:`, err);
    }
  }
}