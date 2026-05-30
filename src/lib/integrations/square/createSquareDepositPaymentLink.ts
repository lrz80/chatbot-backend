// src/lib/integrations/square/createSquareDepositPaymentLink.ts
import crypto from "crypto";

type SquareEnvironment = "sandbox" | "production";

type CreateSquareDepositPaymentLinkArgs = {
  accessToken: string;
  environment: SquareEnvironment;
  locationId: string;
  idempotencyKey: string;

  serviceName: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;

  amountCents: number;
  currency: string;

  referenceId: string;
  redirectUrl?: string | null;
};

export type CreateSquareDepositPaymentLinkResult =
  | {
      ok: true;
      paymentLinkId: string;
      paymentLinkUrl: string;
      orderId: string | null;
    }
  | {
      ok: false;
      error: string;
      status?: number;
      details?: unknown;
    };

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function getSquareBaseUrl(environment: SquareEnvironment): string {
  return environment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
}

function stableIdempotencyKey(value: string): string {
  const hash = crypto.createHash("sha256").update(value).digest("hex");
  return hash.slice(0, 32);
}

export async function createSquareDepositPaymentLink(
  args: CreateSquareDepositPaymentLinkArgs
): Promise<CreateSquareDepositPaymentLinkResult> {
  const amountCents = Number(args.amountCents);

  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return {
      ok: false,
      error: "INVALID_DEPOSIT_AMOUNT",
      status: 400,
    };
  }

  const locationId = clean(args.locationId);

  if (!locationId) {
    return {
      ok: false,
      error: "MISSING_SQUARE_LOCATION_ID",
      status: 400,
    };
  }

  const currency = clean(args.currency || "USD").toUpperCase() || "USD";
  const baseUrl = getSquareBaseUrl(args.environment);

  const body = {
    idempotency_key: stableIdempotencyKey(args.idempotencyKey),
    quick_pay: {
      name: `Deposit - ${clean(args.serviceName)}`,
      price_money: {
        amount: amountCents,
        currency,
      },
      location_id: locationId,
    },
    checkout_options: {
      redirect_url: clean(args.redirectUrl) || undefined,
    },
    pre_populated_data: {
      buyer_email: clean(args.customerEmail) || undefined,
      buyer_phone_number: clean(args.customerPhone) || undefined,
    },
    payment_note: clean(args.referenceId),
  };

  const response = await fetch(`${baseUrl}/v2/online-checkout/payment-links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": process.env.SQUARE_API_VERSION || "2026-01-22",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    return {
      ok: false,
      error: "SQUARE_PAYMENT_LINK_CREATE_FAILED",
      status: response.status,
      details: data,
    };
  }

  const paymentLink = data?.payment_link;

  const paymentLinkId = clean(paymentLink?.id);
  const paymentLinkUrl = clean(paymentLink?.url);
  const orderId = clean(paymentLink?.order_id) || null;

  if (!paymentLinkId || !paymentLinkUrl) {
    return {
      ok: false,
      error: "SQUARE_PAYMENT_LINK_RESPONSE_INCOMPLETE",
      status: 502,
      details: data,
    };
  }

  return {
    ok: true,
    paymentLinkId,
    paymentLinkUrl,
    orderId,
  };
}