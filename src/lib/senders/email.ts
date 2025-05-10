import nodemailer from "nodemailer";
import pool from "../db";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// 💌 Generador de HTML visual
function generarHTMLCorreo(
  contenido: string,
  negocio: string,
  imagenUrl?: string,
  linkUrl?: string,
  logoUrl?: string,
  email?: string,
  tenantId?: string
): string {
  const contenidoSeguro = contenido.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const unsubscribeLink = `https://aamy.ai/unsubscribe?email=${encodeURIComponent(email || "")}&tenant=${tenantId || ""}`;

  return `
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
      <title>Campaña de Marketing</title>
    </head>
    <body style="margin:0; padding:0; font-family:Arial, sans-serif; background-color:#f4f4f4;">
      <table width="100%" bgcolor="#f4f4f4" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td align="center">
            <table width="600" cellpadding="20" cellspacing="0" bgcolor="#ffffff" style="margin-top: 40px; border-radius: 8px;">
              <tr>
                <td align="center">
                  ${
                    logoUrl
                      ? `<img src="${logoUrl}" alt="Logo del negocio" style="max-width: 150px; margin-bottom: 20px;" />`
                      : `<img src="https://via.placeholder.com/150x50?text=${encodeURIComponent(negocio)}" alt="Logo del negocio" style="max-width: 150px; margin-bottom: 20px;" />`
                  }
                  <h2 style="color: #333333;">📣 ¡Oferta especial para ti!</h2>

                  ${
                    imagenUrl
                      ? `<img src="${imagenUrl}" alt="Imagen" style="max-width:100%; border-radius: 6px; margin-bottom: 20px;" />`
                      : ""
                  }

                  <p style="color:#555555; font-size: 16px;">
                    ${contenidoSeguro}
                  </p>

                  ${
                    linkUrl
                      ? `<a href="${linkUrl}" target="_blank" style="display:inline-block; padding:12px 24px; margin-top: 20px; background-color:#6c5ce7; color:white; text-decoration:none; border-radius:4px;">Ver más</a>`
                      : ""
                  }

                  <hr style="margin: 40px 0; border: none; border-top: 1px solid #ddd;">
                  <p style="font-size:12px; color:#999999;">
                    Este mensaje fue enviado por ${negocio} • 
                    <a href="${unsubscribeLink}" style="color:#999;" target="_blank">
                      Cancelar suscripción
                    </a>
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

/**
 * Envía correos personalizados por tenant y guarda logs por campaña.
 */
export async function sendEmail(
  contenido: string,
  contactos: { email: string }[],
  nombreNegocio: string,
  tenantId: string,
  campaignId: number,
  imagenUrl?: string,
  linkUrl?: string,
  logoUrl?: string
) {
  for (const contacto of contactos) {
    const email = contacto.email?.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;

    const html = generarHTMLCorreo(contenido, nombreNegocio, imagenUrl, linkUrl, logoUrl, email, tenantId);

    try {
      await transporter.sendMail({
        from: `"${nombreNegocio}" <noreply@aamy.ai>`,
        to: email,
        subject: "📣 Nueva campaña de tu negocio",
        html,
        text: contenido, // Fallback texto plano
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
