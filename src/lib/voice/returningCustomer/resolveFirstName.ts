//src/lib/voice/returningCustomer/resolveFirstName.ts
function clean(value: unknown): string {
  return String(value ?? "").trim();
}

const INVALID_CONTACT_NAMES = new Set([
  "sin nombre",
  "unknown",
  "customer",
  "cliente",
  "caller",
  "no name",
]);

export function isValidReturningCustomerName(
  value: unknown
): boolean {
  const fullName = clean(value);

  if (!fullName) {
    return false;
  }

  return !INVALID_CONTACT_NAMES.has(
    fullName.toLocaleLowerCase()
  );
}

export function resolveReturningCustomerFirstName(
  value: unknown
): string {
  const fullName = clean(value);

  if (!isValidReturningCustomerName(fullName)) {
    return "";
  }

  return clean(fullName.split(/\s+/)[0]);
}