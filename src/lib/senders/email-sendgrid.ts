// src/lib/senders/email-sendgrid.ts

import sgMail from "@sendgrid/mail";
import pool from "../db";
import { generarHTMLCorreo } from "../../utils/email-html";

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

/**
 * Envío clásico de campaña con HTML generado
 */
export async function sendEmailSendgrid(
  contenido: string,
  contactos: { email: string }[],
  nombreNegocio: string,
  tenantId: string,
  campaignId: number,
  imagenUrl?: string,
  linkUrl?: string,
  logoUrl?: string,
  asunto?: string
) {
  const envíos: any[] = [];

  for (const contacto of contactos) {
    const email = contacto.email?.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;

    const html = generarHTMLCorreo(
      contenido,
      nombreNegocio,
      imagenUrl,
      linkUrl,
      logoUrl,
      email,
      tenantId
    );

    envíos.push({
      to: email,
      from: {
        name: nombreNegocio,
        email: "noreply@aamy.ai",
      },
      subject: asunto || "📣 Nueva campaña de tu negocio",
      html,
    });
  }

  try {
    await sgMail.send(envíos, true);
    console.log(`✅ Emails enviados correctamente (${envíos.length})`);

    const inserts = envíos.map((e) =>
      pool.query(
        `INSERT INTO email_status_logs (tenant_id, campaign_id, email, status, timestamp)
         VALUES ($1, $2, $3, 'sent', NOW())`,
        [tenantId, campaignId, e.to]
      )
    );
    await Promise.all(inserts);
  } catch (error: any) {
    console.error("❌ Error al enviar por SendGrid:", error?.response?.body || error.message);

    const inserts = envíos.map((e) =>
      pool.query(
        `INSERT INTO email_status_logs (tenant_id, campaign_id, email, status, error_message, timestamp)
         VALUES ($1, $2, $3, 'failed', $4, NOW())`,
        [tenantId, campaignId, e.to, error?.message || "Error desconocido"]
      )
    );
    await Promise.all(inserts);
  }
}

/**
 * Envío con plantilla dinámica de SendGrid
 */
export async function sendEmailWithTemplate(
  contactos: { email: string; vars?: Record<string, any> }[],
  templateId: string,
  nombreNegocio: string,
  tenantId: string,
  campaignId: number
) {
  const envíos: any[] = [];

  for (const contacto of contactos) {
    const email = contacto.email?.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;

    envíos.push({
      to: {
        email,
      },
      from: {
        name: nombreNegocio,
        email: "noreply@aamy.ai",
      },
      templateId,
      dynamicTemplateData: contacto.vars || {},
    });
  }

  try {
    await sgMail.send(envíos, true);
    console.log(`✅ Emails con plantilla enviados (${envíos.length})`);

    const inserts = envíos.map((e) =>
      pool.query(
        `INSERT INTO email_status_logs (tenant_id, campaign_id, email, status, timestamp)
         VALUES ($1, $2, $3, 'sent', NOW())`,
        [tenantId, campaignId, e.to.email]
      )
    );
    await Promise.all(inserts);
  } catch (error: any) {
    console.error("❌ Error en plantilla SendGrid:", error?.response?.body || error.message);

    const inserts = envíos.map((e) =>
      pool.query(
        `INSERT INTO email_status_logs (tenant_id, campaign_id, email, status, error_message, timestamp)
         VALUES ($1, $2, $3, 'failed', $4, NOW())`,
        [tenantId, campaignId, e.to.email, error?.message || "Error desconocido"]
      )
    );
    await Promise.all(inserts);
  }
}
