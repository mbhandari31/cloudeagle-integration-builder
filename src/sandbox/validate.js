// Checks the records a connector returned and builds the user table.
const DAY = 864e5;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

const isEmail = (v) => typeof v === "string" && EMAIL.test(v);
const isIso = (v) => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));

export function validateRecords({ users = [], usage = [] }, { now = new Date() } = {}) {
  const errors = [];
  const warnings = [];

  if (users.length === 0) errors.push("No users found");
  const missing = users.filter((u) => !isEmail(u?.email)).length;
  if (missing) errors.push(`${missing} users missing a valid email`);
  if (usage.some((e) => !isIso(e?.at))) errors.push("Usage dates not ISO 8601");

  const last = new Map(); // lower-cased email -> max ms
  const usageEmails = new Set();
  for (const e of usage) {
    if (typeof e?.email !== "string") continue;
    const key = e.email.toLowerCase();
    usageEmails.add(key);
    if (!isIso(e.at)) continue;
    const t = Date.parse(e.at);
    if (!(last.get(key) >= t)) last.set(key, t);
  }

  const userEmails = new Set(users.filter((u) => isEmail(u?.email)).map((u) => u.email.toLowerCase()));
  const unknown = [...usageEmails].filter((e) => !userEmails.has(e)).length;
  if (unknown) {
    const msg = `Usage refers to ${unknown} emails that are not users`;
    (unknown / usageEmails.size <= 0.1 ? warnings : errors).push(msg);
  }

  const cutoff = +new Date(now) - 90 * DAY;
  const rows = users
    .map((u) => {
      const t = typeof u?.email === "string" ? last.get(u.email.toLowerCase()) : undefined;
      return {
        email: u?.email ?? null,
        name: u?.name ?? null,
        role: u?.role ?? null,
        lastActive: t === undefined ? null : new Date(t).toISOString(),
      };
    })
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")));

  const stats = {
    users: users.length,
    withActivity: rows.filter((r) => r.lastActive !== null).length,
    inactive90d: rows.filter((r) => r.lastActive === null || Date.parse(r.lastActive) < cutoff).length,
    unknownUsageEmails: unknown,
  };
  return { ok: errors.length === 0, errors, warnings, stats, rows };
}
