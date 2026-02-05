export function postBookingCourtesyGuard(args: {
  ctx: any;
  userInput: string;
  idioma: "es" | "en";
}): { hit: true; reply: string } | { hit: false } {
  const { ctx, userInput, idioma } = args;

  const lastDoneAt = ctx?.booking_last_done_at;
  const completedAtISO = ctx?.booking_completed_at;

  const lastMs =
    typeof lastDoneAt === "number"
      ? lastDoneAt
      : (typeof completedAtISO === "string" ? Date.parse(completedAtISO) : null);

  if (!lastMs || !Number.isFinite(lastMs)) return { hit: false };

  const seconds = (Date.now() - lastMs) / 1000;
  if (!(seconds >= 0 && seconds < 10 * 60)) return { hit: false };

  const t = String(userInput || "").trim().toLowerCase();
  const courtesy =
    /^(gracias|muchas gracias|thank you|thanks|ok|okay|perfecto|listo|vale|dale|bien|genial|super|cool)$/i.test(t);

  if (!courtesy) return { hit: false };

  return {
    hit: true,
    reply: idioma === "en" ? "You’re welcome." : "A la orden.",
  };
}
