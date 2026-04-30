//src/lib/appointments/buildServiceSchedulesEditor.ts
import { ServiceScheduleRow } from "./getServiceSchedules";

export type ServiceScheduleEditorItem = {
  service_name: string;
  day_of_week: number;
  times: string[];
};

function normalizeHHMM(value: string): string {
  return String(value || "").slice(0, 5);
}

export function buildServiceSchedulesEditor(
  rows: ServiceScheduleRow[]
): ServiceScheduleEditorItem[] {
  const map = new Map<string, ServiceScheduleEditorItem>();

  for (const row of rows) {
    if (!row.enabled) continue;

    const key = `${row.service_name}::${row.day_of_week}`;

    if (!map.has(key)) {
      map.set(key, {
        service_name: row.service_name,
        day_of_week: row.day_of_week,
        times: [],
      });
    }

    const item = map.get(key)!;
    item.times.push(normalizeHHMM(row.start_time));
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.service_name !== b.service_name) {
      return a.service_name.localeCompare(b.service_name);
    }
    return a.day_of_week - b.day_of_week;
  });
}