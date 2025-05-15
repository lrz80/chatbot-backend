// src/lib/senders/email-smtp.ts

import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ✅ Verificación (envío de código)
export async function sendVerificationEmail(to: string, code: string) {
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
export async function sendPasswordResetEmail(to: string, resetLink: string) {
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
export async function sendWelcomeEmail(to: string) {
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
