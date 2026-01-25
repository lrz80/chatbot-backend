// src/lib/appointments/booking/text.ts
import { DateTime } from "luxon";

export const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

export function normalizeText(s: string) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s:@.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasExplicitDateTime(text: string) {
  return /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/.test(String(text || ""));
}

export function hasAppointmentContext(text: string) {
  const t = normalizeText(text);
  const agendLike = /\bagend+a+\w*\b/;
  const bookLike = /\b(cita|consulta|reservar|reserva|turno|appointment|booking|schedule)\b/;
  return agendLike.test(t) || bookLike.test(t);
}

export function isCapabilityQuestion(text: string) {
  const t = normalizeText(text);

  const looksLikeQuestion =
    /\?/.test(text) || /\b(que|qué|como|cómo|cuál|cual)\b/.test(t);

  const q =
    /\b(puede|pueden|se puede|puedes|podria|podrían|capaz|permite|permiten|hace|hacen|incluye|incluyen)\b/.test(t) ||
    /\b(can you|can it|does it|do you|is it able to|are you able to)\b/.test(t);

  const bookingCapability =
    /\b(reserva|reservas|reservar|agenda|agendas|agendar|agendame|agéndame|programa|programas|programar)\b/.test(t) ||
    /\b(schedule|schedules|book|books|booking)\b/.test(t);

  const shortNoQuestionMark =
    t.length <= 30 && /\b(reserva|agenda|agendar|reservar|schedule|book|booking)\b/.test(t);

  if (shortNoQuestionMark) return true;
  if (looksLikeQuestion && bookingCapability) return true;
  return q && looksLikeQuestion;
}

export function isDirectBookingRequest(text: string) {
  const t = normalizeText(text);

  // 1) Imperativos directos (ES)
  if (/\b(agenda|agendame|reservame|reserva|programa|programame)\b/.test(t)) return true;

  // 2) “Quiero/puedo/necesito + verbo” (ES)
  if (/\b(quiero|quisiera|necesito|me gustaria|podemos|podria|puedes|puede|vamos a)\s+(agendar|reservar|programar)\b/.test(t)) {
    return true;
  }

  // 3) “Cita / turno / consulta” como intención explícita (ES)
  // (Incluye “sacar una cita”, “hacer una cita”, “separar cita”, “turno”, “consulta”)
  if (
    /\b(sacar|hacer|separar|reservar|agendar|programar)\s+(una\s+)?(cita|turno|consulta)\b/.test(t) ||
    /\b(cita|turno|consulta)\s+(para|pa|con)\b/.test(t) ||
    /\bquiero\s+(una\s+)?(cita|turno|consulta)\b/.test(t)
  ) {
    return true;
  }

  // 4) Inglés: booking / appointment
  if (
    /\b(book|booking|schedule|reserve)\b/.test(t) &&
    /\b(me|an appointment|appointment|a call|a consultation|a session)\b/.test(t)
  ) {
    return true;
  }

  // 5) Inglés “book me / schedule me” (tu caso original)
  if (/\b(book me|schedule me|reserve)\b/.test(t)) return true;

  return false;
}

export function detectDaypart(text: string): "morning" | "afternoon" | null {
  const t = normalizeText(text);

  // ✅ Morning intent
  if (
    /\b(manana|mañana|morning|temprano|por la manana|por la mañana|antes del mediodia|antes del mediodía)\b/i.test(t) ||
    /\b([1-9]|1[0-1])\s*(am|a\.m\.)\b/i.test(t) // "9am", "10 a.m."
  ) {
    return "morning";
  }

  // ✅ Afternoon/Evening/Night intent (tu sistema lo agrupa como "afternoon")
  if (
    /\b(tarde|afternoon|por la tarde|despues del mediodia|después del mediodía)\b/i.test(t) ||
    /\b(noche|evening|night|por la noche)\b/i.test(t) ||
    /\b(1[0-2]|[1-9])\s*(pm|p\.m\.)\b/i.test(t) // "5pm", "7 p.m."
  ) {
    return "afternoon";
  }

  // ✅ Señales conversacionales: "más tarde / más temprano"
  // Si el usuario dice "más temprano", normalmente quiere mañana.
  if (/\b(mas temprano|más temprano|tempranito|early)\b/i.test(t)) return "morning";

  // Si dice "más tarde", suele ser tarde/noche.
  if (/\b(mas tarde|más tarde|later)\b/i.test(t)) return "afternoon";

  return null;
}

export function detectPurpose(text: string): string | null {
  const t = normalizeText(text);

  const has = (pattern: RegExp) => pattern.test(t);

  // CITA / AGENDAR / RESERVAR
  if (
    has(/\b(cita|agendar|agenda|agendacion|reservar|reserva|turno|appointment|book|schedule|appt)\b/)
  ) {
    return "cita";
  }

  // CLASE / TRIAL CLASS
  if (
    has(/\b(clase|class|trial|session|sesion|workout|training)\b/)
  ) {
    return "clase";
  }

  // CONSULTA / ASESORÍA
  if (
    has(/\b(consulta|consultar|consultation|asesoria|asesoría|assessment|evaluation)\b/)
  ) {
    return "consulta";
  }

  // LLAMADA / PHONE CALL
  if (
    has(/\b(llamada|call|phone|telefono|teléfono|videollamada|video call)\b/)
  ) {
    return "llamada";
  }

  // VISITA / PRESENCIAL
  if (
    has(/\b(visita|visit|presencial|in person|walk in)\b/)
  ) {
    return "visita";
  }

  // DEMO
  if (
    has(/\b(demo|demostracion|demostración|demonstration|presentation)\b/)
  ) {
    return "demo";
  }

  return null;
}

export function wantsToCancel(text: string) {
  const t = normalizeText(text);

  // 1) Cancelación DIRECTA (más fuerte)
  if (
    /\b(cancelar|cancela|cancelacion|cancelación|anular|anula)\b/.test(t) ||
    /\b(cancel|cancel it|stop booking|stop scheduling)\b/.test(t)
  ) {
    return true;
  }

  // 2a) "para" ESPECIAL: solo si es un comando (mensaje casi completo)
  // Evita falsos positivos como: "para las 2pm", "para mañana", "para el martes"
  const isParaCommand = /^(para|para ya|para por favor|para pls|para porfa|deten|alto|stop|quit|exit)$/.test(t);

  if (isParaCommand) return true;

  // 2b) Cancelación IMPLÍCITA (neutra pero clara) - SIN "para/parar"
  if (
    /\b(olvida|olvidalo|olvídalo|mejor no|ya no|ya no quiero|prefiero no)\b/.test(t) ||
    /\b(stop|deten|detener|exit|quit)\b/.test(t) ||
    /\b(nevermind|never mind|forget it)\b/.test(t) ||
    /\b(no gracias|no thank(s)?)\b/.test(t) ||
    /\b(nah|nope)\b/.test(t)
  ) {
    return true;
  }

  return false;
}

export function isAmbiguousLangText(txt: string) {
  const t = String(txt || "").trim().toLowerCase();
  if (!t) return true;

  // Solo números / signos / espacios
  if (/^[\d\s.,;:!?()+\-/_]*$/.test(t)) return true;

  // Respuestas cortas típicas (incluye con número)
  if (/^(ok|okay|yes|no|si|sí|dale|listo|vale|perfecto|gracias|thanks)\s*\d*$/.test(t)) return true;

  // Hora sola o “2pm” (sin señal real de idioma)
  if (/^\s*\d{1,2}(:\d{2})?\s*(am|pm)?\s*$/.test(t)) return true;

  // Muy corto
  if (t.length <= 3) return true;

  return false;
}

export function wantsMoreSlots(text: string) {
  const t = normalizeText(text); // ya convierte a minúsculas y limpia acentos

  // --------------------------
  // 1) Frases explícitas ES
  // --------------------------
  if (/\b(otra|otras|otro|otros)\s+(hora|horas|horario|horarios|opcion|opciones)\b/.test(t)) return true;
  if (/\bmas\s+(hora|horas|horario|horarios|opcion|opciones)\b/.test(t)) return true;
  if (/\b(ver|mostrar|dame|manda)\s+mas\b/.test(t)) return true;

  // --------------------------
  // 2) Variantes sueltas ES
  // --------------------------
  if (/\b(siguientes|alternativas|mas|otra|otras|otro|otros)\b/.test(t)) {
    // Evita falso positivo: cambio de día (handled por wantsAnotherDay)
    if (/\botro\s+d[ií]a\b/.test(t)) return false;
    return true;
  }

  // --------------------------
  // 3) Frases de rango temporal ES
  // --------------------------
  if (/\b(mas\s+tarde|mas\s+temprano|despues|antes)\b/.test(t)) return true;

  // --------------------------
  // 4) Inglés: frases explícitas
  // --------------------------
  if (/\b(more|other|another)\s+(time|times|slot|slots|option|options)\b/.test(t)) return true;
  if (/\b(show|see|send)\s+more\b/.test(t)) return true;

  // --------------------------
  // 5) Inglés: individuales
  // --------------------------
  if (/\b(more|other|another)\b/.test(t)) {
    if (/\banother\s+day\b/.test(t)) return false; // evita conflicto con cambiar día
    return true;
  }

  // --------------------------
  // 6) Inglés: rangos temporales
  // --------------------------
  if (/\b(later|earlier|after|before)\b/.test(t)) return true;

  return false;
}

export function wantsAnotherDay(s: string) {
  const t = String(s || "").toLowerCase().trim();

  return (
    // Español (todas las variaciones reales)
    /\botro\s+d[ií]a\b/.test(t) ||                      // "otro día"
    /\b(otro|otra)\b.*\bd[ií]a\b/.test(t) ||            // "tienes otro día?" / "otra día" / "otro día porfa"
    /\bhay\s+otro\s+d[ií]a\b/.test(t) ||                // "hay otro día?"
    /\bmas\s+d[ií]as\b/.test(t) ||                      // "más días"
    /\bdisponible[s]?\s+otro\s+d[ií]a\b/.test(t) ||     // "disponibles otro día"
    /\bpasado\s+mañana\b/.test(t) ||                    // "pasado mañana"

    // Inglés
    /\banother\s+day\b/.test(t) ||                      // "another day"
    /\bnext\s+day\b/.test(t) ||                         // "next day"
    /\bother\s+day\b/.test(t)                           // "other day"
  );
}

export function wantsToChangeTopic(text: string) {
  const t = String(text || "").toLowerCase().trim();

  // Palabras que suelen indicar cambio de tema (ES/EN)
  return (
    // Precio / Costos
    /\b(precio|precios|cuanto|cuánto|tarifa|costo|costos|cuanto sale|cuánto sale)\b/.test(t) ||
    /\b(price|prices|pricing|cost|costs|rate|rates|fee|fees)\b/.test(t) ||
    /\b(how\s*much|what'?s\s+the\s+price|what\s+is\s+the\s+price)\b/.test(t) ||

    // Ubicación
    /\b(ubicacion|ubicación|direccion|dirección)\b/.test(t) ||
    /\b(address|location|where\s+is)\b/.test(t) ||

    // Información general
    /\b(info|informacion|información|detalles|mas informacion|más información)\b/.test(t) ||
    /\b(details|more\s+info|information)\b/.test(t) ||
    /\b(what\s+is\s+this|explain\s+this)\b/.test(t) ||

    // Funcionamiento / explicación
    /\b(como\s+funciona|cómo\s+funciona|como\s+trabaja|cómo\s+trabaja)\b/.test(t) ||
    /\b(how\s+does\s+it\s+work|how\s+it\s+works)\b/.test(t) ||

    // Consultas de disponibilidad general (NO específicas de agendar hora)
    /\b(estan abiertos|abren|cierran|open|close|opening\s+hours|hours\s+of\s+operation)\b/.test(t) ||

    // Cancelar flujo
    /\b(cancelar|cancela|olvida|olvídalo|stop|salir|exit|never\s+mind|nvm)\b/.test(t)
  );
}

export function matchesBookingIntent(text: string, terms: string[]) {
  const t = normalizeText(text);
  return terms.some((term) => {
    const x = normalizeText(term);
    if (!x) return false;
    if (x.includes(" ")) return t.includes(x);
    return new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t);
  });
}

export function extractDateTimeToken(input: string): string | null {
  const m = String(input || "").match(/\b(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\b/);
  return m?.[1] || null;
}

export function extractDateOnlyToken(input: string, timeZone?: string): string | null {
  const raw = String(input || "").toLowerCase().trim();
  const today = (timeZone ? DateTime.now().setZone(timeZone) : DateTime.now()).startOf("day");

  // ----------------------------------------
  // 0) Evitar capturar rangos tipo "1-5" (menú de opciones)
  // ----------------------------------------
  if (/\b\d{1,2}\s*-\s*\d{1,2}\b/.test(raw)) {
    // no es una fecha, es un rango/opciones
    // seguimos, pero SIN usar el matcher simple de día suelto más abajo
  }

  // ----------------------------------------
  // 1) Detecta fecha exacta YYYY-MM-DD (sin hora)
  // ----------------------------------------
  const explicit = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const hasDateTime = /\b\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\b/.test(raw);
  if (explicit && !hasDateTime) return explicit[1];

  // ----------------------------------------
  // 2) Palabras relativas: hoy, pasado mañana, mañana
  //    (IMPORTANTE: pasado mañana antes que mañana)
  // ----------------------------------------
  if (/\bhoy\b/.test(raw)) {
    return today.toFormat("yyyy-MM-dd");
  }

  if (/\bpasado\s+mañana\b/.test(raw)) {
    return today.plus({ days: 2 }).toFormat("yyyy-MM-dd");
  }

  if (/\bmañana\b/.test(raw)) {
    return today.plus({ days: 1 }).toFormat("yyyy-MM-dd");
  }

  // ----------------------------------------
  // 3) Días de la semana: lunes, martes, ...
  // ----------------------------------------
  const dias: Record<string, number> = {
    "lunes": 1,
    "martes": 2,
    "miércoles": 3,
    "miercoles": 3,
    "jueves": 4,
    "viernes": 5,
    "sábado": 6,
    "sabado": 6,
    "domingo": 7,
  };

  for (const d of Object.keys(dias)) {
    if (raw.includes(d)) {
      const targetDow = dias[d];
      const currDow = today.weekday; // lunes=1...domingo=7
      let diff = targetDow - currDow;
      if (diff <= 0) diff += 7; // siguiente ocurrencia
      return today.plus({ days: diff }).toFormat("yyyy-MM-dd");
    }
  }

  // ----------------------------------------
  // 4) Patrones de día del mes:
  //    "para el 25", "el 25", "día 25", "este 25", "25"
  // ----------------------------------------

  // 4a) Prioridad: frases explícitas (para evitar capturar números irrelevantes)
  const mDiaExplicito = raw.match(/\b(?:para\s+el|para|el|dia|día|este)\s+(\d{1,2})\b/);
  if (mDiaExplicito) {
    const dia = Number(mDiaExplicito[1]);
    if (dia >= 1 && dia <= 31) {
      let tentative = today.set({ day: dia });
      // si el día no existe en este mes (ej: 31 en febrero) Luxon ajusta; validamos
      if (tentative.day !== dia) {
        // usa el próximo mes donde exista el día (simple: suma 1 mes y vuelve a setear)
        tentative = today.plus({ months: 1 }).set({ day: dia });
      }
      if (tentative < today) tentative = tentative.plus({ months: 1 });
      return tentative.toFormat("yyyy-MM-dd");
    }
  }

  // 4b) Día suelto: SOLO si NO hay rango tipo 1-5
  if (!/\b\d{1,2}\s*-\s*\d{1,2}\b/.test(raw)) {
    const mDia = raw.match(/\b(\d{1,2})\b/);
    if (mDia) {
      const dia = Number(mDia[1]);
      if (dia >= 1 && dia <= 31) {
        let tentative = today.set({ day: dia });
        if (tentative.day !== dia) tentative = today.plus({ months: 1 }).set({ day: dia });
        if (tentative < today) tentative = tentative.plus({ months: 1 });
        return tentative.toFormat("yyyy-MM-dd");
      }
    }
  }

  return null;
}

// ✅ Extrae hora tipo "5pm", "5 pm", "17", "17:30", "a las 5", "a las 5:30"
export function extractTimeOnlyToken(raw: string): string | null {
  const s = String(raw || "").toLowerCase().trim();

  // ✅ Si ya hay señal clara de hora (am/pm o HH:mm), no corras el filtro de choice
  const hasExplicitTimeSignal =
    /\b(am|pm|a\.m\.|p\.m\.)\b/i.test(s) || /\b([01]?\d|2[0-3]):([0-5]\d)\b/.test(s);

  if (!hasExplicitTimeSignal) {
    const looksLikeChoice =
      /\b(ok|okay|vale|listo|perfecto|opcion|opción|option|elige|escojo|pick|choose|la|el|nro|num|numero|número|#)\s*(\d)\b/.test(s) ||
      /^\s*(\d)\s*$/.test(s);

    if (looksLikeChoice) {
      const n = Number((s.match(/\b(\d)\b/) || [])[1]);
      if (n >= 1 && n <= 5) return null;
    }
  }

  // ✅ 0) Si parece selección de opción (ok 3, opción 3, la 3, #3, etc) -> NO es hora
  // Nota: aquí deliberadamente solo tomamos 1-5 porque tu UI muestra 1-5
  const looksLikeChoice =
    /\b(ok|okay|vale|listo|perfecto|opcion|opción|option|elige|escojo|pick|choose|la|el|nro|num|numero|número|#)\s*(\d)\b/.test(s) ||
    /^\s*(\d)\s*$/.test(s);

  if (looksLikeChoice) {
    const n = Number((s.match(/\b(\d)\b/) || [])[1]);
    if (n >= 1 && n <= 5) return null;
  }

  // ✅ 1) HH:mm (24h)
  let m = s.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;

  // ✅ 2) 5pm / 5 pm / 5:30pm / 5:30 pm
  m = s.match(/\b(1[0-2]|[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  if (m) {
    let hh = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    const ap = m[3];

    if (ap === "pm" && hh !== 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;

    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  // ✅ 3) "a las 5" / "a las 5:30"
  m = s.match(/\ba\s+las\s+(1[0-2]|[1-9]|1\d|2[0-3])(?::([0-5]\d))?\b/);
  if (m) {
    const hh = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }

  // ✅ 4) HH solo (ambiguo) -> SOLO si hay “time cue” claro
  // Esto evita que "ok 3" se convierta en 03:00
  const hasTimeCue = /\b(at|a\s+las|a\s+la|para\s+las|para\s+la|around|sobre|aprox|aproximadamente)\b/.test(s);
  if (hasTimeCue) {
    m = s.match(/\b([01]?\d|2[0-3])\b/);
    if (m) {
      const hh = Number(m[1]);
      return `${String(hh).padStart(2, "0")}:00`;
    }
  }

  return null;
}

export function buildDateTimeFromText(
  text: string,
  timeZone: string,
  durationMin: number
): { startISO: string; endISO: string } | null {
  const dateISO = extractDateOnlyToken(text, timeZone);
  const hhmm = extractTimeOnlyToken(text);

  if (!dateISO || !hhmm) return null;

  // Parse hh:mm
  const [hStr, mStr] = hhmm.split(":");
  let hh = Number(hStr);
  const mm = Number(mStr);

  // Heurística AM/PM cuando NO hay señal explícita:
  // Si el texto NO tiene am/pm y el usuario dijo "a las/para las" con 1-7 -> asumir PM (15:00-19:00)
  const s = String(text || "").toLowerCase();
  const hasAmPm = /\b(am|pm|a\.m\.|p\.m\.)\b/.test(s);
  const hasAtCue = /\b(a\s+las|a\s+la|para\s+las|para\s+la)\b/.test(s);

  if (!hasAmPm && hasAtCue && hh >= 1 && hh <= 7) {
    hh += 12; // 3 -> 15
  }

  const start = DateTime.fromISO(`${dateISO}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`, { zone: timeZone });

  if (!start.isValid) return null;

  // (Opcional) evita slots en el pasado
  const now = DateTime.now().setZone(timeZone);
  if (start < now.minus({ minutes: 1 })) return null;

  const end = start.plus({ minutes: durationMin });
  return { startISO: start.toISO()!, endISO: end.toISO()! };
}

export type TimeConstraint =
  | { kind: "after"; hhmm: string }      // "después de las 4"
  | { kind: "before"; hhmm: string }     // "antes de las 4"
  | { kind: "around"; hhmm: string }     // "tipo 5", "tipo 5 y algo"
  | { kind: "earliest" }                 // "lo más temprano"
  | { kind: "any_afternoon" }            // "cuando puedas por la tarde"
  | { kind: "any_morning" };             // "cuando puedas por la mañana"

export function extractTimeConstraint(raw: string): TimeConstraint | null {
  const t = String(raw || "").toLowerCase().trim();

  // Helpers
  const has = (re: RegExp) => re.test(t);

  // =========================
  // 1) EARLIEST / AS SOON AS POSSIBLE
  // ES: "lo más temprano", "tempranito", "lo más pronto", "a primera hora"
  // EN: "earliest", "as early as possible", "as soon as possible", "first thing"
  // =========================
  if (
    has(/\b(lo\s+m[aá]s\s+temprano|tempranito|lo\s+m[aá]s\s+pronto|a\s+primera\s+hora|lo\s+antes\s+posible)\b/i) ||
    has(/\b(earliest|as\s+early\s+as\s+possible|as\s+soon\s+as\s+possible|first\s+thing|asap)\b/i)
  ) {
    return { kind: "earliest" };
  }

  // =========================
  // 2) ANY MORNING / ANY AFTERNOON / ANY EVENING
  // Trigger words:
  // ES: "cuando puedas", "cuando se pueda", "cualquier hora", "me da igual"
  // EN: "when you can", "whenever", "any time", "doesn't matter", "no preference"
  // =========================
  const anyTimePref =
    has(/\b(cuando\s+puedas|cuando\s+se\s+pueda|cualquier\s+hora|cuando\s+sea|me\s+da\s+igual|sin\s+preferencia|como\s+sea)\b/i) ||
    has(/\b(when\s+you\s+can|whenever|any\s+time|no\s+preference|doesn'?t\s+matter|whatever\s+works)\b/i);

  // Morning
  if (
    anyTimePref &&
    has(/\b(ma[nñ]ana|morning|temprano|early)\b/i)
  ) {
    return { kind: "any_morning" };
  }

  // Afternoon
  if (
    anyTimePref &&
    has(/\b(tarde|afternoon)\b/i)
  ) {
    return { kind: "any_afternoon" };
  }

  // Evening (opcional, por si luego lo soportas; si NO lo soportas, puedes quitarlo)
  // if (anyTimePref && has(/\b(noche|evening|tonight|late)\b/i)) {
  //   return { kind: "any_evening" as any };
  // }

  // =========================
  // 3) AFTER HH:mm
  // ES: "después de las 4", "despues de 4", "después de las 4:30", "a partir de las 4"
  // EN: "after 4", "after 4:30", "from 4pm", "after 4pm"
  // =========================
  if (
    has(/\b(despu[eé]s\s+de\s+(las|la)?\s*\d{1,2}(:\d{2})?)\b/i) ||
    has(/\b(a\s+partir\s+de\s+(las|la)?\s*\d{1,2}(:\d{2})?)\b/i) ||
    has(/\b(after|from)\s+\d{1,2}(:\d{2})?\s*(am|a\.m\.|pm|p\.m\.)?\b/i)
  ) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "after", hhmm };
  }

  // =========================
  // 4) BEFORE HH:mm
  // ES: "antes de las 4", "antes de 4:30", "no más tarde de las 4"
  // EN: "before 4", "before 4:30", "no later than 4"
  // =========================
  if (
    has(/\b(antes\s+de\s+(las|la)?\s*\d{1,2}(:\d{2})?)\b/i) ||
    has(/\b(no\s+m[aá]s\s+tarde\s+de\s+(las|la)?\s*\d{1,2}(:\d{2})?)\b/i) ||
    has(/\b(before|no\s+later\s+than)\s+\d{1,2}(:\d{2})?\s*(am|a\.m\.|pm|p\.m\.)?\b/i)
  ) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "before", hhmm };
  }

  // =========================
  // 5) AROUND HH:mm (with markers)
  // ES: "tipo 5", "como a las 5", "aprox 5", "alrededor de las 5"
  // EN: "around 5", "about 5", "approx 5", "roughly 5"
  // =========================
  if (
    has(/\b(tipo|como|aprox(?:\.|imadamente)?|aproximad(?:amente)?|alrededor\s+de|por\s+ah[ií])\b/i) ||
    has(/\b(around|about|approx(?:\.|imately)?|roughly)\b/i)
  ) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "around", hhmm };
  }

  // =========================
  // 6) "X y algo" / "X-ish" (without explicit markers)
  // ES: "5 y algo", "5 y pico"
  // EN: "5ish", "5-ish"
  // =========================
  if (
    has(/\b(\d{1,2})\s+y\s+(algo|pico)\b/i) ||
    has(/\b(\d{1,2})\s*-\s*ish\b/i) ||
    has(/\b(\d{1,2})ish\b/i)
  ) {
    const hhmm = extractTimeOnlyToken(t);
    if (hhmm) return { kind: "around", hhmm };
  }

  return null;
}

export function removeOnce(haystack: string, needle: string) {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return haystack;
  return (haystack.slice(0, idx) + " " + haystack.slice(idx + needle.length)).trim();
}

export function cleanNameCandidate(raw: string): string {
  return String(raw || "")
    .replace(/[,\|;]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseEmail(input: string) {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return null;
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw);
  return ok ? raw : null;
}

export function parseFullName(input: string) {
  const raw = String(input || "").trim().replace(/\s+/g, " ");
  if (!raw) return null;

  const parts = raw.split(" ").filter(Boolean);
  if (parts.length < 2) return null;

  const letters = raw.replace(/[^a-zA-ZáéíóúüñÁÉÍÓÚÜÑ\s'-]/g, "").trim();
  if (letters.split(" ").filter(Boolean).length < 2) return null;

  return raw;
}

// "Juan Perez, juan@email.com, 2026-01-21 14:00"
export function parseAllInOne(input: string, timeZone: string, durationMin: number, parseDateTimeExplicit: any) {
  const raw = String(input || "").trim();

  const email = raw.match(EMAIL_REGEX)?.[0]?.toLowerCase() || null;

  const dtToken = extractDateTimeToken(raw);
  const dtParsed = dtToken ? parseDateTimeExplicit(dtToken, timeZone, durationMin) : null;

  const startISO =
    (dtParsed as any)?.error === "PAST_SLOT" ? null : (dtParsed as any)?.startISO || null;
  const endISO =
    (dtParsed as any)?.error === "PAST_SLOT" ? null : (dtParsed as any)?.endISO || null;

  let nameCandidate = raw;
  if (email) nameCandidate = removeOnce(nameCandidate, email);
  if (dtToken) nameCandidate = removeOnce(nameCandidate, dtToken);

  nameCandidate = cleanNameCandidate(nameCandidate);

  nameCandidate = nameCandidate
    .replace(/\b(quiero|quisiera|me gustaria|hola|buenas|buenos|agendar|agenda|cita|consulta|demo|clase|reservar|reserva|turno|appointment|booking|schedule|para|por favor|pls|please)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  nameCandidate = nameCandidate
    .replace(/\b(mi nombre es|soy|me llamo|name is|i am)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const name = nameCandidate ? parseFullName(nameCandidate) : null;

  return { name, email, startISO, endISO };
}

export function parseNameEmailOnly(input: string) {
  const raw = String(input || "").trim();
  const email = raw.match(EMAIL_REGEX)?.[0]?.toLowerCase() || null;

  let nameCandidate = raw;
  if (email) nameCandidate = removeOnce(nameCandidate, email);

  nameCandidate = cleanNameCandidate(nameCandidate)
    .replace(/\b(mi nombre es|soy|me llamo|name is|i am|hola|buenas|buenos|por favor|pls|please)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const name = nameCandidate ? parseFullName(nameCandidate) : null;
  return { name, email };
}

export function buildAskAllMessage(idioma: "es" | "en", purpose?: string | null) {
  const p = purpose ? ` (${purpose})` : "";

  if (idioma === "en") {
    return (
      `Perfect, I can help you with that.\n` +
      `Do me a favor — send me everything in one single message:\n` +
      `your full name, your email, and the date and time you want.\n` +
      `Something like: John Smith, john@email.com, 2026-01-21 14:00`
    );
  }

  return (
    `Perfecto, te ayudo con eso.\n` +
    `Hazme un favor: mándame todo junto en **un solo mensaje**.\n` +
    `Tu nombre completo, tu email, y la fecha y hora que te gustaría.\n` +
    `Algo así como: Juan Pérez, juan@email.com, 2026-01-21 14:00`
  );
}

export function wantsSpecificTime(text: string) {
  const raw = String(text || "").trim();
  const t = normalizeText(raw);

  // 1) Si el usuario solo manda “1-5”, es elección de slot, NO una hora.
  if (/^\s*[1-5]\s*$/.test(raw)) return false;

  // 2) Detecta si el usuario está preguntando por disponibilidad
  // Español e inglés: "tienes", "hay", "puedes", "is", "are", "do you have"
  const asking =
    /\b(tienes|tiene|hay|habra|habrá|puedes|puede|podemos|puedo|disponible|disponibilidad)\b/.test(t) ||
    /\b(is|are|do\s+you\s+have|can\s+you|available)\b/.test(t) ||
    /\?/.test(raw);

  // 3) Detecta hora explícita en cualquier formato reconocido
  const hasTime = !!extractTimeOnlyToken(raw);

  // 4) Detecta expresiones que señalan una hora específica
  // Español: "a las 5", "para las 4", "a la 1"
  // Inglés: "at 5pm", "at 4", "for 3pm"
  const hasAt =
    /\b(a\s+las|a\s+la|para\s+las|para\s+la)\b/.test(t) ||
    /\b(at|for)\b/.test(t);

  // Lógica final: debe haber hora + intención de preguntar por un horario
  return hasTime && (asking || hasAt);
}
