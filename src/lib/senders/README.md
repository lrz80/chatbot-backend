# 📬 Guía de Envío de Emails en Aamy.ai

Esta carpeta contiene los módulos encargados de enviar correos electrónicos desde la plataforma, organizados por propósito y tecnología.

---

## ✉️ Estructura de envío

| Archivo                         | Propósito                                             | Tecnología     |
|-------------------------------|-------------------------------------------------------|----------------|
| `email-smtp.ts`               | Correos internos: verificación, recuperación, bienvenida | Nodemailer (SMTP) |
| `email-sendgrid.ts`           | Campañas de marketing masivas por Email              | SendGrid API   |
| `../utils/email-html.ts`      | Generación del HTML visual usado en campañas         | HTML string    |

---

## 📌 Descripción de archivos

### `email-smtp.ts`

Usado para correos críticos del sistema, como:

- ✅ Verificación de cuenta
- 🔐 Recuperación de contraseña
- 🎉 Correo de bienvenida

**Funciones disponibles:**

```ts
sendVerificationEmail(to: string, code: string)
sendPasswordResetEmail(to: string, resetLink: string)
sendWelcomeEmail(to: string)
