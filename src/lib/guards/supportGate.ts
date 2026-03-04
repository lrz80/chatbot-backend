export function isSupportIssue(message: string) {
  const text = message.toLowerCase();

  const keywords = [
    "no funciona",
    "no me deja",
    "error",
    "problema",
    "dinero",
    "perdí",
    "reembolso",
    "refund",
    "cancelé",
    "cancelacion",
    "cancelación",
    "me cobraron",
    "sistema",
    "app"
  ];

  return keywords.some(k => text.includes(k));
}