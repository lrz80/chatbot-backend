// 📁 src/utils/sendVerificationEmail.ts

import nodemailer from 'nodemailer';

export const sendVerificationEmail = async (
  to: string,
  nombre: string,
  codigo: string
) => {
  const transporter = nodemailer.createTransport({
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
