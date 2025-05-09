import nodemailer from "nodemailer";
import pool from "../db"; // 👈 necesario para guardar logs

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
 * Envía correos personalizados por tenant y guarda logs por campaña.
 * @param contenido Contenido del mensaje (HTML)
 * @param contactos Lista de objetos con { email: string }
 * @param nombreNegocio Nombre del remitente (alias)
 * @param tenantId ID del tenant (para logs)
 * @param campaignId ID de la campaña (para logs)
 */
export async function sendEmail(
  contenido: string,
  contactos: { email: string }[],
  nombreNegocio: string,
  tenantId: string,
  campaignId: number
) {
  for (const contacto of contactos) {
    const email = contacto.email?.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;

    try {
      await transporter.sendMail({
        from: `"${nombreNegocio}" <noreply@aamy.ai>`,
        to: email,
        subject: "📣 Nueva campaña de tu negocio",
        html: `<p>${contenido}</p>`,
      });

      await pool.query(
        `INSERT INTO email_status_logs (
          tenant_id, campaign_id, email, status, timestamp
        ) VALUES ($1, $2, $3, 'sent', NOW())`,
        [tenantId, campaignId, email]
      );

      console.log(`✅ Email enviado a ${email}`);
    } catch (err: any) {
      console.error(`❌ Error enviando a ${email}:`, err?.message || err);

      await pool.query(
        `INSERT INTO email_status_logs (
          tenant_id, campaign_id, email, status, error_message, timestamp
        ) VALUES ($1, $2, $3, 'failed', $4, NOW())`,
        [tenantId, campaignId, email, err?.message || "Error desconocido"]
      );
    }
  }
}
