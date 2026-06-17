const SWITCH_NAMES = {
  uploads: "UPLOADS_ENABLED",
  cdasUploads: "CDAS_UPLOADS_ENABLED",
  privateFileUploads: "PRIVATE_FILE_UPLOADS_ENABLED",
  storagePrefixCreation: "STORAGE_PREFIX_CREATION_ENABLED",
  uploadRecovery: "UPLOAD_RECOVERY_ENABLED",
  uploadEvidenceExport: "UPLOAD_EVIDENCE_EXPORT_ENABLED",
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off", "disabled"]);

function cleanText(value) {
  return String(value ?? "").trim();
}

function normaliseSwitchValue(value, defaultValue = true) {
  const text = cleanText(value).toLowerCase();

  if (!text) {
    return Boolean(defaultValue);
  }

  if (TRUE_VALUES.has(text)) {
    return true;
  }

  if (FALSE_VALUES.has(text)) {
    return false;
  }

  return Boolean(defaultValue);
}

function fail(error, message, details = {}) {
  return {
    ok: false,
    error,
    message,
    details,
    warnings: [],
  };
}

function pass(value, warnings = []) {
  return {
    ok: true,
    value,
    warnings,
  };
}

export function readUploadEmergencySwitches(env = {}) {
  const uploadsEnabled = normaliseSwitchValue(
    env[SWITCH_NAMES.uploads],
    true
  );

  return {
    uploads_enabled: uploadsEnabled,

    cdas_uploads_enabled:
      uploadsEnabled &&
      normaliseSwitchValue(env[SWITCH_NAMES.cdasUploads], true),

    private_file_uploads_enabled:
      uploadsEnabled &&
      normaliseSwitchValue(env[SWITCH_NAMES.privateFileUploads], true),

    storage_prefix_creation_enabled:
      uploadsEnabled &&
      normaliseSwitchValue(env[SWITCH_NAMES.storagePrefixCreation], true),

    upload_recovery_enabled:
      normaliseSwitchValue(env[SWITCH_NAMES.uploadRecovery], true),

    upload_evidence_export_enabled:
      normaliseSwitchValue(env[SWITCH_NAMES.uploadEvidenceExport], true),
  };
}

export function getUploadEmergencyStatus(env = {}) {
  const switches = readUploadEmergencySwitches(env);

  const disabled = Object.entries(switches)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  return {
    ok: true,
    switches,
    disabled,
    all_upload_creation_enabled:
      switches.uploads_enabled &&
      switches.cdas_uploads_enabled &&
      switches.private_file_uploads_enabled,
    warnings: disabled.map((name) => ({
      code: `${name}_disabled`,
      message: `Upload policy switch is disabled: ${name}.`,
    })),
  };
}

export function requireUploadsEnabled(env = {}) {
  const switches = readUploadEmergencySwitches(env);

  if (!switches.uploads_enabled) {
    return fail(
      "uploads_disabled",
      "Uploads are temporarily disabled by operator policy. Existing controlled downloads are not affected by this setting.",
      {
        switch: SWITCH_NAMES.uploads,
      }
    );
  }

  return pass({
    switch: SWITCH_NAMES.uploads,
    enabled: true,
  });
}

export function requireCdasUploadsEnabled(env = {}) {
  const uploadsResult = requireUploadsEnabled(env);

  if (!uploadsResult.ok) {
    return uploadsResult;
  }

  const switches = readUploadEmergencySwitches(env);

  if (!switches.cdas_uploads_enabled) {
    return fail(
      "cdas_uploads_disabled",
      "RelayHub document uploads are temporarily disabled. This does not revoke existing licences or existing download links.",
      {
        switch: SWITCH_NAMES.cdasUploads,
      }
    );
  }

  return pass({
    switch: SWITCH_NAMES.cdasUploads,
    enabled: true,
  });
}

export function requirePrivateFileUploadsEnabled(env = {}) {
  const uploadsResult = requireUploadsEnabled(env);

  if (!uploadsResult.ok) {
    return uploadsResult;
  }

  const switches = readUploadEmergencySwitches(env);

  if (!switches.private_file_uploads_enabled) {
    return fail(
      "private_file_uploads_disabled",
      "Private file uploads are temporarily disabled. Existing private file records remain visible for authorised operators.",
      {
        switch: SWITCH_NAMES.privateFileUploads,
      }
    );
  }

  return pass({
    switch: SWITCH_NAMES.privateFileUploads,
    enabled: true,
  });
}

export function requireStoragePrefixCreationEnabled(env = {}) {
  const uploadsResult = requireUploadsEnabled(env);

  if (!uploadsResult.ok) {
    return uploadsResult;
  }

  const switches = readUploadEmergencySwitches(env);

  if (!switches.storage_prefix_creation_enabled) {
    return fail(
      "storage_prefix_creation_disabled",
      "Storage prefix creation is temporarily disabled by operator policy.",
      {
        switch: SWITCH_NAMES.storagePrefixCreation,
      }
    );
  }

  return pass({
    switch: SWITCH_NAMES.storagePrefixCreation,
    enabled: true,
  });
}

export function requireUploadRecoveryEnabled(env = {}) {
  const switches = readUploadEmergencySwitches(env);

  if (!switches.upload_recovery_enabled) {
    return fail(
      "upload_recovery_disabled",
      "Upload recovery actions are temporarily disabled. Read-only upload diagnostics may remain available.",
      {
        switch: SWITCH_NAMES.uploadRecovery,
      }
    );
  }

  return pass({
    switch: SWITCH_NAMES.uploadRecovery,
    enabled: true,
  });
}

export function requireUploadEvidenceExportEnabled(env = {}) {
  const switches = readUploadEmergencySwitches(env);

  if (!switches.upload_evidence_export_enabled) {
    return fail(
      "upload_evidence_export_disabled",
      "Upload evidence export is temporarily disabled. Evidence viewing may remain available.",
      {
        switch: SWITCH_NAMES.uploadEvidenceExport,
      }
    );
  }

  return pass({
    switch: SWITCH_NAMES.uploadEvidenceExport,
    enabled: true,
  });
}

export function requireUploadDomainEnabled(env = {}, domain) {
  const cleanDomain = cleanText(domain);

  if (cleanDomain === "cdas_document") {
    return requireCdasUploadsEnabled(env);
  }

  if (cleanDomain === "private_file") {
    return requirePrivateFileUploadsEnabled(env);
  }

  return fail(
    "upload_domain_unknown",
    "Upload domain is not recognised.",
    {
      domain: cleanDomain,
    }
  );
}

export function buildEmergencySwitchAuditEvent(eventType, options = {}) {
  const cleanEventType = cleanText(eventType);

  if (!cleanEventType) {
    return fail(
      "upload_emergency_event_type_missing",
      "Emergency switch audit event type is required."
    );
  }

  const now = cleanText(options.eventAt || new Date().toISOString());

  return pass({
    event_type: cleanEventType,
    success: Boolean(options.success ?? true),
    switch_name: cleanText(options.switchName),
    previous_value:
      options.previousValue === undefined ? null : Boolean(options.previousValue),
    new_value:
      options.newValue === undefined ? null : Boolean(options.newValue),
    admin_actor: cleanText(options.adminActor || "admin"),
    failure_reason: cleanText(options.failureReason),
    event_at: now,
  });
}

export const uploadEmergencyPolicy = {
  switches: { ...SWITCH_NAMES },
  defaults: {
    uploadsEnabled: true,
    cdasUploadsEnabled: true,
    privateFileUploadsEnabled: true,
    storagePrefixCreationEnabled: true,
    uploadRecoveryEnabled: true,
    uploadEvidenceExportEnabled: true,
  },
  trueValues: Array.from(TRUE_VALUES),
  falseValues: Array.from(FALSE_VALUES),
  existingDownloadsAffectedByUploadDisable: false,
};
