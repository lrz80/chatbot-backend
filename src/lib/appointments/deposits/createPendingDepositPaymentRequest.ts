// src/lib/appointments/deposits/createPendingDepositPaymentRequest.ts
import pool from "../../db";
import { getSquareConnectionForTenant } from "../../integrations/square/getSquareConnectionForTenant";
import { createSquareDepositPaymentLink } from "../../integrations/square/createSquareDepositPaymentLink";

type CreatePendingDepositPaymentRequestArgs = {
  tenantId: string;
  channel: "voice" | "whatsapp" | "sms" | "email" | string;

  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;

  serviceName: string;
  startISO: string;
  endISO: string;
  timeZone: string;

  staffMemberId: string | null;
  staffMemberName: string | null;

  depositAmountCents: number;
  depositCurrency: string;
  depositPolicyText: string | null;

  squareLocationId: string;
  providerPayload: Record<string, unknown>;
  answersBySlot: Record<string, unknown>;

  idempotencyKey: string;
};

export type CreatePendingDepositPaymentRequestResult =
  | {
      ok: true;
      paymentRequestId: string;
      paymentLinkUrl: string;
      squarePaymentLinkId: string;
      squareOrderId: string | null;
    }
  | {
      ok: false;
      error: string;
      details?: unknown;
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export async function createPendingDepositPaymentRequest(
  args: CreatePendingDepositPaymentRequestArgs
): Promise<CreatePendingDepositPaymentRequestResult> {
  const connectionResult = await getSquareConnectionForTenant(args.tenantId);

  if (!connectionResult.ok) {
    return {
      ok: false,
      error: "SQUARE_CONNECTION_NOT_AVAILABLE",
      details: connectionResult,
    };
  }

  const existing = await pool.query(
    `
    SELECT
      id,
      square_payment_link_url,
      square_payment_link_id,
      square_order_id
    FROM appointment_payment_requests
    WHERE idempotency_key = $1
    LIMIT 1
    `,
    [args.idempotencyKey]
  );

  if (existing.rows[0]?.square_payment_link_url) {
    return {
      ok: true,
      paymentRequestId: clean(existing.rows[0].id),
      paymentLinkUrl: clean(existing.rows[0].square_payment_link_url),
      squarePaymentLinkId: clean(existing.rows[0].square_payment_link_id),
      squareOrderId: clean(existing.rows[0].square_order_id) || null,
    };
  }

  const inserted = await pool.query(
    `
    INSERT INTO appointment_payment_requests (
      tenant_id,
      channel,
      provider,
      status,
      customer_name,
      customer_phone,
      customer_email,
      service_name,
      start_time,
      end_time,
      timezone,
      staff_member_id,
      staff_member_name,
      deposit_amount_cents,
      deposit_currency,
      deposit_policy_text,
      provider_payload,
      answers_by_slot,
      idempotency_key,
      created_at,
      updated_at
    )
    VALUES (
      $1,
      $2,
      'square',
      'pending_payment',
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      $15::jsonb,
      $16::jsonb,
      $17,
      NOW(),
      NOW()
    )
    ON CONFLICT (idempotency_key)
    DO UPDATE SET
      updated_at = NOW()
    RETURNING id
    `,
    [
      args.tenantId,
      args.channel,
      args.customerName,
      args.customerPhone,
      args.customerEmail,
      args.serviceName,
      args.startISO,
      args.endISO,
      args.timeZone,
      args.staffMemberId,
      args.staffMemberName,
      args.depositAmountCents,
      args.depositCurrency,
      args.depositPolicyText,
      JSON.stringify(args.providerPayload || {}),
      JSON.stringify(args.answersBySlot || {}),
      args.idempotencyKey,
    ]
  );

  const paymentRequestId = clean(inserted.rows[0]?.id);

  if (!paymentRequestId) {
    return {
      ok: false,
      error: "PAYMENT_REQUEST_INSERT_FAILED",
    };
  }

  const paymentLink = await createSquareDepositPaymentLink({
    accessToken: connectionResult.connection.accessToken,
    environment: connectionResult.connection.environment,
    locationId: args.squareLocationId,
    idempotencyKey: args.idempotencyKey,
    serviceName: args.serviceName,
    customerName: args.customerName,
    customerPhone: args.customerPhone,
    customerEmail: args.customerEmail,
    amountCents: args.depositAmountCents,
    currency: args.depositCurrency,
    referenceId: paymentRequestId,
    redirectUrl: null,
  });

  if (!paymentLink.ok) {
    await pool.query(
      `
      UPDATE appointment_payment_requests
      SET
        status = 'payment_link_failed',
        error_reason = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [paymentRequestId, paymentLink.error]
    );

    return {
      ok: false,
      error: paymentLink.error,
      details: paymentLink,
    };
  }

  await pool.query(
    `
    UPDATE appointment_payment_requests
    SET
      square_payment_link_id = $2,
      square_payment_link_url = $3,
      square_order_id = $4,
      updated_at = NOW()
    WHERE id = $1
    `,
    [
      paymentRequestId,
      paymentLink.paymentLinkId,
      paymentLink.paymentLinkUrl,
      paymentLink.orderId,
    ]
  );

  return {
    ok: true,
    paymentRequestId,
    paymentLinkUrl: paymentLink.paymentLinkUrl,
    squarePaymentLinkId: paymentLink.paymentLinkId,
    squareOrderId: paymentLink.orderId,
  };
}