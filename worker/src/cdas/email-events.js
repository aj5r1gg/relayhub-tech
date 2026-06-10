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

function retryableFromEmailResult(result) {
  if (result?.sent) return 0;

  const error = cleanText(result?.error).toLowerCase();
  const reason = cleanText(result?.reason).toLowerCase();

  if (result?.skipped) {
    return reason === "cdas_email_disabled" ? 0 : 1;
  }

  const nonRetryableErrors = new Set([
    "recipient_email_missing",
    "download_url_missing",
    "cdas_email_from_missing",
    "resend_api_key_missing",
  ]);

  return nonRetryableErrors.has(error) ? 0 : 1;
}

function nextRetryAfterFromEmailResult(result) {
  if (!retryableFromEmailResult(result)) {
    return null;
  }

  const date = new Date();
  date.setUTCMinutes(date.getUTCMinutes() + 15);

  return date.toISOString();
}

export async function recordCdasEmailEvent(
  env,
  {
    relatedType,
    relatedId,
    emailType,
    recipientEmail,
    subject = null,
    emailResult,
    metadata = null,
  }
) {
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
         metadata_json,
         retry_of_event_id,
         retry_count,
         retryable,
         next_retry_after,
         resolved_at,
         resolved_by,
         resolution_note
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
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
        metadata ? JSON.stringify(metadata) : null,
        cleanText(metadata?.retry_of_event_id || ""),
        Number(metadata?.retry_count || 0),
        retryableFromEmailResult(emailResult),
        nextRetryAfterFromEmailResult(emailResult)
      )
      .run();
  } catch {
    // Email event recording must never break the user workflow.
  }
}