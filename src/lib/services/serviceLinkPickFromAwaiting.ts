type PickResult =
  | { ok: true; url: string; label: string }
  | { ok: false; reason: "no_pick" | "out_of_range" | "no_url" };

export function serviceLinkPickFromAwaiting(args: {
  userText: string;
  awaiting: any;
}): PickResult {
  const t = String(args.userText || "").trim();
  const n = Number(t);

  if (!Number.isFinite(n) || n < 1) return { ok: false, reason: "no_pick" };

  const aw = args.awaiting;
  if (!aw || aw.kind !== "service_link_pick") return { ok: false, reason: "no_pick" };

  const options = Array.isArray(aw.options) ? aw.options : [];
  if (!options.length) return { ok: false, reason: "out_of_range" };

  const idx = n - 1;
  if (idx < 0 || idx >= options.length) return { ok: false, reason: "out_of_range" };

  const chosen = options[idx];
  const url = String(chosen?.url || "").trim();
  const label = String(chosen?.label || "").trim();

  if (!url) return { ok: false, reason: "no_url" };

  return { ok: true, url, label: label || `Opción ${n}` };
}
