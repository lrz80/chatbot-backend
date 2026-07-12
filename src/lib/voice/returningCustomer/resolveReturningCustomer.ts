//src/lib/voice/returningCustomer/resolveReturningCustomer.ts
import pool from "../../db";
import { normalizeReturningCustomerPhone } from "./normalizePhone";
import {
  isValidReturningCustomerName,
  resolveReturningCustomerFirstName,
} from "./resolveFirstName";
import type {
  ResolveReturningCustomerResult,
  ReturningCustomerContext,
} from "./types";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function toPositiveInteger(value: unknown): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.floor(parsed);
}

function toContactId(value: unknown): number | null {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

export async function resolveReturningCustomer(params: {
  tenantId: string | null | undefined;
  callerPhone: string | null | undefined;
}): Promise<ResolveReturningCustomerResult> {
  const tenantId = clean(params.tenantId);

  if (!tenantId) {
    return {
      isReturningCustomer: false,
      reason: "TENANT_MISSING",
    };
  }

  const rawCallerPhone = clean(params.callerPhone);

  if (!rawCallerPhone) {
    return {
      isReturningCustomer: false,
      reason: "PHONE_MISSING",
    };
  }

  const normalizedPhone =
    normalizeReturningCustomerPhone(rawCallerPhone);

  if (!normalizedPhone) {
    return {
      isReturningCustomer: false,
      reason: "PHONE_INVALID",
    };
  }

  try {
    const result = await pool.query(
      `
      SELECT
        c.id,
        c.nombre,
        c.telefono,
        c.idioma,
        COALESCE(c.reservas, 0)::int AS reservas
      FROM contactos c
      WHERE c.tenant_id = $1
        AND c.telefono = $2
      LIMIT 1
      `,
      [tenantId, normalizedPhone]
    );

    const row = result.rows[0];

    if (!row) {
      return {
        isReturningCustomer: false,
        reason: "CONTACT_NOT_FOUND",
      };
    }

    const fullName = clean(row.nombre);

    if (!isValidReturningCustomerName(fullName)) {
      return {
        isReturningCustomer: false,
        reason: "CONTACT_NAME_INVALID",
      };
    }

    const firstName =
      resolveReturningCustomerFirstName(fullName);

    if (!firstName) {
      return {
        isReturningCustomer: false,
        reason: "CONTACT_NAME_INVALID",
      };
    }

    const language = clean(row.idioma);

    if (!language) {
      return {
        isReturningCustomer: false,
        reason: "CONTACT_LANGUAGE_MISSING",
      };
    }

    const reservations = toPositiveInteger(row.reservas);

    if (reservations <= 0) {
      return {
        isReturningCustomer: false,
        reason: "NO_RESERVATIONS",
      };
    }

    const contactId = toContactId(row.id);

    if (!contactId) {
      return {
        isReturningCustomer: false,
        reason: "CONTACT_NOT_FOUND",
      };
    }

    const storedPhone =
      normalizeReturningCustomerPhone(row.telefono) ||
      normalizedPhone;

    const returningCustomer: ReturningCustomerContext = {
      isReturningCustomer: true,
      contactId,
      firstName,
      fullName,
      phone: storedPhone,
      language,
      reservations,
      bookingSeed: {
        customer_name: fullName,
        customer_phone: storedPhone,
      },
    };

    return returningCustomer;
  } catch (error) {
    console.error(
      "[RETURNING_CUSTOMER][DATABASE_ERROR]",
      {
        tenantId,
        callerPhone: normalizedPhone,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }
    );

    return {
      isReturningCustomer: false,
      reason: "DATABASE_ERROR",
    };
  }
}