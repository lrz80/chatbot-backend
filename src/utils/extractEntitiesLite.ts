// Detecta "pistas" sin normalizar ni consultar nada.
// Meses y días en ES para detectar "20 de septiembre", "este viernes", etc.
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","setiembre","octubre","noviembre","diciembre","ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
const DIAS = ["lunes","martes","miércoles","miercoles","jueves","viernes","sábado","sabado","domingo"];

const HORA_RX = /\b([01]?\d|2[0-3])(:[0-5]\d)?\s?(am|pm)?\b/i;
const FECHA_NUM_RX = /\b([0-3]?\d)[\/\-]([01]?\d)(?:[\/\-](\d{2,4}))?\b/; // 20/09, 20-9-2025
const FECHA_DE_RX = new RegExp(`\\b([0-3]?\\d)\\s*(de)\\s*(${MESES.join("|")})\\b`, "i"); // 20 de septiembre
const RELATIVOS = ["hoy","mañana","pasado mañana","esta semana","este fin de semana","este viernes","próximo","proximo"];

const TOPICOS = ["precio","precios","costo","costos","horario","horarios","ubicación","direccion","dirección","reserva","reservar","cupos","disponible","disponibilidad","instructor"];

export type EntitiesLite = {
  dateLike?: string;
  timeLike?: string;
  dayLike?: string;
  topicLike?: string;
  hasSpecificity: boolean;
};

export function extractEntitiesLite(raw: string): EntitiesLite {
  const text = (raw || "").toLowerCase();

  let dateLike: string | undefined;
  let timeLike: string | undefined;
  let dayLike: string | undefined;
  let topicLike: string | undefined;

  const mHora = text.match(HORA_RX);
  if (mHora) timeLike = mHora[0];

  const mFechaNum = text.match(FECHA_NUM_RX);
  const mFechaDe  = text.match(FECHA_DE_RX);
  if (mFechaDe) dateLike = mFechaDe[0];
  else if (mFechaNum) dateLike = mFechaNum[0];
  else if (RELATIVOS.some(r => text.includes(r))) dateLike = RELATIVOS.find(r => text.includes(r));

  const d = DIAS.find(d => text.includes(d));
  if (d) dayLike = d;

  const t = TOPICOS.find(t => text.includes(t));
  if (t) topicLike = t;

  const hasSpecificity = !!(dateLike || timeLike || dayLike || topicLike);
  return { dateLike, timeLike, dayLike, topicLike, hasSpecificity };
}
