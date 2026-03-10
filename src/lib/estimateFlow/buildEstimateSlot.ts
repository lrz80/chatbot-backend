// backend/src/lib/estimateFlow/buildEstimateSlot.ts

type BuildEstimateSlotArgs = {
  date: string; // YYYY-MM-DD
  time: string; // 10:30 AM
  durationMinutes?: number;
};

function parseTimeTo24h(time: string) {
  const t = String(time || "").trim().toUpperCase();
  const m = t.match(/^(\d{1,2}):(\d{2})\s?(AM|PM)$/);

  if (!m) throw new Error("invalid_time_format");

  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const ampm = m[3];

  if (ampm === "AM") {
    if (hour === 12) hour = 0;
  } else {
    if (hour !== 12) hour += 12;
  }

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");

  return { hh, mm, hour, minute };
}

function addMinutes(dateTimeLocal: string, minutes: number) {
  const d = new Date(dateTimeLocal);
  d.setMinutes(d.getMinutes() + minutes);

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
}

export function buildEstimateSlot(args: BuildEstimateSlotArgs) {
  const { date, time, durationMinutes = 60 } = args;

  const { hh, mm } = parseTimeTo24h(time);

  const startISO = `${date}T${hh}:${mm}:00`;
  const endISO = addMinutes(startISO, durationMinutes);

  return {
    startISO,
    endISO,
  };
}