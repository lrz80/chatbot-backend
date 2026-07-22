// src/routes/usage.ts

import { Router, Response } from "express";
import pool from "../lib/db";
import { cycleStartForNow } from "../utils/billingCycle";
import {
  authenticateUser,
  AuthenticatedRequest,
} from "../middleware/auth";

const router = Router();

router.get(
  "/",
  authenticateUser,
  async (
    req: AuthenticatedRequest,
    res: Response
  ) => {
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: "Tenant no disponible",
      });
    }

    try {
      const tenantRes = await pool.query(
        `
          SELECT
            membresia_inicio,
            created_at,
            plan,
            plan_limits
          FROM tenants
          WHERE id = $1
        `,
        [tenantId]
      );

      const tenantRow = tenantRes.rows[0];

      if (!tenantRow) {
        return res.status(404).json({
          error: "Tenant no encontrado",
        });
      }

      const membresiaInicio =
        tenantRow.membresia_inicio ??
        tenantRow.created_at ??
        new Date();

      const tenantPlan =
        tenantRow.plan || "starter";

      const limites =
        tenantRow.plan_limits || {};

      const ciclo =
        cycleStartForNow(membresiaInicio);

      const cicloEnd = new Date(ciclo);
      cicloEnd.setMonth(
        cicloEnd.getMonth() + 1
      );

      const [
        usoRes,
        campUsageRes,
        creditosRes,
      ] = await Promise.all([
        pool.query(
          `
            SELECT
              CASE
                WHEN canal IN (
                  'facebook',
                  'instagram'
                )
                THEN 'meta'
                ELSE canal
              END AS canal,
              COALESCE(
                SUM(usados),
                0
              )::int AS usados,
              COALESCE(
                MAX(limite),
                0
              )::int AS limite
            FROM uso_mensual
            WHERE tenant_id = $1
              AND mes = $2::date
            GROUP BY 1
          `,
          [tenantId, ciclo]
        ),

        pool.query(
          `
            SELECT
              canal,
              COALESCE(
                SUM(cantidad),
                0
              )::int AS usados
            FROM campaign_usage
            WHERE tenant_id = $1
              AND fecha_envio >= $2
              AND fecha_envio < $3
            GROUP BY canal
          `,
          [
            tenantId,
            ciclo,
            cicloEnd,
          ]
        ),

        pool.query(
          `
            SELECT
              canal,
              COALESCE(
                SUM(cantidad),
                0
              )::int AS total
            FROM creditos_comprados
            WHERE tenant_id = $1
              AND fecha_vencimiento >= NOW()
            GROUP BY canal
          `,
          [tenantId]
        ),
      ]);

      const campaignUsageMap = new Map<
        string,
        number
      >(
        campUsageRes.rows.map((row) => [
          String(row.canal),
          Number(row.usados) || 0,
        ])
      );

      const creditosMap = new Map<
        string,
        number
      >(
        creditosRes.rows.map((row) => [
          String(row.canal),
          Number(row.total) || 0,
        ])
      );

      const usosMap = new Map<
        string,
        number
      >(
        usoRes.rows.map((row) => [
          String(row.canal),
          Number(row.usados) || 0,
        ])
      );

      const limitesDbMap = new Map<
        string,
        number
      >(
        usoRes.rows.map((row) => [
          String(row.canal),
          Number(row.limite) || 0,
        ])
      );

      const canales = new Set<string>([
        ...Object.keys(limites),
        ...Array.from(usosMap.keys()),
        ...Array.from(
          limitesDbMap.keys()
        ),
        ...Array.from(
          creditosMap.keys()
        ),
        ...Array.from(
          campaignUsageMap.keys()
        ),
      ]);

      const usos = Array.from(
        canales
      ).map((canal) => {
        const usados =
          canal === "sms"
            ? campaignUsageMap.get(
                "sms"
              ) ?? 0
            : usosMap.get(canal) ?? 0;

        const creditosExtras =
          creditosMap.get(canal) ?? 0;

        const limiteBase =
          Number(
            (
              limites as Record<
                string,
                unknown
              >
            )[canal]
          ) || 0;

        const totalLimite =
          limiteBase + creditosExtras;

        const porcentaje =
          totalLimite > 0
            ? (usados / totalLimite) *
              100
            : 0;

        let notificar:
          | "aviso"
          | "limite"
          | null = null;

        if (totalLimite > 0) {
          if (porcentaje >= 100) {
            notificar = "limite";
          } else if (
            porcentaje >= 80
          ) {
            notificar = "aviso";
          }
        }

        return {
          canal,
          usados,
          limite: totalLimite,
          limite_base: limiteBase,
          creditos_extras:
            creditosExtras,
          porcentaje,
          notificar,
        };
      });

      return res.status(200).json({
        usos,
        plan: tenantPlan,
        ciclo,
      });
    } catch (error) {
      console.error(
        "❌ Error en /usage:",
        {
          tenantId,
          error,
        }
      );

      return res.status(500).json({
        error:
          "Error interno del servidor",
      });
    }
  }
);

export default router;