export async function getCdasDocumentByRef(env, ref) {
  return env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM documents
     WHERE id = ? OR slug = ?
     LIMIT 1`
  )
    .bind(ref, ref)
    .first();
}

export async function getCdasActiveTerms(env, version) {
  return env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM licence_terms
     WHERE version = ?
       AND status = 'active'
     LIMIT 1`
  )
    .bind(version)
    .first();
}

export async function getCdasEmailDomainPolicy(env, domain) {
  if (!domain) return null;

  return env.RELAYHUB_DB.prepare(
    `SELECT *
     FROM email_domain_policy
     WHERE domain = ?
     LIMIT 1`
  )
    .bind(domain)
    .first();
}

export async function incrementCdasCounter(env, counterName) {
  const now = new Date().toISOString();

  const existing = await env.RELAYHUB_DB.prepare(
    `SELECT current_value
     FROM cdas_counters
     WHERE counter_name = ?
     LIMIT 1`
  )
    .bind(counterName)
    .first();

  if (!existing) {
    await env.RELAYHUB_DB.prepare(
      `INSERT INTO cdas_counters (counter_name, current_value, updated_at)
       VALUES (?, 0, ?)`
    )
      .bind(counterName, now)
      .run();
  }

  await env.RELAYHUB_DB.prepare(
    `UPDATE cdas_counters
     SET current_value = current_value + 1,
         updated_at = ?
     WHERE counter_name = ?`
  )
    .bind(now, counterName)
    .run();

  const updated = await env.RELAYHUB_DB.prepare(
    `SELECT current_value
     FROM cdas_counters
     WHERE counter_name = ?
     LIMIT 1`
  )
    .bind(counterName)
    .first();

  return Number(updated?.current_value || 0);
}

export async function nextCdasLicenceNumber(env) {
  const year = new Date().getUTCFullYear();
  const value = await incrementCdasCounter(env, `licence_${year}`);
  return `RH-LIC-${year}-${String(value).padStart(6, "0")}`;
}

export async function nextCdasDownloadId(env) {
  const year = new Date().getUTCFullYear();
  const value = await incrementCdasCounter(env, `download_${year}`);
  return `RH-DL-${year}-${String(value).padStart(6, "0")}`;
}