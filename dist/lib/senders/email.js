"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendEmail = sendEmail;
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
/**
 * Envía correos personalizados por tenant.
 * @param contenido Contenido del mensaje
 * @param contactos Lista de objetos con { email: string }
 * @param nombreNegocio Nombre visible del negocio (para el alias del correo)
 */
async function sendEmail(contenido, contactos, nombreNegocio) {
    for (const contacto of contactos) {
        if (!contacto.email)
            continue;
        try {
            await transporter.sendMail({
                from: `"${nombreNegocio}" <noreply@aamy.ai>`, // 👈 se ve como si lo envió el negocio
                to: contacto.email,
                subject: "📣 Nueva campaña de tu negocio",
                html: `<p>${contenido}</p>`,
            });
            console.log(`✅ Email enviado a ${contacto.email}`);
        }
        catch (err) {
            console.error(`❌ Error enviando a ${contacto.email}:`, err);
        }
    }
}
