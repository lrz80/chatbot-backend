//src/lib/twilio/ensureTwilioSubaccountForTenant.ts

import twilio from "twilio";
import pool from "../db";

type EnsureTwilioSubaccountResult = {
  tenantId: string;
  twilioSubaccountSid: string;
  twilioSubaccountAuthToken: string;
};

const masterClient = twilio(
  process.env.TWILIO_MASTER_ACCOUNT_SID!,
  process.env.TWILIO_MASTER_AUTH_TOKEN!
);

export async function ensureTwilioSubaccountForTenant(
  tenantId: string
): Promise<EnsureTwilioSubaccountResult> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`twilio-subaccount:${tenantId}`]
    );

    const tenantResult = await client.query(
      `
      SELECT
        id,
        name,
        twilio_subaccount_sid,
        twilio_subaccount_auth_token
      FROM tenants
      WHERE id = $1
      FOR UPDATE
      `,
      [tenantId]
    );

    const tenant = tenantResult.rows[0];

    if (!tenant) {
      throw new Error("Tenant no encontrado");
    }

    if (tenant.twilio_subaccount_sid && tenant.twilio_subaccount_auth_token) {
      await client.query("COMMIT");

      return {
        tenantId: tenant.id,
        twilioSubaccountSid: tenant.twilio_subaccount_sid,
        twilioSubaccountAuthToken: tenant.twilio_subaccount_auth_token,
      };
    }

    const subaccount = await masterClient.api.accounts.create({
      friendlyName: `Tenant ${tenant.id} - ${tenant.name || ""}`.trim(),
    });

    const subaccountSid = subaccount.sid;
    const subaccountAuthToken =
      (subaccount as any).authToken || (subaccount as any).auth_token || null;

    if (!subaccountAuthToken) {
      throw new Error("Twilio no devolvió authToken al crear la subaccount");
    }

    await client.query(
      `
      UPDATE tenants
      SET
        twilio_subaccount_sid = $1,
        twilio_subaccount_auth_token = $2
      WHERE id = $3
      `,
      [subaccountSid, subaccountAuthToken, tenant.id]
    );

    await client.query("COMMIT");

    return {
      tenantId: tenant.id,
      twilioSubaccountSid: subaccountSid,
      twilioSubaccountAuthToken: subaccountAuthToken,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}