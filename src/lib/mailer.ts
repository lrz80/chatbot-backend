import nodemailer from 'nodemailer';

export const transporter = nodemailer.createTransport({
  host: 'mail.privateemail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASS,
  },
});

// ✅ 1. Verificación de cuenta
export const sendVerificationEmail = async (to: string, verificationLink: string) => {
  await transporter.sendMail({
    from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
    to,
    subject: 'Verifica tu cuenta en AAMY',
    html: `
      <h3>¡Bienvenido/a a AAMY!</h3>
      <p>Haz clic en el siguiente botón o enlace para activar tu cuenta:</p>
      <p><a href="${verificationLink}" style="display:inline-block;padding:12px 20px;background:#6B46C1;color:white;border-radius:6px;text-decoration:none">Verificar cuenta</a></p>
      <p>O copia y pega este link en tu navegador:<br /><code>${verificationLink}</code></p>
      <p>Este enlace expirará en <strong>10 minutos</strong>.</p>
    `,
  });
};

// ✅ 2. Cancelación de membresía
export const sendCancelationEmail = async (to: string) => {
  await transporter.sendMail({
    from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
    to,
    subject: 'Tu membresía ha sido cancelada',
    html: `
      <h3>Tu membresía en Amy AI ha sido cancelada</h3>
      <p>Hola,</p>
      <p>Hemos cancelado tu membresía en <strong>Amy AI</strong>. Ya no tendrás acceso a las funciones del asistente.</p>
      <p>Si deseas reactivarla, puedes hacerlo desde tu <a href="https://www.aamy.ai/upgrade">panel de usuario</a>.</p>
      <br />
      <p>Gracias por haber sido parte de Amy AI 💜</p>
    `,
  });
};

// ✅ 3. Renovación automática exitosa
export const sendRenewalSuccessEmail = async (to: string) => {
  await transporter.sendMail({
    from: `"Amy AI" <${process.env.EMAIL_FROM}>`,
    to,
    subject: '¡Tu membresía ha sido renovada con éxito!',
    html: `
      <h3>¡Gracias por seguir con Amy AI!</h3>
      <p>Tu membresía ha sido renovada correctamente.</p>
      <p>Continúa disfrutando de todas las funciones premium del asistente.</p>
      <p>Accede a tu panel aquí: <a href="https://www.aamy.ai/dashboard">www.aamy.ai/dashboard</a></p>
    `,
  });
};
