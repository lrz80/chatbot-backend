// src/routes/appointment-settings.ts

import { Router } from "express";

import pool from "../lib/db";

import {
  authenticateUser,
} from "../middleware/auth";

import {
  geocodeFieldServiceBaseAddress,
} from "../modules/field-operations/services/fieldServiceArea.service";

const router = Router();

function nullableNumber(
  value: unknown
): number | null {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

/**
 * GET /api/appointment-settings
 */
router.get(
  "/",
  authenticateUser,
  async (req: any, res) => {
    const tenantId =
      req.user?.tenant_id;

    if (!tenantId) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    try {
      const { rows } =
        await pool.query(
          `
          SELECT
            tenant_id,
            default_duration_min,
            buffer_min,
            timezone,
            enabled,
            min_lead_minutes,

            field_service_area_enabled,
            field_service_base_address,
            field_service_base_latitude,
            field_service_base_longitude,
            field_service_radius_miles

          FROM appointment_settings
          WHERE tenant_id = $1
          LIMIT 1
          `,
          [tenantId]
        );

      const defaults = {
        tenant_id: tenantId,
        default_duration_min: 30,
        buffer_min: 10,
        min_lead_minutes: 60,
        timezone:
          "America/New_York",
        enabled: true,

        field_service_area_enabled: false,
        field_service_base_address: null,
        field_service_base_latitude: null,
        field_service_base_longitude: null,
        field_service_radius_miles: null,
      };

      return res.json({
        ok: true,
        settings:
          rows[0] ?? defaults,
      });
    } catch (error: any) {
      console.error(
        "[appointment-settings][GET]",
        error
      );

      return res.status(500).json({
        ok: false,
        error: "Server error",
      });
    }
  }
);

/**
 * POST /api/appointment-settings
 */
router.post(
  "/",
  authenticateUser,
  async (req: any, res) => {
    const tenantId =
      req.user?.tenant_id;

    if (!tenantId) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized",
      });
    }

    const {
      default_duration_min,
      buffer_min,
      timezone,
      enabled,
      min_lead_minutes,

      field_service_area_enabled,
      field_service_base_address,
      field_service_radius_miles,
    } = req.body || {};

    const duration =
      Number(default_duration_min);

    const buffer =
      Number(buffer_min);

    const lead =
      Number(min_lead_minutes);

    if (
      !Number.isFinite(lead) ||
      lead < 0
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "min_lead_minutes debe ser un número mayor o igual a 0",
      });
    }

    if (
      !Number.isFinite(duration) ||
      duration < 5 ||
      duration > 480
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "default_duration_min inválido (5–480)",
      });
    }

    if (
      !Number.isFinite(buffer) ||
      buffer < 0 ||
      buffer > 120
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "buffer_min inválido (0–120)",
      });
    }

    if (
      !timezone ||
      typeof timezone !== "string" ||
      timezone.length < 3 ||
      timezone.length > 64
    ) {
      return res.status(400).json({
        ok: false,
        error: "timezone inválido",
      });
    }

    const enabledValue =
      typeof enabled === "boolean"
        ? enabled
        : true;

    const fieldServiceAreaEnabled =
      field_service_area_enabled === true;

    const fieldServiceBaseAddress =
      String(
        field_service_base_address ?? ""
      ).trim();

    const fieldServiceRadiusMiles =
      nullableNumber(
        field_service_radius_miles
      );

    if (
      fieldServiceAreaEnabled &&
      !fieldServiceBaseAddress
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "field_service_base_address requerido",
      });
    }

    if (
      fieldServiceAreaEnabled &&
      (
        fieldServiceRadiusMiles === null ||
        fieldServiceRadiusMiles <= 0
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "field_service_radius_miles debe ser mayor que 0",
      });
    }

    try {
      let normalizedBaseAddress:
        string | null = null;

      let baseLatitude:
        number | null = null;

      let baseLongitude:
        number | null = null;

      if (fieldServiceAreaEnabled) {
        const geocoding =
          await geocodeFieldServiceBaseAddress({
            address:
              fieldServiceBaseAddress,
            language: "en",
            region: "us",
          });

        normalizedBaseAddress =
          geocoding.formattedAddress;

        baseLatitude =
          geocoding.latitude;

        baseLongitude =
          geocoding.longitude;
      }

      const { rows } =
        await pool.query(
          `
          INSERT INTO appointment_settings (
            tenant_id,
            default_duration_min,
            buffer_min,
            min_lead_minutes,
            timezone,
            enabled,

            field_service_area_enabled,
            field_service_base_address,
            field_service_base_latitude,
            field_service_base_longitude,
            field_service_radius_miles,

            created_at,
            updated_at
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            now(), now()
          )

          ON CONFLICT (tenant_id)
          DO UPDATE SET
            default_duration_min =
              EXCLUDED.default_duration_min,

            buffer_min =
              EXCLUDED.buffer_min,

            min_lead_minutes =
              EXCLUDED.min_lead_minutes,

            timezone =
              EXCLUDED.timezone,

            enabled =
              EXCLUDED.enabled,

            field_service_area_enabled =
              EXCLUDED.field_service_area_enabled,

            field_service_base_address =
              EXCLUDED.field_service_base_address,

            field_service_base_latitude =
              EXCLUDED.field_service_base_latitude,

            field_service_base_longitude =
              EXCLUDED.field_service_base_longitude,

            field_service_radius_miles =
              EXCLUDED.field_service_radius_miles,

            updated_at = now()

          RETURNING
            tenant_id,
            default_duration_min,
            buffer_min,
            min_lead_minutes,
            timezone,
            enabled,

            field_service_area_enabled,
            field_service_base_address,
            field_service_base_latitude,
            field_service_base_longitude,
            field_service_radius_miles
          `,
          [
            tenantId,
            duration,
            buffer,
            lead,
            timezone,
            enabledValue,

            fieldServiceAreaEnabled,
            normalizedBaseAddress,
            baseLatitude,
            baseLongitude,
            fieldServiceAreaEnabled
              ? fieldServiceRadiusMiles
              : null,
          ]
        );

      return res.json({
        ok: true,
        settings: rows[0],
      });
    } catch (error: any) {
      console.error(
        "[appointment-settings][POST]",
        error
      );

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      if (
        message ===
          "FIELD_SERVICE_BASE_ADDRESS_NOT_FOUND"
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "No se pudo localizar la dirección base",
        });
      }

      return res.status(500).json({
        ok: false,
        error: "Server error",
      });
    }
  }
);

export default router;