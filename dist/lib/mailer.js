"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendRenewalSuccessEmail = exports.sendCancelationEmail = exports.sendVerificationEmail = exports.transporter = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const emailTemplates_1 = require("./emailTemplates"); // asegúrate que la ruta sea correcta
exports.transporter = nodemailer_1.default.createTransport({
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
// ✅ 2. Cancelación de membresía
const sendCancelationEmail = async (to, lang = 'es') => {
    const template = emailTemplates_1.emailTemplates.cancelation[lang]();
    await exports.transporter.sendMail({
        from,
        to,
        subject: template.subject,
        html: template.html,
    });
};
exports.sendCancelationEmail = sendCancelationEmail;
// ✅ 3. Renovación automática exitosa
const sendRenewalSuccessEmail = async (to, lang = 'es') => {
    const template = emailTemplates_1.emailTemplates.renewal[lang]();
    await exports.transporter.sendMail({
        from,
        to,
        subject: template.subject,
        html: template.html,
    });
};
exports.sendRenewalSuccessEmail = sendRenewalSuccessEmail;
