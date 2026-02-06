// backend/src/lib/services/fastpath/handleServicesFastpath.ts
import type { Pool } from "pg";

import { wantsServiceLink } from "../wantsServiceLink";
import { resolveServiceLink } from "../resolveServiceLink";

import { wantsServiceInfo } from "../wantsServiceInfo";

import { renderServiceInfoReply } from "../renderServiceInfoReply";

import { wantsServiceList } from "../wantsServiceList";

import { parsePickNumber } from "../../channels/engine/parsers/parsers";
import { traducirMensaje } from "../../traducirMensaje";
import { renderMoreInfoClarifier } from "./renderMoreInfoClarifier";
import { renderServiceSummaryReply } from "./renderServiceSummaryReply";
import { isNonCatalogQuestion } from "./gates/isNonCatalogQuestion";
import { resolveServiceInfoByDb } from "./resolveServiceInfoByDb";

type Lang = "es" | "en";

type TransitionFn = (args: { patchCtx?: any; flow?: string; step?: string }) => void;

type PersistStateFn = (args: { context: any }) => Promise<void>;

type ReplyAndExitFn = (text: string, source: string, intent?: string | null) => Promise<void>;

function looksLikeVariants(labels: string[]) {
  const prefixes = labels
    .map((l) => String(l || "").split(" - ")[0].trim())
    .filter(Boolean);

  if (!prefixes.length) return false;

  const freq = new Map<string, number>();
  for (const p of prefixes) freq.set(p, (freq.get(p) || 0) + 1);
  const top = Math.max(...Array.from(freq.values()));
  return top >= 2;
}

async function toCanonicalEsForRouting(text: string, lang: Lang) {
  const t = String(text || "").trim();
  if (!t) return t;
  if (lang === "es") return t;

  try {
    const es = await traducirMensaje(t, "es");
    return String(es || t).trim() || t;
  } catch {
    return t;
  }
}

function humanNeedLabel(need: string, lang: Lang) {
  const n = String(need || "any");
  if (lang === "en") {
    if (n === "price") return "the price";
    if (n === "duration") return "the duration";
    if (n === "includes") return "what it includes";
    return "more details";
  }
  if (n === "price") return "el precio";
  if (n === "duration") return "la duración";
  if (n === "includes") return "qué incluye";
  return "más detalles";
}

function renderPickMenu(options: any[], need: string, lang: Lang) {
  const labels = options.map((o) => String(o.label || ""));
  const isVar = looksLikeVariants(labels);

  const lines = options.map((o: any, i: number) => `${i + 1}) ${o.label}`).join("\n");
  const what = humanNeedLabel(need, lang);

  if (lang === "en") {
    return (
      `${isVar ? "Which option do you want?" : "Which service do you mean?"} ` +
      `Reply with the number so I can give you ${what}:\n\n` +
      `${lines}\n\n` +
      `Reply with just the number (e.g. 1).`
    );
  }

  return (
    `${isVar ? "¿Cuál opción quieres?" : "¿A cuál servicio te refieres?"} ` +
    `Respóndeme con el número para darte ${what}:\n\n` +
    `${lines}\n\n` +
    `Solo responde con el número (ej: 1).`
  );
}

function renderOutOfRangeMenu(options: any[], _need: string, lang: Lang) {
  const lines = options.map((o: any, i: number) => `${i + 1}) ${o.label}`).join("\n");
  if (lang === "en") return `That number isn’t in the list. Please choose one of these:\n\n${lines}`;
  return `Ese número no está en la lista. Elige una de estas opciones:\n\n${lines}`;
}

function renderExpiredPick(lang: Lang) {
  if (lang === "en") {
    return "That selection expired (it was pending for a while). Ask again about the service and I’ll show the options again.";
  }
  return "Esa selección expiró (quedó pendiente por un rato). Vuelve a preguntarme por el servicio y te muestro las opciones otra vez.";
}

function wantsGeneralPrices(text: string) {
  const t = String(text || "").toLowerCase().trim();

  // señales de precio (genéricas)
  const asksPrice =
    /\b(precio|precios|cu[aá]nto\s+cuesta|cu[aá]nto\s+vale|tarifa|cost(o|os))\b/.test(t) ||
    /\b(price|prices|how\s+much|how\s+much\s+is|cost|rate|fee)\b/.test(t);

  if (!asksPrice) return false;

  // quitamos frases de precio y medimos lo que queda:
  // si queda MUY poco texto -> suele ser general ("precios", "cuánto cuesta")
  const remainder = t
    .replace(/\b(precio|precios|cu[aá]nto\s+cuesta|cu[aá]nto\s+vale|tarifa|cost(o|os))\b/g, "")
    .replace(/\b(price|prices|how\s+much|how\s+much\s+is|cost|rate|fee)\b/g, "")
    .replace(/[^a-z0-9áéíóúñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // si el mensaje ya trae bastante contenido (ej "corte de pelo") NO lo tratamos como lista general,
  // porque primero queremos intentar match específico por DB.
  return remainder.length <= 10;
}

function wantsPrice(text: string) {
  const t = String(text || "").toLowerCase();
  return /\b(price|how much|cost|pricing|cu[aá]nto|precio|cuesta|vale|tarifa)\b/.test(t);
}

function wantsMoreInfoOnly(text: string) {
  const t = String(text || "").toLowerCase().trim();

  // frases “más info” (ES/EN)
  const asksMore =
    /\b(m[aá]s\s*info(rmaci[oó]n)?|quiero\s+m[aá]s\s+info|dame\s+m[aá]s\s+info|m[aá]s\s+detalles|detalles)\b/.test(t) ||
    /\b(more\s+info(rmation)?|more\s+details|details|tell\s+me\s+more)\b/.test(t);

  if (!asksMore) return false;

  // si ya pidió algo específico (precio/horario/reservar/lista/servicios), NO es “solo más info”
  const specific =
    /\b(precio|precios|cu[aá]nto|price|prices|cost|rate|fee)\b/.test(t) ||
    /\b(horario|horarios|hours|open|close|ubicaci[oó]n|location|address)\b/.test(t) ||
    /\b(reserv|cita|booking|appointment|schedule)\b/.test(t) ||
    /\b(servicios|services|lista|menu|cat[aá]logo|catalog)\b/.test(t);

  return !specific;
}

function shortenUrl(u?: string | null) {
  if (!u) return "";
  try {
    const url = new URL(u);
    const path = url.pathname.length > 28 ? url.pathname.slice(0, 28) + "…" : url.pathname;
    return `${url.host}${path}`;
  } catch {
    const s = String(u);
    return s.slice(0, 40) + (s.length > 40 ? "…" : "");
  }
}

function looksLikeVariantsOfSameService(labels: string[]) {
  const prefixes = labels
    .map((l) => String(l || ""))
    .map((l) => l.split(" - ")[0].trim())
    .filter(Boolean);

  if (!prefixes.length) return false;

  const freq = new Map<string, number>();
  for (const p of prefixes) freq.set(p, (freq.get(p) || 0) + 1);

  const top = Array.from(freq.values()).sort((a, b) => b - a)[0] || 0;
  return top >= 2;
}

export async function handleServicesFastpath(args: {
  pool: Pool;
  tenantId: string;
  canal: string;
  contacto: string;
  userInput: string;
  idiomaDestino: Lang;
  convoCtx: any;

  transition: TransitionFn;
  persistState: PersistStateFn;
  replyAndExit: ReplyAndExitFn;
}) {
  const {
    pool,
    tenantId,
    canal,
    contacto,
    userInput,
    idiomaDestino,
    convoCtx,
    transition,
    persistState,
    replyAndExit,
  } = args;

    const routingText = await toCanonicalEsForRouting(userInput, idiomaDestino);

    // 0) Gates: preguntas que NO son sobre catálogo/precios/servicios
    if (isNonCatalogQuestion(routingText)) {
    return { handled: false };
    }

  // =========================================================
  // 1) SERVICE LINK PICK (sticky)
  // =========================================================
  {
    const pickState = convoCtx?.service_link_pick;
    const options = Array.isArray(pickState?.options) ? pickState.options : [];

    if (options.length) {
      const createdAtMs =
        typeof pickState?.created_at === "string" ? Date.parse(pickState.created_at) : NaN;

      const fresh =
        Number.isFinite(createdAtMs) ? Date.now() - createdAtMs < 10 * 60 * 1000 : false;

      if (!fresh) {
        transition({ patchCtx: { service_link_pick: null } });
        await persistState({ context: convoCtx });

        const msg =
          idiomaDestino === "en"
            ? "That selection expired. Ask me again which service you want."
            : "Esa selección expiró. Vuelve a pedirme el link del servicio.";

        await replyAndExit(msg, "service_link_pick:expired", "service_link");
        return { handled: true };
      }

      const n = parsePickNumber(userInput);
      const need = (pickState?.need || "any") as any;

      if (n !== null) {
        const idx = n - 1;

        if (idx < 0 || idx >= options.length) {
          const msg = renderOutOfRangeMenu(options, need, idiomaDestino);
          await replyAndExit(msg, "service_link_pick:out_of_range", "service_link");
          return { handled: true };
        }

        const chosen = options[idx];
        const url = String(chosen?.url || "").trim();

        transition({ patchCtx: { service_link_pick: null } });
        await persistState({ context: convoCtx });

        if (!url) {
          const msg =
            idiomaDestino === "en"
              ? "That option doesn't have a link saved yet."
              : "Esa opción no tiene link guardado todavía.";
          await replyAndExit(msg, "service_link_pick:no_url", "service_link");
          return { handled: true };
        }

        await replyAndExit(url, "service_link_pick:number", "service_link");
        return { handled: true };
      }

      // por texto simple
      const t = String(userInput || "").trim().toLowerCase();
      if (t.length >= 2) {
        const matchIdx = options.findIndex((o: any) => {
          const lbl = String(o?.label || "").toLowerCase();
          return lbl.includes(t) || t.includes(lbl);
        });

        if (matchIdx >= 0) {
          const chosen = options[matchIdx];
          const url = String(chosen?.url || "").trim();

          transition({ patchCtx: { service_link_pick: null } });
          await persistState({ context: convoCtx });

          if (!url) {
            const msg =
              idiomaDestino === "en"
                ? "That option doesn't have a link saved yet."
                : "Esa opción no tiene link guardado todavía.";
            await replyAndExit(msg, "service_link_pick:text_no_url", "service_link");
            return { handled: true };
          }

          await replyAndExit(url, "service_link_pick:text", "service_link");
          return { handled: true };
        }
      }

      const lines = options.map((o: any, i: number) => `${i + 1}) ${o.label}`).join("\n");
      const msg =
        idiomaDestino === "en"
          ? `Which option do you want? Reply with the number:\n${lines}`
          : `¿Cuál opción quieres? Responde con el número:\n${lines}`;

      await replyAndExit(msg, "service_link_pick:reprompt", "service_link");
      return { handled: true };
    }
  }

  // =========================================================
  // 2) SERVICE LINK FAST-PATH
  // =========================================================
  if (wantsServiceLink(routingText)) {
    const resolved = await resolveServiceLink({
      tenantId,
      query: userInput,
      limit: 5,
    });

    if (resolved.ok) {
      const msg =
        idiomaDestino === "en"
          ? `Here’s the link for ${resolved.label}:\n${resolved.url}`
          : `Aquí tienes el enlace para ${resolved.label}:\n${resolved.url}`;

      await replyAndExit(msg, "service_link", "service_link");
      return { handled: true };
    }

    if (resolved.reason === "ambiguous" && resolved.options?.length) {
      const options = resolved.options.slice(0, 5).map((o) => ({
        label: o.label,
        url: o.url || null,
      }));

      transition({
        patchCtx: {
          service_link_pick: {
            kind: "service_link_pick",
            options,
            created_at: new Date().toISOString(),
          },
        },
      });

      await persistState({ context: convoCtx });

      const labels = options.map((o) => o.label);
      const isVariants = looksLikeVariantsOfSameService(labels);

      const lines = options
        .map((o, i) => {
          const hint = o.url ? ` (${shortenUrl(o.url)})` : "";
          return `${i + 1}) ${o.label}${hint}`;
        })
        .join("\n");

      const msg =
        idiomaDestino === "en"
          ? isVariants
            ? `Perfect — there are a couple of options. Which one do you prefer?\n\n${lines}\n\nReply with the number and I’ll send the booking link.`
            : `Got it — which one do you want the link for?\n\n${lines}\n\nReply with the number and I’ll send it.`
          : isVariants
            ? `¡Perfecto! Hay un par de opciones 😊 ¿Cuál prefieres?\n\n${lines}\n\nRespóndeme con el número y te envío el enlace para reservar.`
            : `¡Listo! ¿Cuál de estos servicios quieres?\n\n${lines}\n\nRespóndeme con el número y te envío el enlace.`;

      await replyAndExit(msg, "service_link:ambiguous", "service_link");
      return { handled: true };
    }

    const msg =
      idiomaDestino === "en"
        ? "Which service do you need the link for? Tell me the exact name."
        : "¿De cuál servicio necesitas el link exactamente? Dime el nombre.";

    await replyAndExit(msg, "service_link:no_match", "service_link");
    return { handled: true };
  }

    // =========================================================
    // 3) PRICE LIST FAST-PATH (precios genéricos)
    //    ✅ PERO: primero intenta match específico (service/variant)
    // =========================================================
    if (wantsPrice(routingText)) {
    // ✅ 3A) Intento 1: resolver precio específico por DB (service/variant)
    // Ej: "cuanto cuesta el corte de pelo" -> debe devolver menú por tamaño si aplica
    const specific = await resolveServiceInfoByDb({
        pool,
        tenantId,
        query: String(userInput || "").trim(),
        need: "price",
        limit: 5,
    });

    // ✅ Si encontró 1 match -> responde SOLO ese precio
    if (specific.ok) {
        transition({
        patchCtx: {
            last_service_ref: {
            kind: specific.kind || null,
            label: specific.label || null,
            service_id: specific.service_id || null,
            variant_id: specific.variant_id || null,
            saved_at: new Date().toISOString(),
            },
        },
        });

        await persistState({ context: convoCtx });

        const msg = renderServiceInfoReply(specific, "price", idiomaDestino);
        await replyAndExit(msg, "price:specific_match", "service_info");
        return { handled: true };
    }

    // ✅ Si devolvió varias opciones (por tamaño, etc.) -> crea menú sticky
    if (specific.reason === "ambiguous" && specific.options?.length) {
        const options = specific.options.slice(0, 5).map((o: any) => ({
        label: o.label,
        kind: o.kind,
        service_id: o.service_id,
        variant_id: o.variant_id || null,
        }));

        transition({
        patchCtx: {
            service_info_pick: {
            need: "price",
            options,
            created_at: new Date().toISOString(),
            },
        },
        });

        await persistState({ context: convoCtx });

        const msg = renderPickMenu(options, "price", idiomaDestino);
        await replyAndExit(msg, "price:ambiguous_pick", "service_info");
        return { handled: true };
    }

    // ✅ 3B) Si el usuario realmente pidió precios "generales" -> lista corta
    // (si no, deja que siga el pipeline normal)
    if (wantsGeneralPrices(routingText)) {
        const { rows } = await pool.query(
        `
        (
            SELECT
            s.name AS label,
            NULL::text AS variant_name,
            s.price_base AS price,
            'USD'::text AS currency,
            s.service_url AS url,
            1 AS sort_group,
            s.updated_at AS updated_at
            FROM services s
            WHERE s.tenant_id = $1
            AND s.active = TRUE
            AND s.price_base IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM service_variants v2
                WHERE v2.service_id = s.id
                AND v2.active = TRUE
                AND v2.price IS NOT NULL
            )
        )
        UNION ALL
        (
            SELECT
            s.name AS label,
            v.variant_name AS variant_name,
            v.price AS price,
            COALESCE(v.currency, 'USD') AS currency,
            COALESCE(v.variant_url, s.service_url) AS url,
            2 AS sort_group,
            v.updated_at AS updated_at
            FROM services s
            JOIN service_variants v ON v.service_id = s.id
            WHERE s.tenant_id = $1
            AND s.active = TRUE
            AND v.active = TRUE
            AND v.price IS NOT NULL
        )
        ORDER BY sort_group ASC, updated_at DESC
        LIMIT 12
        `,
        [tenantId]
        );

        if (!rows.length) {
        const msg =
            idiomaDestino === "en"
            ? "I don’t have prices saved yet."
            : "Todavía no tengo precios guardados.";
        await replyAndExit(msg, "price_list:empty", "precios");
        return { handled: true };
        }

        const lines = rows.map((r: any) => {
        const p = Number(r.price);
        const cur = String(r.currency || "USD");
        const name = r.variant_name ? `${r.label} - ${r.variant_name}` : String(r.label);
        return `• ${name}: $${p.toFixed(2)} ${cur}`;
        });

        const msg =
        idiomaDestino === "en"
            ? `Here are the current prices:\n\n${lines.join("\n")}\n\nWhich one are you interested in?`
            : `Estos son los precios actuales:\n\n${lines.join("\n")}\n\n¿Cuál te interesa para darte más detalles?`;

        await replyAndExit(msg, "price_list:fallback_general", "precios");
        return { handled: true };
    }
    }

  // =========================================================
  // 4) SERVICE INFO FAST-PATH (precio/duración/incluye)
  // =========================================================
  {
    const need = wantsServiceInfo(routingText);

    if (need === "any") {
    const msg = await renderMoreInfoClarifier({
        pool,
        tenantId,
        lang: idiomaDestino,
    });

    await replyAndExit(msg, "service_info:any_clarify", "service_info");
    return { handled: true };
    }

    if (need) {
      const hint = String(userInput || "").trim();

      // ✅ DB-first siempre; si no matchea, luego puedes caer a resolveServiceInfo si quieres
      const r = await resolveServiceInfoByDb({
        pool,
        tenantId,
        query: hint,
        need,
        limit: 5,
      });

      if (r.ok) {
        transition({
          patchCtx: {
            last_service_ref: {
              kind: r.kind || null,
              label: r.label || null,
              service_id: r.service_id || null,
              variant_id: r.variant_id || null,
              saved_at: new Date().toISOString(),
            },
          },
        });

        await persistState({ context: convoCtx });

        const msg = renderServiceInfoReply(r, need, idiomaDestino);
        await replyAndExit(msg, "service_info", "service_info");
        return { handled: true };
      }

      if (r.reason === "ambiguous" && r.options?.length) {
        const options = r.options.slice(0, 5).map((o) => ({
          label: o.label,
          kind: o.kind,
          service_id: o.service_id,
          variant_id: o.variant_id || null,
        }));

        transition({
          patchCtx: {
            service_info_pick: {
              need,
              options,
              created_at: new Date().toISOString(),
            },
          },
        });

        await persistState({ context: convoCtx });

        const msg = renderPickMenu(options, need, idiomaDestino);
        await replyAndExit(msg, "service_info:ambiguous", "service_info");
        return { handled: true };
      }

      if (!r.ok && need === "price") {
        // ✅ si preguntan precio y no hubo match específico, damos lista de precios
        // reutiliza la misma query de tu price_list (sin hardcode por negocio)
        const { rows } = await pool.query(
          `
          (
            SELECT
              s.name AS label,
              NULL::text AS variant_name,
              s.price_base AS price,
              'USD'::text AS currency,
              s.service_url AS url,
              1 AS sort_group,
              s.updated_at AS updated_at
            FROM services s
            WHERE s.tenant_id = $1
                AND s.active = TRUE
                AND s.price_base IS NOT NULL
                AND NOT EXISTS (
                SELECT 1
                FROM service_variants v2
                WHERE v2.service_id = s.id
                    AND v2.active = TRUE
                    AND v2.price IS NOT NULL
                )
            )
            UNION ALL
            (
            SELECT
                s.name AS label,
                v.variant_name AS variant_name,
                v.price AS price,
                COALESCE(v.currency, 'USD') AS currency,
                COALESCE(v.variant_url, s.service_url) AS url,
                2 AS sort_group,
                v.updated_at AS updated_at
            FROM services s
            JOIN service_variants v ON v.service_id = s.id
            WHERE s.tenant_id = $1
                AND s.active = TRUE
                AND v.active = TRUE
                AND v.price IS NOT NULL
            )
            ORDER BY sort_group ASC, updated_at DESC
            LIMIT 12
            `,
            [tenantId]
        );

        if (rows.length) {
            const lines = rows.map((rr: any) => {
            const p = Number(rr.price);
            const cur = String(rr.currency || "USD");
            const name = rr.variant_name ? `${rr.label} - ${rr.variant_name}` : String(rr.label);
            return `• ${name}: $${p.toFixed(2)} ${cur}`;
            });

            const msg =
            idiomaDestino === "en"
                ? `Here are the current prices:\n\n${lines.join("\n")}`
                : `Estos son los precios actuales:\n\n${lines.join("\n")}`;

            await replyAndExit(msg, "service_info:price_fallback_list", "precios");
            return { handled: true };
          }
        }

      // fallback por last_service_ref
      const lastRef = convoCtx?.last_service_ref;

      if (lastRef?.service_id) {
        const { rows } = await pool.query(
          `
          SELECT
            s.id AS service_id,
            s.name AS service_name,
            s.description AS service_desc,
            s.duration_min AS service_duration,
            s.price_base AS service_price_base,
            s.service_url AS service_url,

            v.id AS variant_id,
            v.variant_name,
            v.description AS variant_desc,
            v.duration_min AS variant_duration,
            v.price AS variant_price,
            v.currency AS variant_currency,
            v.variant_url AS variant_url
          FROM services s
          LEFT JOIN service_variants v ON v.id = $2 AND v.service_id = s.id
          WHERE s.tenant_id = $1
            AND s.active = TRUE
            AND s.id = $3
          LIMIT 1
          `,
          [tenantId, lastRef.variant_id || null, lastRef.service_id]
        );

        const row = rows[0];
        if (row) {
          const price =
            row.variant_price != null
              ? Number(row.variant_price)
              : row.service_price_base != null
                ? Number(row.service_price_base)
                : null;

          const currency = row.variant_currency ? String(row.variant_currency) : "USD";

          const duration_min =
            row.variant_duration != null
              ? Number(row.variant_duration)
              : row.service_duration != null
                ? Number(row.service_duration)
                : null;

          const description =
            row.variant_desc && String(row.variant_desc).trim()
              ? String(row.variant_desc)
              : row.service_desc
                ? String(row.service_desc)
                : null;

          const url =
            row.variant_url && String(row.variant_url).trim()
              ? String(row.variant_url)
              : row.service_url
                ? String(row.service_url)
                : null;

          const kind: "variant" | "service" = row.variant_id ? "variant" : "service";

          const resolved = {
            ok: true as const,
            kind,
            label: row.variant_id ? `${row.service_name} - ${row.variant_name}` : String(row.service_name),
            url,
            price,
            currency: (currency ?? null) as string | null,
            duration_min,
            description,
            service_id: String(row.service_id),
            variant_id: row.variant_id ? String(row.variant_id) : undefined,
          };

          const msg = renderServiceInfoReply(resolved, need, idiomaDestino);
          await replyAndExit(msg, "service_info:ctx_last_ref", "service_info");
          return { handled: true };
        }
      }

      const msg =
        idiomaDestino === "en"
          ? "Which service do you mean? Tell me the exact name."
          : "¿Cuál servicio exactamente? Dime el nombre.";

      await replyAndExit(msg, "service_info:no_match", "service_info");
      return { handled: true };
    }
  }

  // =========================================================
  // 5) SERVICE LIST / MORE INFO (SUMMARY, no spam)
  // =========================================================
  if (wantsMoreInfoOnly(routingText)) {
    const msg = await renderMoreInfoClarifier({
      pool,
      tenantId,
      lang: idiomaDestino,
    });

    await replyAndExit(msg, "more_info:clarifier", "service_info");
    return { handled: true };
  }

  if (wantsServiceList(routingText)) {
    const msg = await renderServiceSummaryReply({
      pool,
      tenantId,
      lang: idiomaDestino,
    });

    await replyAndExit(msg, "service_summary", "service_list");
    return { handled: true };
  }

  // =========================================================
  // 6) SERVICE INFO PICK (sticky)
  // =========================================================
  {
    const pickState = convoCtx?.service_info_pick;
    const options = Array.isArray(pickState?.options) ? pickState.options : [];

    if (options.length) {
      const createdAtMs =
        typeof pickState?.created_at === "string" ? Date.parse(pickState.created_at) : NaN;

      const fresh =
        Number.isFinite(createdAtMs) ? Date.now() - createdAtMs < 10 * 60 * 1000 : false;

      if (!fresh) {
        transition({ patchCtx: { service_info_pick: null } });
        await persistState({ context: convoCtx });

        const msg = renderExpiredPick(idiomaDestino);
        await replyAndExit(msg, "service_info_pick:expired", "service_info");
        return { handled: true };
      }

      const n = parsePickNumber(userInput);
      const need = (pickState?.need || "any") as any;

      if (n === null) {
        const msg = renderPickMenu(options, need, idiomaDestino);
        await replyAndExit(msg, "service_info_pick:reprompt", "service_info");
        return { handled: true };
      }

      const idx = n - 1;
      if (idx < 0 || idx >= options.length) {
        const msg = renderOutOfRangeMenu(options, need, idiomaDestino);
        await replyAndExit(msg, "service_info_pick:out_of_range", "service_info");
        return { handled: true };
      }

      const chosen = options[idx];
      let resolved: any = null;

      if (chosen.kind === "variant" && chosen.variant_id) {
        const { rows } = await pool.query(
          `
          SELECT s.id AS service_id, s.name AS service_name, s.description AS service_desc,
                s.duration_min AS service_duration, s.price_base, s.service_url,
                v.id AS variant_id, v.variant_name, v.description AS variant_desc,
                v.duration_min AS variant_duration, v.price, v.currency, v.variant_url
          FROM service_variants v
          JOIN services s ON s.id = v.service_id
          WHERE s.tenant_id = $1
            AND s.active = TRUE
            AND v.active = TRUE
            AND v.id = $2
          LIMIT 1
          `,
          [tenantId, chosen.variant_id]
        );

        const row = rows[0];
        if (row) {
          const price =
            row.price != null ? Number(row.price)
            : row.price_base != null ? Number(row.price_base)
            : null;

          const currency = row.currency ? String(row.currency) : "USD";

          resolved = {
            ok: true,
            kind: "variant",
            label: `${row.service_name} - ${row.variant_name}`,
            url: row.variant_url || row.service_url || null,
            price,
            currency,
            duration_min:
              row.variant_duration != null ? Number(row.variant_duration)
              : row.service_duration != null ? Number(row.service_duration)
              : null,
            description:
              row.variant_desc && String(row.variant_desc).trim()
                ? String(row.variant_desc)
                : row.service_desc ? String(row.service_desc) : null,
            service_id: String(row.service_id),
            variant_id: String(row.variant_id),
          };
        }
      } else {
        const { rows } = await pool.query(
          `
          SELECT
            s.id AS service_id,
            s.name AS service_name,
            s.description AS service_desc,
            s.duration_min AS service_duration,
            s.price_base AS service_price_base,
            s.service_url AS service_url,

            v.id AS variant_id,
            v.variant_name,
            v.description AS variant_desc,
            v.duration_min AS variant_duration,
            v.price AS variant_price,
            v.currency AS variant_currency,
            v.variant_url AS variant_url
          FROM services s
          LEFT JOIN LATERAL (
            SELECT v.*
            FROM service_variants v
            WHERE v.service_id = s.id
              AND v.active = TRUE
              AND v.price IS NOT NULL
            ORDER BY v.updated_at DESC
            LIMIT 1
          ) v ON TRUE
          WHERE s.tenant_id = $1
            AND s.active = TRUE
            AND s.id = $2
          LIMIT 1
          `,
          [tenantId, chosen.service_id]
        );

        const row = rows[0];
        if (row) {
          const price =
            row.variant_price != null ? Number(row.variant_price)
            : row.service_price_base != null ? Number(row.service_price_base)
            : null;

          const currency = row.variant_currency ? String(row.variant_currency) : "USD";

          const url =
            row.variant_url && String(row.variant_url).trim()
              ? String(row.variant_url)
              : row.service_url ? String(row.service_url) : null;

          const duration_min =
            row.variant_duration != null ? Number(row.variant_duration)
            : row.service_duration != null ? Number(row.service_duration)
            : null;

          const description =
            row.variant_desc && String(row.variant_desc).trim()
              ? String(row.variant_desc)
              : row.service_desc ? String(row.service_desc) : null;

          resolved = {
            ok: true,
            kind: row.variant_id ? "variant" : "service",
            label: row.variant_id ? `${row.service_name} - ${row.variant_name}` : String(row.service_name),
            url,
            price,
            currency,
            duration_min,
            description,
            service_id: String(row.service_id),
            variant_id: row.variant_id ? String(row.variant_id) : undefined,
          };
        }
      }

      // limpiar pick
      transition({ patchCtx: { service_info_pick: null } });
      await persistState({ context: convoCtx });

      if (resolved?.ok) {
        transition({
          patchCtx: {
            last_service_ref: {
              kind: resolved.kind || null,
              label: resolved.label || null,
              service_id: resolved.service_id || null,
              variant_id: resolved.variant_id || null,
              saved_at: new Date().toISOString(),
            },
          },
        });

        await persistState({ context: convoCtx });

        const msg = renderServiceInfoReply(resolved, need, idiomaDestino);
        await replyAndExit(msg, "service_info_pick", "service_info");
        return { handled: true };
      }

      const msg =
        idiomaDestino === "en"
          ? "I couldn't find that option anymore. Ask again about the service."
          : "No pude encontrar esa opción ya. Vuelve a preguntarme por el servicio.";

      await replyAndExit(msg, "service_info_pick:not_found", "service_info");
      return { handled: true };
    }
  }

  return { handled: false };
}
