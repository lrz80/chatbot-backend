"use strict";
// src/lib/senders/email-smtp.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendVerificationEmail = sendVerificationEmail;
exports.sendPasswordResetEmail = sendPasswordResetEmail;
exports.sendWelcomeEmail = sendWelcomeEmail;
const nodemailer_1 = __importDefault(require("nodemailer"));
const transporter = nodemailer_1.default.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});
// ✅ Verificación (envío de código)
async function sendVerificationEmail(to, code) {
    const html = `
    <h2>Verifica tu cuenta</h2>
    <p>Tu código de verificación es:</p>
    <h1>${code}</h1>
  `;
    await transporter.sendMail({
        from: '"Aamy.ai" <noreply@aamy.ai>',
        to,
        subject: "Verifica tu cuenta",
        html,
    });
}
// 🔐 Recuperación de contraseña
async function sendPasswordResetEmail(to, resetLink) {
    const html = `
    <h2>Recupera tu contraseña</h2>
    <p>Haz clic en el siguiente enlace para restablecer tu contraseña:</p>
    <a href="${resetLink}" target="_blank">${resetLink}</a>
    <p>Si no solicitaste esto, ignora este mensaje.</p>
  `;
    await transporter.sendMail({
        from: '"Aamy.ai" <noreply@aamy.ai>',
        to,
        subject: "Recuperación de contraseña",
        html,
    });
}
// 🙌 Bienvenida después de verificación
async function sendWelcomeEmail(to) {
    const html = `
    <h2>🎉 ¡Bienvenido a Aamy.ai!</h2>
    <p>Tu correo ha sido verificado exitosamente y ya puedes acceder a todas las funciones de la plataforma.</p>
    <p>Si necesitas ayuda, escríbenos o visita tu panel de control.</p>
    <br/>
    <p style="font-size: 12px; color: #888">Este correo fue generado automáticamente, no es necesario responder.</p>
  `;
    await transporter.sendMail({
        from: '"Aamy.ai" <noreply@aamy.ai>',
        to,
        subject: "🎉 Bienvenido a Aamy.ai",
        html,
    });
}
