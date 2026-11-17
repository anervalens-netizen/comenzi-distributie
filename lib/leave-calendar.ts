const DAY = 86400000;
export function parseDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error('Selectează o dată validă.');
  const d = new Date(value + 'T00:00:00Z');
  if (
    !Number.isFinite(d.getTime()) ||
    d.toISOString().slice(0, 10) !== value ||
    d.getUTCFullYear() < 2025 ||
    d.getUTCFullYear() > 2100
  )
    throw new Error('Data trebuie să fie între 2025 și 2100.');
  return d;
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
function easter(year: number, calendar: 'orthodox' | 'western') {
  if (calendar === 'orthodox') {
    const a = year % 4,
      b = year % 7,
      c = year % 19,
      d = (19 * c + 15) % 30,
      e = (2 * a + 4 * b - d + 34) % 7;
    const julian = new Date(
      Date.UTC(
        year,
        Math.floor((d + e + 114) / 31) - 1,
        ((d + e + 114) % 31) + 1,
      ),
    );
    return new Date(
      julian.getTime() +
        (Math.floor(year / 100) - Math.floor(year / 400) - 2) * DAY,
    );
  }
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100,
    d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(
    Date.UTC(
      year,
      Math.floor((h + l - 7 * m + 114) / 31) - 1,
      ((h + l - 7 * m + 114) % 31) + 1,
    ),
  );
}
export function holidays(
  year: number,
  calendar: 'orthodox' | 'western' = 'orthodox',
) {
  const set = new Set(
    [
      '01-01',
      '01-02',
      '01-06',
      '01-07',
      '01-24',
      '05-01',
      '06-01',
      '08-15',
      '11-30',
      '12-01',
      '12-25',
      '12-26',
    ].map((x) => year + '-' + x),
  );
  const base = easter(year, calendar);
  for (const n of [-2, 0, 1, 49, 50])
    set.add(iso(new Date(base.getTime() + n * DAY)));
  return set;
}
export function leaveDays(
  start: string,
  end: string,
  calendar: 'orthodox' | 'western' = 'orthodox',
  extra: string[] = [],
) {
  const first = parseDay(start),
    last = parseDay(end),
    span = (last.getTime() - first.getTime()) / DAY;
  if (span < 0 || span > 366)
    throw new Error(
      'Perioada trebuie să fie în ordine și de maximum 367 zile.',
    );
  const excluded = new Set(extra);
  for (
    let year = first.getUTCFullYear();
    year <= last.getUTCFullYear();
    year++
  ) {
    for (const date of holidays(year, calendar)) excluded.add(date);
  }
  const workingDates: string[] = [],
    excludedDates: string[] = [];
  for (let time = first.getTime(); time <= last.getTime(); time += DAY) {
    const day = new Date(time),
      key = iso(day);
    (day.getUTCDay() === 0 || day.getUTCDay() === 6 || excluded.has(key)
      ? excludedDates
      : workingDates
    ).push(key);
  }
  if (!workingDates.length)
    throw new Error('Perioada nu conține zile lucrătoare.');
  return { days: workingDates.length, workingDates, excludedDates };
}
