````markdown
# CDAS Phase 3Z-B Validation Result

Date: 2026-06-10

Status: PASS

---

## Validation Summary

The following Phase 3Z-B validation activities were completed successfully:

### Document Registry Validation

Endpoint:

```text
/api/admin/cdas/documents
```

Results:

- Document registry accessible.
- relayhub-overview present.
- relayhub-overview status = active.
- Source object path recorded.
- Source SHA-256 recorded.
- Licence terms assigned.
- Document classifications correct.
- Access classes correct.

Result:

```text
PASS
```

---

### Email Event Registry Validation

Endpoint:

```text
/api/admin/cdas/email-events
```

Results:

- Email events listed successfully.
- Metadata parsed correctly.
- Provider message IDs recorded.
- Verification resend events recorded.
- Failure events preserved.
- Retry events preserved.
- Audit history maintained.

Result:

```text
PASS
```

---

### Email Retry Chain Validation

Validated evidence chain:

```text
Failed Event
↓
Manual Retry
↓
New Sent Event
↓
Original Event Marked Resolved
```

Original failed event:

```text
status = failed
retryable = 1
resolved_at populated
resolved_by = admin_retry
resolution_note populated
```

Retry event:

```text
status = sent
retry_count = 1
retry_of_event_id populated
provider_message_id recorded
```

Results:

- Retry endpoint operational.
- Retry chain preserved.
- Evidence preserved.
- Original failure not overwritten.
- Successful retry creates new event.

Result:

```text
PASS
```

---

### D1 Schema Validation

Validated columns:

```text
retry_of_event_id
retry_count
retryable
next_retry_after
resolved_at
resolved_by
resolution_note
```

Results:

- Schema migration applied successfully.
- Retry state model operational.
- Resolution state model operational.

Result:

```text
PASS
```

---

### Legacy Download Analytics Validation

Endpoint:

```text
/api/admin/downloads
```

Results:

- Download analytics operational.
- Document analytics operational.
- Country analytics operational.
- Source analytics operational.
- Content-type analytics operational.
- Outcome analytics operational.

Result:

```text
PASS
```

---

## Observations

### Download Analytics Referrer Tokens

Current analytics output includes:

```text
/download-requested/?token=...
```

Impact:

- Admin-only visibility.
- No active security issue.
- No CDAS workflow impact.

Recommended future improvement:

```text
Redact tokens from analytics output.
```

Suggested output:

```text
/download-requested/
```

or

```text
download-requested (token redacted)
```

Severity:

```text
LOW
```

Release Blocker:

```text
NO
```

---

## Release Gate Assessment

Completed:

```text
Phase 3A–3F
PASS

Phase 3Y
PASS

Phase 3Z-A
PASS

Phase 3Z-B
PASS
```

Overall CDAS Assessment:

```text
PASS WITH LIMITATIONS
```

---

## Outstanding Items

The following items remain outside the current release scope:

### Resend Webhook Ingestion

- delivered
- bounced
- complained
- deferred

### Analytics Token Redaction

- remove token visibility from analytics outputs

### Payment Workflow Integration

- Square integration
- paid document licensing workflow

### Approval Workflow UI

- restricted document approval process

### Operational Documentation

- operator runbook
- recovery procedures
- rollback procedures
- validation procedures

---

## Recommended Next Phase

```text
Phase 3Z-C
CDAS Operational Runbook & Recovery Procedures
```

Rationale:

The CDAS implementation has now demonstrated:

- reproducible deployment
- auditable document access
- controlled invitation workflows
- licence evidence generation
- controlled download links
- email delivery auditing
- recovery-oriented retry handling

The next highest-value activity is to formalise operational procedures so that CDAS can be:

- operated safely
- recovered safely
- validated repeatedly
- handed to future administrators
- maintained as production infrastructure

---

## Final Decision

Decision:

```text
PASS WITH LIMITATIONS
```

Reviewer:

```text
Andrew Rigg
```

Date:

```text
2026-06-10
```

Next Phase:

```text
3Z-C — CDAS Operational Runbook & Recovery Procedures
```
````
