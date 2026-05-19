//src/lib/integrations/square/isSquareBookingCustomerActionRequired.ts
type SquareErrorLike = {
  category?: string;
  code?: string;
  detail?: string;
};

function extractSquareErrors(input: unknown): SquareErrorLike[] {
  if (!input || typeof input !== "object") return [];

  const value = input as Record<string, any>;

  if (Array.isArray(value.errors)) return value.errors;
  if (Array.isArray(value.squareErrors)) return value.squareErrors;
  if (Array.isArray(value.details?.errors)) return value.details.errors;
  if (Array.isArray(value.data?.errors)) return value.data.errors;

  return [];
}

export function isSquareBookingCustomerActionRequired(input: unknown): boolean {
  const errors = extractSquareErrors(input);

  return errors.some((error) => {
    const code = String(error.code || "").toUpperCase();
    const detail = String(error.detail || "").toLowerCase();

    return (
      code.includes("PAYMENT") ||
      code.includes("CARD") ||
      detail.includes("payment") ||
      detail.includes("prepayment") ||
      detail.includes("deposit") ||
      detail.includes("card on file") ||
      detail.includes("requires payment") ||
      detail.includes("requires prepayment") ||
      detail.includes("payment required") ||
      detail.includes("booking policy")
    );
  });
}