import nodemailer from "nodemailer";
import { emailTemplates } from "./emailTemplates";

export type EmailLanguage = "es" | "en" | "pt";

export const transporter = nodemailer.createTransport({
  host: "mail.privateemail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const from = `"Aamy AI" <${process.env.SMTP_FROM || "noreply@aamy.ai"}>`;

function normalizeEmailLanguage(
  lang: unknown
): EmailLanguage {
  if (lang === "en" || lang === "pt") {
    return lang;
  }

  return "es";
}

// 1. Verificación de cuenta
export const sendVerificationEmail = async (
  to: string,
  verificationLink: string,
  lang: EmailLanguage = "es"
) => {
  const normalizedLang =
    normalizeEmailLanguage(lang);

  const templateFactory =
    emailTemplates.verification[normalizedLang];

  if (!templateFactory) {
    throw new Error(
      `Verification email template not found for language: ${normalizedLang}`
    );
  }

  const template =
    templateFactory(verificationLink);

  await transporter.sendMail({
    from,
    to,
    subject: template.subject,
    html: template.html,
  });
};

// 2. Cancelación de membresía
export const sendCancelationEmail = async (
  to: string,
  tenantName: string,
  lang: EmailLanguage = "es"
) => {
  const normalizedLang =
    normalizeEmailLanguage(lang);

  const templateFactory =
    emailTemplates.cancelation[normalizedLang];

  if (!templateFactory) {
    throw new Error(
      `Cancellation email template not found for language: ${normalizedLang}`
    );
  }

  const template =
    templateFactory(tenantName);

  await transporter.sendMail({
    from,
    to,
    subject: template.subject,
    html: template.html,
  });
};

// 3. Renovación automática exitosa
export const sendRenewalSuccessEmail = async (
  to: string,
  tenantName: string,
  lang: EmailLanguage = "es"
) => {
  const normalizedLang =
    normalizeEmailLanguage(lang);

  const templateFactory =
    emailTemplates.renewal[normalizedLang];

  if (!templateFactory) {
    throw new Error(
      `Renewal email template not found for language: ${normalizedLang}`
    );
  }

  const template =
    templateFactory(tenantName);

  await transporter.sendMail({
    from,
    to,
    subject: template.subject,
    html: template.html,
  });
};

// 4. Activación de membresía
export const sendSubscriptionActivatedEmail = async (
  to: string,
  tenantName: string,
  lang: EmailLanguage = "es"
) => {
  const normalizedLang =
    normalizeEmailLanguage(lang);

  const templateFactory =
    emailTemplates.subscriptionActivated?.[
      normalizedLang
    ];

  if (!templateFactory) {
    throw new Error(
      `Subscription activated email template not found for language: ${normalizedLang}`
    );
  }

  const template =
    templateFactory(tenantName);

  await transporter.sendMail({
    from,
    to,
    subject: template.subject,
    html: template.html,
  });
};