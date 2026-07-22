// src/lib/emailTemplates.ts

export type EmailTemplateLanguage = "es" | "en" | "pt";

type EmailTemplate = {
  subject: string;
  html: string;
};

type LinkTemplateFactory = (
  link: string
) => EmailTemplate;

type TenantTemplateFactory = (
  tenantName: string
) => EmailTemplate;

type EmailTemplates = {
  verification: Record<
    EmailTemplateLanguage,
    LinkTemplateFactory
  >;
  cancelation: Record<
    EmailTemplateLanguage,
    TenantTemplateFactory
  >;
  renewal: Record<
    EmailTemplateLanguage,
    TenantTemplateFactory
  >;
  subscriptionActivated: Record<
    EmailTemplateLanguage,
    TenantTemplateFactory
  >;
};

const avatarUrl =
  "https://aamy.ai/avatar-amy.png";

const dashboardUrl =
  "https://www.aamy.ai/dashboard";

const upgradeUrl =
  "https://www.aamy.ai/upgrade";

export const emailTemplates: EmailTemplates = {
  verification: {
    es: (link: string) => ({
      subject: "Verifica tu cuenta en Aamy",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            ¡Bienvenido/a a Aamy!
          </h2>

          <p>
            Tu cuenta fue creada correctamente.
          </p>

          <p>
            Haz clic en el siguiente botón para verificar tu correo electrónico y activar tu cuenta:
          </p>

          <p style="margin:28px 0;">
            <a
              href="${link}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Verificar cuenta
            </a>
          </p>

          <p style="font-size:14px;color:#6b7280;">
            También puedes copiar y pegar este enlace en tu navegador:
          </p>

          <p style="font-size:13px;word-break:break-all;">
            <a href="${link}">${link}</a>
          </p>

          <p style="font-size:13px;color:#6b7280;margin-top:24px;">
            Este enlace expirará en <strong>24 horas</strong>.
          </p>
        </div>
      `,
    }),

    en: (link: string) => ({
      subject: "Verify your Aamy account",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Welcome to Aamy!
          </h2>

          <p>
            Your account was created successfully.
          </p>

          <p>
            Click the button below to verify your email address and activate your account:
          </p>

          <p style="margin:28px 0;">
            <a
              href="${link}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Verify account
            </a>
          </p>

          <p style="font-size:14px;color:#6b7280;">
            You can also copy and paste this link into your browser:
          </p>

          <p style="font-size:13px;word-break:break-all;">
            <a href="${link}">${link}</a>
          </p>

          <p style="font-size:13px;color:#6b7280;margin-top:24px;">
            This link will expire in <strong>24 hours</strong>.
          </p>
        </div>
      `,
    }),

    pt: (link: string) => ({
      subject: "Verifique sua conta na Aamy",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Bem-vindo(a) à Aamy!
          </h2>

          <p>
            Sua conta foi criada com sucesso.
          </p>

          <p>
            Clique no botão abaixo para verificar seu endereço de e-mail e ativar sua conta:
          </p>

          <p style="margin:28px 0;">
            <a
              href="${link}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Verificar conta
            </a>
          </p>

          <p style="font-size:14px;color:#6b7280;">
            Você também pode copiar e colar este link no navegador:
          </p>

          <p style="font-size:13px;word-break:break-all;">
            <a href="${link}">${link}</a>
          </p>

          <p style="font-size:13px;color:#6b7280;margin-top:24px;">
            Este link expirará em <strong>24 horas</strong>.
          </p>
        </div>
      `,
    }),
  },

  cancelation: {
    es: (tenantName: string) => ({
      subject: "Tu membresía ha sido cancelada",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Hola, ${tenantName}
          </h2>

          <p>
            Tu membresía en Aamy AI ha sido cancelada.
          </p>

          <p>
            Ya no tendrás acceso a las funciones incluidas en tu suscripción.
          </p>

          <p>
            Para reactivarla, visita tu panel:
          </p>

          <p style="margin:28px 0;">
            <a
              href="${upgradeUrl}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Reactivar membresía
            </a>
          </p>

          <p>
            Gracias por confiar en Aamy.
          </p>
        </div>
      `,
    }),

    en: (tenantName: string) => ({
      subject: "Your membership has been canceled",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Hello, ${tenantName}
          </h2>

          <p>
            Your Aamy AI membership has been canceled.
          </p>

          <p>
            You will no longer have access to the features included in your subscription.
          </p>

          <p>
            To reactivate it, visit your dashboard:
          </p>

          <p style="margin:28px 0;">
            <a
              href="${upgradeUrl}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Reactivate membership
            </a>
          </p>

          <p>
            Thank you for trusting Aamy.
          </p>
        </div>
      `,
    }),

    pt: (tenantName: string) => ({
      subject: "Sua assinatura foi cancelada",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Olá, ${tenantName}
          </h2>

          <p>
            Sua assinatura da Aamy AI foi cancelada.
          </p>

          <p>
            Você não terá mais acesso aos recursos incluídos na sua assinatura.
          </p>

          <p>
            Para reativá-la, acesse seu painel:
          </p>

          <p style="margin:28px 0;">
            <a
              href="${upgradeUrl}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Reativar assinatura
            </a>
          </p>

          <p>
            Obrigado por confiar na Aamy.
          </p>
        </div>
      `,
    }),
  },

  renewal: {
    es: (tenantName: string) => ({
      subject: "¡Tu membresía ha sido renovada!",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Hola, ${tenantName}
          </h2>

          <p>
            Tu membresía en Aamy AI fue renovada correctamente.
          </p>

          <p>
            Tu servicio continúa activo y listo para usar.
          </p>

          <p style="margin:28px 0;">
            <a
              href="${dashboardUrl}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Abrir panel
            </a>
          </p>

          <p>
            Gracias por continuar con Aamy.
          </p>
        </div>
      `,
    }),

    en: (tenantName: string) => ({
      subject: "Your membership has been renewed!",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Hello, ${tenantName}
          </h2>

          <p>
            Your Aamy AI membership was renewed successfully.
          </p>

          <p>
            Your service remains active and ready to use.
          </p>

          <p style="margin:28px 0;">
            <a
              href="${dashboardUrl}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Open dashboard
            </a>
          </p>

          <p>
            Thank you for continuing with Aamy.
          </p>
        </div>
      `,
    }),

    pt: (tenantName: string) => ({
      subject: "Sua assinatura foi renovada!",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Olá, ${tenantName}
          </h2>

          <p>
            Sua assinatura da Aamy AI foi renovada com sucesso.
          </p>

          <p>
            Seu serviço continua ativo e pronto para uso.
          </p>

          <p style="margin:28px 0;">
            <a
              href="${dashboardUrl}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Abrir painel
            </a>
          </p>

          <p>
            Obrigado por continuar com a Aamy.
          </p>
        </div>
      `,
    }),
  },

  subscriptionActivated: {
    es: (tenantName: string) => ({
      subject:
        "¡Tu suscripción en Aamy AI está activa!",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Hola, ${tenantName}
          </h2>

          <p>
            Tu suscripción en <strong>Aamy AI</strong> está activa.
          </p>

          <p>
            Tu plan está listo para usar.
          </p>

          <p style="margin:28px 0;">
            <a
              href="${dashboardUrl}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Abrir panel
            </a>
          </p>

          <p>
            Gracias por confiar en Aamy.
          </p>
        </div>
      `,
    }),

    en: (tenantName: string) => ({
      subject:
        "Your Aamy AI subscription is active!",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Hello, ${tenantName}
          </h2>

          <p>
            Your <strong>Aamy AI</strong> subscription is active.
          </p>

          <p>
            Your plan is ready to use.
          </p>

          <p style="margin:28px 0;">
            <a
              href="${dashboardUrl}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Open dashboard
            </a>
          </p>

          <p>
            Thank you for trusting Aamy.
          </p>
        </div>
      `,
    }),

    pt: (tenantName: string) => ({
      subject:
        "Sua assinatura da Aamy AI está ativa!",
      html: `
        <div style="text-align:center;font-family:Arial,sans-serif;color:#1f2937;line-height:1.6;padding:24px;">
          <img
            src="${avatarUrl}"
            alt="Aamy AI"
            style="width:100px;height:100px;border-radius:50%;object-fit:cover;"
          />

          <h2 style="margin-top:20px;">
            Olá, ${tenantName}
          </h2>

          <p>
            Sua assinatura da <strong>Aamy AI</strong> está ativa.
          </p>

          <p>
            Seu plano está pronto para uso.
          </p>

          <p style="margin:28px 0;">
            <a
              href="${dashboardUrl}"
              style="display:inline-block;padding:12px 22px;background:#6B46C1;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold;"
            >
              Abrir painel
            </a>
          </p>

          <p>
            Obrigado por confiar na Aamy.
          </p>
        </div>
      `,
    }),
  },
};