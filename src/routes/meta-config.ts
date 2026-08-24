// src/routes/meta-config.ts

import { Router, Response } from "express";
import pool from "../lib/db";
import axios from "axios";
import { authenticateUser } from "../middleware/auth";

const router = Router();

// GET: obtener configuración Meta del tenant activo/autorizado
router.get(
  "/",
  authenticateUser,
  async (req: any, res: Response) => {
    try {
      const tenantId = req.user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({
          error: "Tenant no encontrado o no asignado",
        });
      }

      const configRes = await pool.query(
        `
          SELECT
            funciones_asistente,
            info_clave,
            prompt_meta AS prompt,
            bienvenida_meta AS bienvenida,
            idioma
          FROM meta_configs
          WHERE tenant_id = $1
          LIMIT 1
        `,
        [tenantId]
      );

      const config = configRes.rows[0] || {};

      const tenantRes = await pool.query(
        `
          SELECT
            name,
            categoria,
            facebook_page_id,
            facebook_page_name,
            instagram_page_id,
            instagram_page_name,
            membresia_activa,
            facebook_access_token
          FROM tenants
          WHERE id = $1
          LIMIT 1
        `,
        [tenantId]
      );

      const tenant = tenantRes.rows[0];

      if (!tenant) {
        return res.status(404).json({
          error: "Tenant no encontrado",
        });
      }

      const hasPageId = Boolean(
        tenant.facebook_page_id ||
        tenant.instagram_page_id
      );

      let needsReconnect = false;

      if (tenant.facebook_access_token) {
        try {
          await axios.get(
            "https://graph.facebook.com/v19.0/me",
            {
              params: {
                access_token: tenant.facebook_access_token,
              },
              timeout: 6000,
            }
          );
        } catch (e: any) {
          const code = e?.response?.data?.error?.code;

          if (code === 190) {
            needsReconnect = true;
          } else {
            console.warn(
              "⚠️ Chequeo token FB falló (no 190):",
              e?.response?.data || e?.message
            );
          }
        }
      }

      return res.status(200).json({
        ...config,

        tenant_id: tenantId,
        name: tenant.name ?? "",
        categoria: tenant.categoria ?? "",

        facebook_page_id:
          tenant.facebook_page_id ?? null,

        facebook_page_name:
          tenant.facebook_page_name ?? null,

        instagram_page_id:
          tenant.instagram_page_id ?? null,

        instagram_page_name:
          tenant.instagram_page_name ?? null,

        membresia_activa:
          Boolean(tenant.membresia_activa),

        connected: hasPageId,

        needs_reconnect: needsReconnect,
      });
    } catch (err) {
      console.error(
        "❌ Error en GET /api/meta-config:",
        err
      );

      return res.status(500).json({
        error: "Error interno del servidor",
      });
    }
  }
);

// PUT: guardar configuración Meta del tenant activo/autorizado
router.put(
  "/",
  authenticateUser,
  async (req: any, res: Response) => {
    try {
      const tenantId = req.user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({
          error: "Tenant no encontrado o no asignado",
        });
      }

      const {
        funciones_asistente,
        info_clave,
        prompt_meta,
        bienvenida_meta,
        idioma,
      } = req.body;

      await pool.query(
        `
          INSERT INTO meta_configs (
            tenant_id,
            funciones_asistente,
            info_clave,
            prompt_meta,
            bienvenida_meta,
            idioma,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            NOW(),
            NOW()
          )
          ON CONFLICT (tenant_id)
          DO UPDATE SET
            funciones_asistente =
              EXCLUDED.funciones_asistente,

            info_clave =
              EXCLUDED.info_clave,

            prompt_meta =
              EXCLUDED.prompt_meta,

            bienvenida_meta =
              EXCLUDED.bienvenida_meta,

            idioma =
              EXCLUDED.idioma,

            updated_at = NOW()
        `,
        [
          tenantId,
          funciones_asistente,
          info_clave,
          prompt_meta,
          bienvenida_meta,
          idioma,
        ]
      );

      console.log(
        "📝 PUT /api/meta-config:",
        {
          tenantId,
          canal: "meta",
        }
      );

      return res.status(200).json({
        message:
          "Configuración Meta guardada correctamente",
      });
    } catch (err) {
      console.error(
        "❌ Error en PUT /api/meta-config:",
        err
      );

      return res.status(500).json({
        error: "Error interno del servidor",
      });
    }
  }
);

// POST: desconectar Facebook / Instagram del tenant activo
router.post(
  "/disconnect",
  authenticateUser,
  async (req: any, res: Response) => {
    try {
      const tenantId = req.user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({
          error: "Tenant no encontrado o no asignado",
        });
      }

      const tenantRes = await pool.query(
        `
          SELECT id
          FROM tenants
          WHERE id = $1
          LIMIT 1
        `,
        [tenantId]
      );

      if (!tenantRes.rows[0]) {
        return res.status(404).json({
          error: "Tenant no encontrado",
        });
      }

      await pool.query(
        `
          UPDATE tenants
          SET
            facebook_page_id = NULL,
            facebook_page_name = NULL,
            instagram_page_id = NULL,
            instagram_page_name = NULL,
            instagram_business_account_id = NULL,
            facebook_access_token = NULL,
            updated_at = NOW()
          WHERE id = $1
        `,
        [tenantId]
      );

      return res.status(200).json({
        message:
          "Cuentas desconectadas correctamente",
      });
    } catch (err) {
      console.error(
        "❌ Error en POST /api/meta-config/disconnect:",
        err
      );

      return res.status(500).json({
        error: "Error interno del servidor",
      });
    }
  }
);

export default router;