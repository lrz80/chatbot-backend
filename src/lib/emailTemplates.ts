// src/lib/emailTemplates.ts

export const emailTemplates = {
  verification: {
    es: (link: string) => ({
      subject: 'Verifica tu cuenta en AAMY',
      html: `
        <div style="text-align: center;">
          <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
          <h3>¡Bienvenido/a a AAMY!</h3>
          <p>Haz clic en el siguiente botón para activar tu cuenta:</p>
          <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#6B46C1;color:white;border-radius:6px;text-decoration:none">Verificar cuenta</a></p>
          <p>O copia y pega este enlace:<br /><code>${link}</code></p>
          <p>Este enlace expirará en <strong>10 minutos</strong>.</p>
        </div>
      `
    }),
    en: (link: string) => ({
      subject: 'Verify your account on AAMY',
      html: `
        <div style="text-align: center;">
          <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
          <h3>Welcome to AAMY!</h3>
          <p>Click the button below to activate your account:</p>
          <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#6B46C1;color:white;border-radius:6px;text-decoration:none">Verify Account</a></p>
          <p>Or copy and paste this link:<br /><code>${link}</code></p>
          <p>This link will expire in <strong>10 minutes</strong>.</p>
        </div>
      `
    }),
  },

  cancelation: {
    es: (tenantName: string) => ({
      subject: 'Tu membresía ha sido cancelada',
      html: `
        <div style="text-align: center;">
          <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
          <h3>Hola ${tenantName} 👋</h3>
          <p>Tu membresía en Aamy AI ha sido cancelada.</p>
          <p>Ya no tendrás acceso a las funciones del asistente.</p>
          <p>Si deseas reactivarla, visita tu <a href="https://www.aamy.ai/upgrade">panel de usuario</a>.</p>
          <p>Gracias por confiar en nosotros 💜</p>
        </div>
      `
    }),
    en: (tenantName: string) => ({
      subject: 'Your membership has been canceled',
      html: `
        <div style="text-align: center;">
          <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
          <h3>Hello ${tenantName} 👋</h3>
          <p>Your membership at Aamy AI has been canceled.</p>
          <p>You no longer have access to the assistant features.</p>
          <p>If this was a mistake or you want to reactivate it, visit your <a href="https://www.aamy.ai/upgrade">user panel</a>.</p>
          <p>Thank you for being part of Amy AI 💜</p>
        </div>
      `
    }),
  },

  renewal: {
    es: (tenantName: string) => ({
      subject: '¡Tu membresía ha sido renovada!',
      html: `
        <div style="text-align: center;">
          <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
          <h3>Hola ${tenantName} 👋</h3>
          <p>¡Gracias por seguir con Aamy AI!</p>
          <p>Tu membresía fue renovada con éxito.</p>
          <p>Accede a tu panel: <a href="https://www.aamy.ai/dashboard">aamy.ai/dashboard</a></p>
        </div>
      `
    }),
    en: (tenantName: string) => ({
      subject: 'Your membership has been renewed!',
      html: `
        <div style="text-align: center;">
          <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
          <h3>Hello ${tenantName} 👋</h3>
          <p>Thanks for staying with Aamy AI!</p>
          <p>Your membership was successfully renewed.</p>
          <p>Access your dashboard: <a href="https://www.aamy.ai/dashboard">aamy.ai/dashboard</a></p>
        </div>
      `
    }),
  },
    // ✅ Nueva plantilla subscriptionActivated
  subscriptionActivated: {
    es: (tenantName: string) => ({
      subject: '¡Tu suscripción en Aamy AI está activa!',
      html: `
        <div style="text-align: center;">
          <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
          <h3>Hola ${tenantName} 👋</h3>
          <p>¡Gracias por activar tu suscripción en <strong>Aamy AI</strong>!</p>
          <p>Tu plan está activo y listo para usar.</p>
          <p>Accede a tu panel: <a href="https://www.aamy.ai/dashboard">aamy.ai/dashboard</a></p>
          <p>Gracias por confiar en nosotros 💜</p>
        </div>
      `,
    }),
    en: (tenantName: string) => ({
      subject: 'Your subscription at Aamy AI is active!',
      html: `
        <div style="text-align: center;">
          <img src="https://aamy.ai/avatar-amy.png" alt="Amy AI Avatar" style="width: 100px; height: 100px; border-radius: 50%;" />
          <h3>Hello ${tenantName} 👋</h3>
          <p>Thanks for activating your subscription at <strong>Aamy AI</strong>!</p>
          <p>Your plan is now active and ready to use.</p>
          <p>Access your dashboard: <a href="https://www.aamy.ai/dashboard">aamy.ai/dashboard</a></p>
          <p>Thank you for trusting us 💜</p>
        </div>
      `,
    }),
  },
};
