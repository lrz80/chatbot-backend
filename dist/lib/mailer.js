"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendSubscriptionActivatedEmail = exports.sendRenewalSuccessEmail = exports.sendCancelationEmail = exports.sendVerificationEmail = exports.transporter = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const emailTemplates_1 = require("./emailTemplates"); // asegúrate que la ruta sea correcta
exports.transporter = nodemailer_1.default.createTransport({
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
const sendVerificationEmail = async (to, verificationLink, lang = 'es') => {
    const template = emailTemplates_1.emailTemplates.verification[lang](verificationLink);
    await exports.transporter.sendMail({
        from,
        to,
        subject: template.subject,
        html: template.html,
    });
};
exports.sendVerificationEmail = sendVerificationEmail;
// ✅ 2. Cancelación de membresía (ahora recibe tenantName)
const sendCancelationEmail = async (to, tenantName, lang = 'es') => {
    const template = emailTemplates_1.emailTemplates.cancelation[lang](tenantName);
    await exports.transporter.sendMail({
        from,
        to,
        subject: template.subject,
        html: template.html,
    });
};
exports.sendCancelationEmail = sendCancelationEmail;
// ✅ 3. Renovación automática exitosa (ahora recibe tenantName)
const sendRenewalSuccessEmail = async (to, tenantName, lang = 'es') => {
    const template = emailTemplates_1.emailTemplates.renewal[lang](tenantName);
    await exports.transporter.sendMail({
        from,
        to,
        subject: template.subject,
        html: template.html,
    });
};
exports.sendRenewalSuccessEmail = sendRenewalSuccessEmail;
// ✅ 4. Activación de membresía (compra o inicio de trial)
const sendSubscriptionActivatedEmail = async (to, tenantName, lang = 'es') => {
    const template = emailTemplates_1.emailTemplates.subscriptionActivated?.[lang]?.(tenantName);
    if (!template) {
        console.error('❌ Error: La plantilla subscriptionActivated no está definida.');
        return;
    }
    await exports.transporter.sendMail({
        from,
        to,
        subject: template.subject,
        html: template.html,
    });
};
exports.sendSubscriptionActivatedEmail = sendSubscriptionActivatedEmail;
