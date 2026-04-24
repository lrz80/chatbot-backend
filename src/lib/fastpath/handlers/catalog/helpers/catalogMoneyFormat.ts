//src/lib/fastpath/handlers/catalog/helpers/catalogMoneyFormat.ts
export function normalizeCurrency(value: unknown): string {
  const currency = String(value || "").trim().toUpperCase();
  return currency || "USD";
}

export function normalizeLocale(value: unknown): string {
  const raw = String(value || "").trim();

  if (!raw) {
    return "en";
  }

  return raw.replace("_", "-");
}

export function toNullableMoneyNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatMoneyAmount(input: {
  amount: number | null;
  currency: string | null;
  locale: string;
}): string {
  const amount = input.amount;

  if (amount === null || !Number.isFinite(amount)) {
    return "";
  }

  const currency = normalizeCurrency(input.currency);
  const locale = normalizeLocale(input.locale);

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatMoneyRange(input: {
  min: number | null;
  max: number | null;
  currency: string | null;
  locale: string;
}): string {
  const { min, max, currency, locale } = input;

  const hasMin = min !== null && Number.isFinite(min);
  const hasMax = max !== null && Number.isFinite(max);

  if (hasMin && hasMax) {
    if (Number(min) === Number(max)) {
      return formatMoneyAmount({
        amount: Number(min),
        currency,
        locale,
      });
    }

    const minText = formatMoneyAmount({
      amount: Number(min),
      currency,
      locale,
    });

    const maxText = formatMoneyAmount({
      amount: Number(max),
      currency,
      locale,
    });

    return [minText, maxText].filter(Boolean).join(" - ");
  }

  if (hasMin) {
    return formatMoneyAmount({
      amount: Number(min),
      currency,
      locale,
    });
  }

  if (hasMax) {
    return formatMoneyAmount({
      amount: Number(max),
      currency,
      locale,
    });
  }

  return "";
}