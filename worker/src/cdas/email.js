const RESEND_EMAIL_ENDPOINT = "https://api.resend.com/emails";

function cleanText(value) {
  return String(value ?? "").trim();
}

function isEmailEnabled(env) {
  return cleanText(env.CDAS_EMAIL_ENABLED).toLowerCase() === "true";
}

function getPublicBaseUrl(env) {
  return cleanText(env.CDAS_PUBLIC_BASE_URL) || "https://www.relayhub.tech";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normaliseEmail(value) {
  return cleanText(value).toLowerCase();
}

function buildVerificationUrl(env, requestId, token) {
  const baseUrl = getPublicBaseUrl(env).replace(/\/+$/, "");

  const params = new URLSearchParams({
    request_id: requestId,
    token,
  });

  return `${baseUrl}/document-access/verify?${params.toString()}`;
}

function buildVerificationTextEmail(payload) {
  return [
    "RelayHub document access verification",
    "",
    `Document: ${payload.documentTitle}`,
    `Document ID: ${payload.documentId}`,
    `Recipient: ${payload.recipientEmail}`,
    "",
    "Please verify your email address to continue the document access process:",
    "",
    payload.verificationUrl,
    "",
    "This verification link is time-limited. If you did not request this document, you can ignore this email.",
    "",
    "RelayHub",
  ].join("\n");
}

function buildVerificationHtmlEmail(payload) {
  const documentTitle = escapeHtml(payload.documentTitle);
  const documentId = escapeHtml(payload.documentId);
  const recipientEmail = escapeHtml(payload.recipientEmail);
  const verificationUrl = escapeHtml(payload.verificationUrl);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>RelayHub document access verification</title>
  </head>
  <body style="margin:0;padding:0;background:#f8fafc;color:#0f172a;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 18px;">
                <p style="margin:0 0 8px;color:#0284c7;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">
                  RelayHub Document Access
                </p>
                <h1 style="margin:0;color:#0f172a;font-size:28px;line-height:1.15;">
                  Verify your email address
                </h1>
                <p style="margin:16px 0 0;color:#475569;font-size:16px;line-height:1.6;">
                  Please verify your email address so RelayHub can continue the controlled document access process.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 8px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
                  <tr>
                    <td style="padding:16px;">
                      <p style="margin:0 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Document</p>
                      <p style="margin:0;color:#0f172a;font-size:16px;font-weight:700;">${documentTitle}</p>
                      <p style="margin:6px 0 0;color:#64748b;font-size:14px;">${documentId}</p>

                      <p style="margin:18px 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Recipient</p>
                      <p style="margin:0;color:#0f172a;font-size:15px;">${recipientEmail}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 28px;">
                <a href="${verificationUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;border-radius:999px;padding:14px 20px;">
                  Verify email address
                </a>

                <p style="margin:18px 0 0;color:#64748b;font-size:14px;line-height:1.6;">
                  If the button does not work, copy and paste this link into your browser:
                </p>

                <p style="margin:8px 0 0;color:#334155;font-size:13px;line-height:1.6;word-break:break-all;">
                  ${verificationUrl}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 28px 28px;border-top:1px solid #e2e8f0;">
                <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">
                  This verification link is time-limited. If you did not request this document, you can ignore this email.
                </p>
                <p style="margin:14px 0 0;color:#64748b;font-size:13px;">
                  RelayHub
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function buildDownloadLinkTextEmail(payload) {
  return [
    "RelayHub controlled document download",
    "",
    `Document: ${payload.documentTitle}`,
    `Document ID: ${payload.documentId}`,
    `Licence: ${payload.licenceNumber}`,
    `Recipient: ${payload.recipientEmail}`,
    "",
    "Your controlled download link is ready:",
    "",
    payload.downloadUrl,
    "",
    "Opening this page does not consume the download. The download is consumed only when you press the final download button.",
    "",
    `This link expires at: ${payload.expiresAt}`,
    "",
    "RelayHub",
  ].join("\n");
}

function buildDownloadLinkHtmlEmail(payload) {
  const documentTitle = escapeHtml(payload.documentTitle);
  const documentId = escapeHtml(payload.documentId);
  const licenceNumber = escapeHtml(payload.licenceNumber);
  const recipientEmail = escapeHtml(payload.recipientEmail);
  const downloadUrl = escapeHtml(payload.downloadUrl);
  const expiresAt = escapeHtml(payload.expiresAt);

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>RelayHub controlled document download</title>
  </head>
  <body style="margin:0;padding:0;background:#f8fafc;color:#0f172a;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 18px;">
                <p style="margin:0 0 8px;color:#0284c7;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">
                  RelayHub Document Access
                </p>
                <h1 style="margin:0;color:#0f172a;font-size:28px;line-height:1.15;">
                  Your controlled download is ready
                </h1>
                <p style="margin:16px 0 0;color:#475569;font-size:16px;line-height:1.6;">
                  RelayHub has prepared a controlled download page for your licensed document.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 8px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
                  <tr>
                    <td style="padding:16px;">
                      <p style="margin:0 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Document</p>
                      <p style="margin:0;color:#0f172a;font-size:16px;font-weight:700;">${documentTitle}</p>
                      <p style="margin:6px 0 0;color:#64748b;font-size:14px;">${documentId}</p>

                      <p style="margin:18px 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Licence</p>
                      <p style="margin:0;color:#0f172a;font-size:15px;">${licenceNumber}</p>

                      <p style="margin:18px 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Recipient</p>
                      <p style="margin:0;color:#0f172a;font-size:15px;">${recipientEmail}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 28px;">
                <a href="${downloadUrl}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;font-weight:700;border-radius:999px;padding:14px 20px;">
                  Open download page
                </a>

                <p style="margin:18px 0 0;color:#64748b;font-size:14px;line-height:1.6;">
                  Opening the page does not consume the download. The download is consumed only when you press the final download button.
                </p>

                <p style="margin:12px 0 0;color:#64748b;font-size:14px;line-height:1.6;">
                  Expires at: ${expiresAt}
                </p>

                <p style="margin:18px 0 0;color:#64748b;font-size:14px;line-height:1.6;">
                  If the button does not work, copy and paste this link into your browser:
                </p>

                <p style="margin:8px 0 0;color:#334155;font-size:13px;line-height:1.6;word-break:break-all;">
                  ${downloadUrl}
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 28px 28px;border-top:1px solid #e2e8f0;">
                <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">
                  This is a controlled, single-use document access link. Do not forward it unless RelayHub has explicitly authorised redistribution.
                </p>
                <p style="margin:14px 0 0;color:#64748b;font-size:13px;">
                  RelayHub
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}


function buildDownloadLinkRevocationNoticeTextEmail(payload) {
  return [
    "RelayHub controlled download link notice",
    "",
    `Document: ${payload.documentTitle}`,
    `Document ID: ${payload.documentId}`,
    `Licence: ${payload.licenceNumber}`,
    `Download reference: ${payload.downloadReference}`,
    `Recipient: ${payload.recipientEmail}`,
    "",
    "A controlled download link associated with this licence has been revoked or disabled by RelayHub.",
    "",
    "This notice relates to the controlled download link only. It does not mean that your document licence has been revoked unless RelayHub has separately notified you of that.",
    "",
    payload.reason
      ? `Reason or operator note: ${payload.reason}`
      : "Reason or operator note: not specified.",
    "",
    "If a replacement download link is required, RelayHub may issue one separately after review.",
    "",
    "RelayHub",
  ].join("\n");
}

function buildDownloadLinkRevocationNoticeHtmlEmail(payload) {
  const documentTitle = escapeHtml(payload.documentTitle);
  const documentId = escapeHtml(payload.documentId);
  const licenceNumber = escapeHtml(payload.licenceNumber);
  const downloadReference = escapeHtml(payload.downloadReference);
  const recipientEmail = escapeHtml(payload.recipientEmail);
  const reason = escapeHtml(payload.reason || "Not specified.");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>RelayHub controlled download link notice</title>
  </head>
  <body style="margin:0;padding:0;background:#f8fafc;color:#0f172a;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:28px 28px 18px;">
                <p style="margin:0 0 8px;color:#b45309;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">
                  RelayHub Document Access
                </p>
                <h1 style="margin:0;color:#0f172a;font-size:28px;line-height:1.15;">
                  Controlled download link revoked
                </h1>
                <p style="margin:16px 0 0;color:#475569;font-size:16px;line-height:1.6;">
                  A controlled download link associated with your RelayHub document licence has been revoked or disabled.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 28px 8px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
                  <tr>
                    <td style="padding:16px;">
                      <p style="margin:0 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Document</p>
                      <p style="margin:0;color:#0f172a;font-size:16px;font-weight:700;">${documentTitle}</p>
                      <p style="margin:6px 0 0;color:#64748b;font-size:14px;">${documentId}</p>

                      <p style="margin:18px 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Licence</p>
                      <p style="margin:0;color:#0f172a;font-size:15px;">${licenceNumber}</p>

                      <p style="margin:18px 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Download reference</p>
                      <p style="margin:0;color:#0f172a;font-size:15px;">${downloadReference}</p>

                      <p style="margin:18px 0 8px;color:#64748b;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;">Recipient</p>
                      <p style="margin:0;color:#0f172a;font-size:15px;">${recipientEmail}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:20px 28px;">
                <p style="margin:0;color:#475569;font-size:15px;line-height:1.6;">
                  This notice relates to the controlled download link only. It does <strong>not</strong> mean that your document licence has been revoked unless RelayHub has separately notified you of that.
                </p>

                <p style="margin:16px 0 0;color:#475569;font-size:15px;line-height:1.6;">
                  Reason or operator note: ${reason}
                </p>

                <p style="margin:16px 0 0;color:#475569;font-size:15px;line-height:1.6;">
                  If a replacement download link is required, RelayHub may issue one separately after review.
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:18px 28px 28px;border-top:1px solid #e2e8f0;">
                <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">
                  RelayHub controls document access links separately from document licences. Link revocation is not the same thing as licence revocation.
                </p>
                <p style="margin:14px 0 0;color:#64748b;font-size:13px;">
                  RelayHub
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

async function sendResendEmail(env, email) {
  if (!isEmailEnabled(env)) {
    return {
      ok: true,
      sent: false,
      skipped: true,
      provider: "resend",
      reason: "cdas_email_disabled",
      message: "CDAS email sending is disabled.",
    };
  }

  if (!env.RESEND_API_KEY) {
    return {
      ok: false,
      sent: false,
      provider: "resend",
      error: "resend_api_key_missing",
      message: "RESEND_API_KEY is not configured.",
    };
  }

  const from = cleanText(env.CDAS_EMAIL_FROM);
  const replyTo = cleanText(env.CDAS_EMAIL_REPLY_TO);

  if (!from) {
    return {
      ok: false,
      sent: false,
      provider: "resend",
      error: "cdas_email_from_missing",
      message: "CDAS_EMAIL_FROM is not configured.",
    };
  }

  const body = {
    from,
    to: Array.isArray(email.to) ? email.to : [email.to],
    subject: email.subject,
    html: email.html,
    text: email.text,
  };

  if (replyTo) {
    body.reply_to = replyTo;
  }

  const response = await fetch(RESEND_EMAIL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      sent: false,
      provider: "resend",
      status: response.status,
      error: data?.name || data?.error || "resend_send_failed",
      message:
        data?.message ||
        data?.error ||
        "Resend rejected the email send request.",
      provider_response: data,
    };
  }

  return {
    ok: true,
    sent: true,
    provider: "resend",
    status: response.status,
    provider_message_id: data?.id || null,
    provider_response: data,
  };
}

export async function sendCdasVerificationEmail(env, payload) {
  const recipientEmail = normaliseEmail(payload.recipientEmail);

  if (!recipientEmail) {
    return {
      ok: false,
      sent: false,
      error: "recipient_email_missing",
      message: "Recipient email is required.",
    };
  }

  const verificationUrl =
    payload.verificationUrl ||
    buildVerificationUrl(env, payload.requestId, payload.verificationToken);

  const emailPayload = {
    documentTitle: cleanText(payload.documentTitle) || "RelayHub document",
    documentId: cleanText(payload.documentId) || "unknown-document",
    recipientEmail,
    verificationUrl,
  };

  const subject = `Verify your email for ${emailPayload.documentTitle}`;

  return await sendResendEmail(env, {
    to: recipientEmail,
    subject,
    html: buildVerificationHtmlEmail(emailPayload),
    text: buildVerificationTextEmail(emailPayload),
  });
}

export async function sendCdasDownloadLinkEmail(env, payload) {
  const recipientEmail = normaliseEmail(payload.recipientEmail);

  if (!recipientEmail) {
    return {
      ok: false,
      sent: false,
      error: "recipient_email_missing",
      message: "Recipient email is required.",
    };
  }

  const emailPayload = {
    documentTitle: cleanText(payload.documentTitle) || "RelayHub document",
    documentId: cleanText(payload.documentId) || "unknown-document",
    licenceNumber: cleanText(payload.licenceNumber) || "unknown-licence",
    recipientEmail,
    downloadUrl: cleanText(payload.downloadUrl),
    expiresAt: cleanText(payload.expiresAt) || "Not specified",
  };

  if (!emailPayload.downloadUrl) {
    return {
      ok: false,
      sent: false,
      error: "download_url_missing",
      message: "Download URL is required.",
    };
  }

  return await sendResendEmail(env, {
    to: recipientEmail,
    subject: `Your RelayHub download is ready: ${emailPayload.documentTitle}`,
    html: buildDownloadLinkHtmlEmail(emailPayload),
    text: buildDownloadLinkTextEmail(emailPayload),
  });
}
export async function sendCdasDownloadLinkRevocationNoticeEmail(env, payload) {
  const recipientEmail = normaliseEmail(payload.recipientEmail);

  if (!recipientEmail) {
    return {
      ok: false,
      sent: false,
      error: "recipient_email_missing",
      message: "Recipient email is required.",
    };
  }

  const emailPayload = {
    documentTitle: cleanText(payload.documentTitle) || "RelayHub document",
    documentId: cleanText(payload.documentId) || "unknown-document",
    licenceNumber: cleanText(payload.licenceNumber) || "unknown-licence",
    downloadReference: cleanText(payload.downloadReference) || "unknown-download-reference",
    recipientEmail,
    reason: cleanText(payload.reason),
  };

  return await sendResendEmail(env, {
    to: recipientEmail,
    subject: `Controlled download link revoked: ${emailPayload.documentTitle}`,
    html: buildDownloadLinkRevocationNoticeHtmlEmail(emailPayload),
    text: buildDownloadLinkRevocationNoticeTextEmail(emailPayload),
  });
}
