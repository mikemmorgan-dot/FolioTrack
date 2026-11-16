// Where one filer sits in a saved annual queue, and how many earlier filings
// are not stored yet. Read-only. person_key is compared exactly.

export function annualQueueSpot({
  queue = [],
  storedKeys = [],
  personKey = '',
} = {}) {
  const want = String(personKey || '');
  const stored = new Set(storedKeys || []);
  const index = (queue || []).findIndex((row) => row?.personKey === want);
  if (index < 0) {
    return { found: false, personKey: want, queueLength: (queue || []).length };
  }
  const row = queue[index];
  let ahead = 0;
  for (let i = 0; i < index; i += 1) {
    if (!stored.has(queue[i]?.filingKey)) ahead += 1;
  }
  return {
    found: true,
    personKey: row.personKey,
    index,
    position: index + 1,
    queueLength: queue.length,
    ahead,
    stored: stored.has(row.filingKey),
    filingKey: row.filingKey || null,
    reportYear: row.reportYear ?? null,
    filedDate: row.filedDate || null,
    filingKind: row.filingKind || null,
    filerStatus: row.filerStatus || null,
  };
}
