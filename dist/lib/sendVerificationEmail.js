"use strict";
// 📁 src/utils/sendVerificationEmail.ts
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendVerificationEmail = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
const sendVerificationEmail = async (to, nombre, codigo) => {
    const transporter = nodemailer_1.default.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
    });
    const mailOptions = {
        from: `AAMY.ai <${process.env.EMAIL_USER}>`,
        to,
        subject: 'Verifica tu correo en AAMY.ai',
        html: `
      <h2>Hola ${nombre},</h2>
      <p>Gracias por registrarte. Tu código de verificación es:</p>
      <h1 style="color:#6366f1">${codigo}</h1>
      <p>Ingresa este código en la plataforma para activar tu cuenta.</p>
      <br>
      <p>Si no solicitaste este registro, puedes ignorar este mensaje.</p>
    `,
    };
    await transporter.sendMail(mailOptions);
};
exports.sendVerificationEmail = sendVerificationEmail;
