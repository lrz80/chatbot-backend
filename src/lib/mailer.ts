import nodemailer from 'nodemailer';
import { emailTemplates } from './emailTemplates'; // asegúrate que la ruta sea correcta

export const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS,
  },
});

const from = `"Amy AI" <${process.env.EMAIL_FROM}>`;

// ✅ 1. Verificación de cuenta
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

// ✅ 2. Cancelación de membresía
export const sendCancelationEmail = async (
  to: string,
  lang: 'es' | 'en' = 'es'
) => {
  const template = emailTemplates.cancelation[lang]();
  await transporter.sendMail({
    from,
    to,
    subject: template.subject,
    html: template.html,
  });
};

// ✅ 3. Renovación automática exitosa
export const sendRenewalSuccessEmail = async (
  to: string,
  lang: 'es' | 'en' = 'es'
) => {
  const template = emailTemplates.renewal[lang]();
  await transporter.sendMail({
    from,
    to,
    subject: template.subject,
    html: template.html,
  });
};
