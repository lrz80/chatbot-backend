// src/lib/appointments/deposits/resolveBookingDepositPolicy.ts

export type BookingDepositPolicy = {
  required: boolean;
  amountCents: number | null;
  currency: string;
  paymentUrl: string | null;
  policyText: string | null;
};

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeAmountCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  const parsed = Number(cleanString(value));

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.round(parsed);
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;

  const normalized = cleanString(value).toLowerCase();

  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function getObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

export function resolveBookingDepositPolicyFromExternalMetadata(
  externalMetadata: Record<string, unknown>
): BookingDepositPolicy {
  const deposit = getObject(externalMetadata.deposit);

  const required = normalizeBoolean(deposit.required);

  const amountCents = normalizeAmountCents(
    deposit.amount_cents ?? deposit.amountCents
  );

  const currency = cleanString(deposit.currency || "USD").toUpperCase() || "USD";

  const paymentUrl = cleanString(
    deposit.payment_url ?? deposit.paymentUrl ?? deposit.checkout_url ?? deposit.checkoutUrl
  );

  const policyText = cleanString(
    deposit.policy_text ?? deposit.policyText ?? deposit.description
  );

  return {
    required,
    amountCents,
    currency,
    paymentUrl: paymentUrl || null,
    policyText: policyText || null,
  };
}