function cleanText(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function randomHex(bytes = 16) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);

  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function makeEmailEventId() {
  return `email_${Date.now().toString(36)}_${randomHex(8)}`;
}

function statusFromEmailResult(result) {
  if (result?.sent) return "sent";
  if (result?.skipped) return "skipped";
  return "failed";
}

export async function recordCdasEmailEvent(env, {
  relatedType,
  relatedId,
  emailType,
  recipientEmail,
  subject = null,
  emailResult,
  metadata = null,
}) {
  try {
    await env.RELAYHUB_DB.prepare(
      `INSERT INTO cdas_email_events (
         id,
         related_type,
         related_id,
         email_type,
         recipient_email,
         provider,
         provider_message_id,
         status,
         error,
         message,
         subject,
         created_at,
         metadata_json
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        makeEmailEventId(),
        cleanText(relatedType),
        cleanText(relatedId),
        cleanText(emailType),
        cleanText(recipientEmail).toLowerCase(),
        cleanText(emailResult?.provider || "resend"),
        cleanText(emailResult?.provider_message_id || ""),
        statusFromEmailResult(emailResult),
        cleanText(emailResult?.error || ""),
        cleanText(emailResult?.message || ""),
        subject ? cleanText(subject) : null,
        nowIso(),
        metadata ? JSON.stringify(metadata) : null
      )
      .run();
  } catch {
    // Email event recording must never break the user workflow.
  }
}