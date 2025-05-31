import nodemailer from 'nodemailer';
import { emailTemplates } from './emailTemplates'; // asegúrate que la ruta sea correcta

export const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER, // ✅ Usamos el usuario SMTP real
    pass: process.env.SMTP_PASS, // ✅ La contraseña SMTP
  },  
});

const from = `"Aamy AI" <${process.env.SMTP_FROM || 'noreply@aamy.ai'}>`;

// ✅ 1. Verificación de cuenta (no necesita tenantName)
export const sendVerificationEmail = async (
  to: string,
  verificationLink: string,
  lang: 'es' | 'en' = 'es'
) => {
  const template = emailTemplates.verification[lang](verificationLink);
  await transporter.sendMail({
    from,
    to,
    subject: template.subject,
    html: template.html,
  });
};

// ✅ 2. Cancelación de membresía (ahora recibe tenantName)
export const sendCancelationEmail = async (
  to: string,
  tenantName: string,
  lang: 'es' | 'en' = 'es'
) => {
  const template = emailTemplates.cancelation[lang](tenantName);
  await transporter.sendMail({
    from,
    to,
    subject: template.subject,
    html: template.html,
  });
};

// ✅ 3. Renovación automática exitosa (ahora recibe tenantName)
export const sendRenewalSuccessEmail = async (
  to: string,
  tenantName: string,
  lang: 'es' | 'en' = 'es'
) => {
  const template = emailTemplates.renewal[lang](tenantName);
  await transporter.sendMail({
    from,
    to,
    subject: template.subject,
    html: template.html,
  });
};
