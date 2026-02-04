// backend/src/lib/notifications/sendEmailToTenant.ts
import pool from "../db";
import nodemailer from "nodemailer";

export async function sendEmailToTenant(opts: {
  tenantId: string;
  toEmail: string;
  subject: string;
  text: string;
}) {
  const { tenantId, subject, text } = opts;

  const { rows } = await pool.query(
    `SELECT email_negocio
       FROM tenants
      WHERE id = $1
      LIMIT 1`,
    [tenantId]
  );

  const to = String(rows[0]?.email_negocio || "").trim();
  if (!to) throw new Error("email_negocio missing for tenant");

  // ✅ Ajusta a tu config real (ya usas noreply@aamy.ai)
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.MAIL_FROM || "noreply@aamy.ai",
    to,
    subject,
    text,
  });

  return true;
}
