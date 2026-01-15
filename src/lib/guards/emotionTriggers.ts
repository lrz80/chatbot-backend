import pool from "../db";
import type { Canal } from "../detectarIntencion";
import { esIntencionDeVenta } from "../detectarIntencion";

type Emotion = "enfado" | "frustracion" | "neutral" | "interes" | "entusiasmo" | string;

export async function applyEmotionTriggers(opts: {
  tenantId: string;
  canal: Canal;
  contacto: string;
  emotion: Emotion | null;
  intent: string | null;
  interestLevel: number | null;
}) {
  const { tenantId, canal, contacto, emotion, intent, interestLevel } = opts;

  const e = (emotion || "").toString().trim().toLowerCase();
  const i = (intent || "").toString().trim().toLowerCase();
  const lvl = typeof interestLevel === "number" ? interestLevel : null;

  // default: no acción
  let action: "none" | "handoff_human" | "clarify" | "close" = "none";
  let replyOverride: string | null = null;
  let ctxPatch: any = {};

  // A) Escalar humano
  if (e === "enfado" || (e === "frustracion" && (lvl ?? 1) >= 2)) {
    action = "handoff_human";
    replyOverride =
      "Entiendo. Para ayudarte mejor, te contactará una persona del equipo en un momento.";
    ctxPatch = { human_handoff: true, handoff_reason: e, last_emotion: e };
  }

  // B) Clarify (solo si no escalamos)
  if (action === "none" && e === "frustracion") {
    action = "clarify";
    ctxPatch = { needs_clarify: true, last_emotion: e };
  }

  // C) Close (solo si no escalamos)
  if (
    action === "none" &&
    e === "entusiasmo" &&
    i &&
    esIntencionDeVenta(i) &&
    lvl === 3
  ) {
    action = "close";
    ctxPatch = { ready_to_close: true, last_emotion: e };
  }

  // Persistencia mínima (solo si hay acción)
  if (action === "handoff_human") {
    await pool.query(
      `UPDATE clientes
         SET human_override = true,
             updated_at = NOW()
       WHERE tenant_id = $1 AND canal = $2 AND contacto = $3`,
      [tenantId, canal, contacto]
    );
  }

  return { action, replyOverride, ctxPatch };
}
