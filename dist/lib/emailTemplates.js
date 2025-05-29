"use strict";
// src/lib/emailTemplates.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailTemplates = void 0;
exports.emailTemplates = {
    verification: {
        es: (link) => ({
            subject: 'Verifica tu cuenta en AAMY',
            html: `
        <h3>¡Bienvenido/a a AAMY!</h3>
        <p>Haz clic en el siguiente botón para activar tu cuenta:</p>
        <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#6B46C1;color:white;border-radius:6px;text-decoration:none">Verificar cuenta</a></p>
        <p>O copia y pega este enlace:<br /><code>${link}</code></p>
        <p>Este enlace expirará en <strong>10 minutos</strong>.</p>
      `
        }),
        en: (link) => ({
            subject: 'Verify your account on AAMY',
            html: `
        <h3>Welcome to AAMY!</h3>
        <p>Click the button below to activate your account:</p>
        <p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#6B46C1;color:white;border-radius:6px;text-decoration:none">Verify Account</a></p>
        <p>Or copy and paste this link:<br /><code>${link}</code></p>
        <p>This link will expire in <strong>10 minutes</strong>.</p>
      `
        }),
    },
    cancelation: {
        es: () => ({
            subject: 'Tu membresía ha sido cancelada',
            html: `
        <h3>Tu membresía en Amy AI ha sido cancelada</h3>
        <p>Ya no tendrás acceso a las funciones del asistente.</p>
        <p>Si deseas reactivarla, visita tu <a href="https://www.aamy.ai/upgrade">panel de usuario</a>.</p>
        <p>Gracias por confiar en nosotros 💜</p>
      `
        }),
        en: () => ({
            subject: 'Your membership has been canceled',
            html: `
        <h3>Your membership at Amy AI has been canceled</h3>
        <p>You no longer have access to the assistant features.</p>
        <p>If this was a mistake or you want to reactivate it, visit your <a href="https://www.aamy.ai/upgrade">user panel</a>.</p>
        <p>Thank you for being part of Amy AI 💜</p>
      `
        }),
    },
    renewal: {
        es: () => ({
            subject: '¡Tu membresía ha sido renovada!',
            html: `
        <h3>¡Gracias por seguir con Amy AI!</h3>
        <p>Tu membresía fue renovada con éxito.</p>
        <p>Accede a tu panel: <a href="https://www.aamy.ai/dashboard">aamy.ai/dashboard</a></p>
      `
        }),
        en: () => ({
            subject: 'Your membership has been renewed!',
            html: `
        <h3>Thanks for staying with Amy AI!</h3>
        <p>Your membership was successfully renewed.</p>
        <p>Access your dashboard: <a href="https://www.aamy.ai/dashboard">aamy.ai/dashboard</a></p>
      `
        }),
    },
};
