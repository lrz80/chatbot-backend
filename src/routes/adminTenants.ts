// src/routes/adminTenants.ts

import express, { Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";

import pool from "../lib/db";
import {
  sendVerificationEmail,
  EmailLanguage,
} from "../lib/mailer";
import {
  authenticateUser,
  AuthenticatedRequest,
} from "../middleware/auth";

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || "secret-key";
const isProduction = process.env.NODE_ENV === "production";

const adminTenantCookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction
    ? ("none" as const)
    : ("lax" as const),
  path: "/",
  maxAge: 1000 * 60 * 60 * 24 * 30,
};

function requireAdmin(
  req: AuthenticatedRequest,
  res: Response
): boolean {
  if (!req.user?.is_admin) {
    res.status(403).json({
      error: "Acceso exclusivo para administradores",
    });

    return false;
  }

  return true;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value: unknown): string {
  return cleanString(value).toLowerCase();
}

function normalizeBoolean(value: unknown): boolean {
  return (
    value === true ||
    value === "true" ||
    value === 1 ||
    value === "1"
  );
}

function normalizeVerificationLanguage(
  value: unknown
): EmailLanguage {
  if (value === "es" || value === "pt") {
    return value;
  }

  return "en";
}

function slugifyTenantName(
  businessName: string,
  tenantId: string
): string {
  const base = businessName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const safeBase = base || "business";
  const suffix = tenantId.split("-")[0];

  return `${safeBase}-${suffix}`;
}

/**
 * Lista todos los tenants disponibles.
 */
router.get(
  "/",
  authenticateUser,
  async (
    req: AuthenticatedRequest,
    res: Response
  ) => {
    if (!requireAdmin(req, res)) {
      return;
    }

    try {
      const result = await pool.query(
        `
          SELECT
            id,
            name,
            slug,
            logo_url,
            email_negocio,
            telefono_negocio,
            membresia_activa,
            membresia_vigencia,
            es_trial,
            created_at
          FROM tenants
          ORDER BY
            LOWER(COALESCE(name, '')) ASC,
            created_at DESC
        `
      );

      return res.status(200).json({
        tenants: result.rows,
        selected_tenant_id:
          req.user?.tenant_id,
        home_tenant_id:
          req.user?.home_tenant_id,
      });
    } catch (error) {
      console.error(
        "[ADMIN_TENANTS][LIST_FAILED]",
        error
      );

      return res.status(500).json({
        error:
          "No se pudieron cargar los negocios",
      });
    }
  }
);

/**
 * Crea un nuevo negocio y su usuario propietario.
 *
 * Solo puede ejecutarlo una cuenta con role = admin.
 */
router.post(
  "/",
  authenticateUser,
  async (
    req: AuthenticatedRequest,
    res: Response
  ) => {
    if (!requireAdmin(req, res)) {
      return;
    }

    const businessName = cleanString(
      req.body?.business_name
    );

    const nombre = cleanString(
      req.body?.nombre
    );

    const apellido = cleanString(
      req.body?.apellido
    );

    const email = normalizeEmail(
      req.body?.email
    );

    const telefono = cleanString(
      req.body?.telefono
    );

    const password = cleanString(
      req.body?.password
    );

    const timezone =
      cleanString(req.body?.timezone) ||
      "America/New_York";

    const smsOptIn = normalizeBoolean(
      req.body?.sms_opt_in
    );

    const verificationLanguage =
      normalizeVerificationLanguage(
        req.body?.verification_language
      );

    if (
      !businessName ||
      !nombre ||
      !apellido ||
      !email ||
      !telefono ||
      !password
    ) {
      return res.status(400).json({
        error:
          "Nombre del negocio, nombre, apellido, correo, teléfono y contraseña son requeridos",
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error:
          "La contraseña debe tener al menos 8 caracteres",
      });
    }

    try {
      const existingUserResult =
        await pool.query(
          `
            SELECT uid
            FROM users
            WHERE LOWER(email) = LOWER($1)
            LIMIT 1
          `,
          [email]
        );

      if (
        existingUserResult.rows.length > 0
      ) {
        return res.status(409).json({
          error:
            "El correo ya está registrado",
        });
      }

      const tenantId = uuidv4();
      const userId = uuidv4();

      const ownerName =
        `${nombre} ${apellido}`.trim();

      const slug = slugifyTenantName(
        businessName,
        tenantId
      );

      const passwordHash =
        await bcrypt.hash(password, 10);

      const verificationToken = jwt.sign(
        {
          uid: userId,
          email,
        },
        JWT_SECRET,
        {
          expiresIn: "24h",
        }
      );

      const backendUrl =
        cleanString(
          process.env.BACKEND_URL
        ) ||
        "https://api.aamy.ai";

      const verificationLink =
        `${backendUrl}/api/auth/verify-email` +
        `?token=${encodeURIComponent(
          verificationToken
        )}`;

      const client =
        await pool.connect();

      try {
        await client.query("BEGIN");

        await client.query(
          `
            INSERT INTO tenants (
              id,
              name,
              slug,
              email_negocio,
              telefono_negocio,
              created_at,
              membresia_activa,
              membresia_vigencia,
              es_trial,
              settings
            )
            VALUES (
              $1::uuid,
              $2::text,
              $3::text,
              $4::text,
              $5::text,
              NOW(),
              false,
              NULL,
              false,
              jsonb_build_object(
                'timezone',
                $6::text
              )
            )
          `,
          [
            tenantId,
            businessName,
            slug,
            email,
            telefono,
            timezone,
          ]
        );

        await client.query(
          `
            INSERT INTO users (
              uid,
              tenant_id,
              email,
              password,
              role,
              owner_name,
              telefono,
              created_at,
              verificado,
              token_verificacion,
              sms_opt_in,
              sms_opt_in_at,
              sms_opt_in_source,
              sms_phone_number
            )
            VALUES (
              $1::uuid,
              $2::uuid,
              $3::text,
              $4::text,
              'business_owner'::text,
              $5::text,
              $6::text,
              NOW(),
              false,
              $7::text,
              $8::boolean,
              CASE
                WHEN $8::boolean = true
                THEN NOW()
                ELSE NULL
              END,
              CASE
                WHEN $8::boolean = true
                THEN 'admin_created'
                ELSE NULL
              END,
              CASE
                WHEN $8::boolean = true
                THEN $9::text
                ELSE NULL
              END
            )
          `,
          [
            userId,
            tenantId,
            email,
            passwordHash,
            ownerName,
            telefono,
            verificationToken,
            smsOptIn,
            telefono,
          ]
        );

        await client.query("COMMIT");
      } catch (databaseError) {
        await client.query("ROLLBACK");
        throw databaseError;
      } finally {
        client.release();
      }

      let verificationEmailSent = false;

      try {
        await sendVerificationEmail(
          email,
          verificationLink,
          verificationLanguage
        );

        verificationEmailSent = true;
      } catch (emailError) {
        console.error(
          "[ADMIN_TENANTS][VERIFICATION_EMAIL_FAILED]",
          {
            tenantId,
            userId,
            email,
            error: emailError,
          }
        );
      }

      console.log(
        "[ADMIN_TENANTS][TENANT_CREATED]",
        {
          tenantId,
          userId,
          businessName,
          ownerName,
          email,
          createdBy:
            req.user?.email,
          verificationEmailSent,
        }
      );

      return res.status(201).json({
        success: true,
        tenant: {
          id: tenantId,
          name: businessName,
          slug,
          timezone,
        },
        owner: {
          uid: userId,
          tenant_id: tenantId,
          name: ownerName,
          email,
          telefono,
          role: "business_owner",
          verified: false,
        },
        verification_email_sent:
          verificationEmailSent,
      });
    } catch (error: any) {
      console.error(
        "[ADMIN_TENANTS][CREATE_FAILED]",
        {
          message: error?.message,
          code: error?.code,
          detail: error?.detail,
          constraint:
            error?.constraint,
          stack: error?.stack,
        }
      );

      if (error?.code === "23505") {
        return res.status(409).json({
          error:
            "Ya existe un negocio o usuario con esos datos",
        });
      }

      return res.status(500).json({
        error:
          "No se pudo crear el negocio",
      });
    }
  }
);

/**
 * Selecciona el tenant que el administrador desea manejar.
 */
router.post(
  "/select",
  authenticateUser,
  async (
    req: AuthenticatedRequest,
    res: Response
  ) => {
    if (!requireAdmin(req, res)) {
      return;
    }

    try {
      const tenantId = cleanString(
        req.body?.tenant_id
      );

      if (!tenantId) {
        return res.status(400).json({
          error: "tenant_id es requerido",
        });
      }

      const tenantResult =
        await pool.query(
          `
            SELECT
              id,
              name,
              logo_url
            FROM tenants
            WHERE id = $1::uuid
            LIMIT 1
          `,
          [tenantId]
        );

      const tenant =
        tenantResult.rows[0];

      if (!tenant) {
        return res.status(404).json({
          error:
            "Negocio no encontrado",
        });
      }

      res.cookie(
        "admin_tenant_id",
        tenant.id,
        adminTenantCookieOptions
      );

      return res.status(200).json({
        ok: true,
        tenant,
      });
    } catch (error: any) {
      console.error(
        "[ADMIN_TENANTS][SELECT_FAILED]",
        {
          message: error?.message,
          code: error?.code,
          stack: error?.stack,
        }
      );

      return res.status(500).json({
        error:
          "No se pudo seleccionar el negocio",
      });
    }
  }
);

/**
 * Regresa al tenant propio de la cuenta administrativa.
 */
router.delete(
  "/select",
  authenticateUser,
  async (
    req: AuthenticatedRequest,
    res: Response
  ) => {
    if (!requireAdmin(req, res)) {
      return;
    }

    res.clearCookie(
      "admin_tenant_id",
      {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction
          ? "none"
          : "lax",
        path: "/",
      }
    );

    return res.status(200).json({
      ok: true,
      tenant_id:
        req.user?.home_tenant_id,
    });
  }
);

export default router;