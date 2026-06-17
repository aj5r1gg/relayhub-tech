const CDAS_DOMAIN = "cdas_document";
const PRIVATE_FILE_DOMAIN = "private_file";

const FILE_FIELD_NAME = "file";

const CDAS_REQUIRED_FIELDS = [
  "title",
  "slug",
  "version",
  "summary",
  "classification",
  "access_class",
  "licence_terms_version",
  "storage_prefix_id",
];

const CDAS_OPTIONAL_FIELDS = [
  "description",
  "notes",
  "client_request_id",
];

const PRIVATE_FILE_REQUIRED_FIELDS = [
  "title",
  "storage_prefix_id",
];

const PRIVATE_FILE_OPTIONAL_FIELDS = [
  "description",
  "owner_label",
  "notes",
  "client_request_id",
];

const FIELD_LIMITS = {
  title: 160,
  slug: 120,
  version: 40,
  summary: 500,
  description: 3000,
  classification: 80,
  access_class: 80,
  licence_terms_version: 120,
  storage_prefix_id: 160,
  owner_label: 160,
  notes: 3000,
  client_request_id: 200,
};

function cleanText(value) {
  return String(value ?? "").trim();
}

function fail(error, message, details = {}) {
  return {
    ok: false,
    error,
    message,
    details,
  };
}

function contentTypeIsMultipart(request) {
  const contentType = request.headers.get("content-type") || "";

  return contentType.toLowerCase().includes("multipart/form-data");
}

function isFileLike(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.name === "string" &&
    typeof value.size === "number"
  );
}

function allowedFieldsForDomain(domain) {
  if (domain === CDAS_DOMAIN) {
    return {
      required: CDAS_REQUIRED_FIELDS,
      optional: CDAS_OPTIONAL_FIELDS,
    };
  }

  if (domain === PRIVATE_FILE_DOMAIN) {
    return {
      required: PRIVATE_FILE_REQUIRED_FIELDS,
      optional: PRIVATE_FILE_OPTIONAL_FIELDS,
    };
  }

  return null;
}

function fieldLimit(fieldName) {
  return FIELD_LIMITS[fieldName] || 1000;
}

export function validateMultipartContentType(request) {
  if (!request || !request.headers) {
    return fail(
      "multipart_request_missing",
      "Upload request is missing."
    );
  }

  if (!contentTypeIsMultipart(request)) {
    return fail(
      "multipart_content_type_required",
      "Upload requests must use multipart/form-data."
    );
  }

  return {
    ok: true,
    value: true,
    warnings: [],
  };
}

export async function readStrictMultipartFormData(request) {
  const contentTypeResult = validateMultipartContentType(request);

  if (!contentTypeResult.ok) {
    return contentTypeResult;
  }

  let formData;

  try {
    formData = await request.formData();
  } catch (error) {
    return fail(
      "multipart_parse_failed",
      "The upload form could not be parsed.",
      {
        reason: error?.message || String(error),
      }
    );
  }

  return {
    ok: true,
    value: formData,
    warnings: [],
  };
}

export function parseStrictUploadFormData(formData, options = {}) {
  const domain = cleanText(options.domain);

  const allowed = allowedFieldsForDomain(domain);

  if (!allowed) {
    return fail(
      "multipart_invalid_upload_domain",
      "Upload domain is not recognised.",
      { domain }
    );
  }

  if (!formData || typeof formData.entries !== "function") {
    return fail(
      "multipart_formdata_missing",
      "Upload form data is missing."
    );
  }

  const allowedFieldNames = new Set([
    FILE_FIELD_NAME,
    ...allowed.required,
    ...allowed.optional,
  ]);

  const seenTextFields = new Map();
  const fields = {};
  const files = [];
  const unexpectedFields = [];
  const duplicateFields = [];
  const unexpectedFileFields = [];

  for (const [name, value] of formData.entries()) {
    const fieldName = cleanText(name);

    if (!allowedFieldNames.has(fieldName)) {
      unexpectedFields.push(fieldName);
      continue;
    }

    if (isFileLike(value)) {
      if (fieldName !== FILE_FIELD_NAME) {
        unexpectedFileFields.push(fieldName);
        continue;
      }

      files.push(value);
      continue;
    }

    if (fieldName === FILE_FIELD_NAME) {
      return fail(
        "multipart_file_field_not_file",
        "The file field must contain an uploaded file."
      );
    }

    if (seenTextFields.has(fieldName)) {
      duplicateFields.push(fieldName);
      continue;
    }

    seenTextFields.set(fieldName, true);
    fields[fieldName] = cleanText(value);
  }

  if (unexpectedFields.length) {
    return fail(
      "multipart_unexpected_field",
      "The upload form contains an unexpected field.",
      {
        fields: unexpectedFields,
      }
    );
  }

  if (unexpectedFileFields.length) {
    return fail(
      "multipart_unexpected_file_field",
      "The upload form contains an unexpected file field.",
      {
        fields: unexpectedFileFields,
      }
    );
  }

  if (duplicateFields.length) {
    return fail(
      "multipart_duplicate_field",
      "The upload form contains a duplicated metadata field.",
      {
        fields: duplicateFields,
      }
    );
  }

  if (!files.length) {
    return fail(
      "multipart_file_missing",
      "A single file field named file is required."
    );
  }

  if (files.length > 1) {
    return fail(
      "multipart_multiple_files",
      "Only one uploaded file is allowed."
    );
  }

  const file = files[0];

  if (!isFileLike(file)) {
    return fail(
      "multipart_file_invalid",
      "The uploaded file is invalid."
    );
  }

  if (file.size <= 0) {
    return fail(
      "multipart_file_empty",
      "The uploaded file is empty.",
      {
        size: file.size,
      }
    );
  }

  const missingFields = allowed.required.filter((fieldName) => {
    return !cleanText(fields[fieldName]);
  });

  if (missingFields.length) {
    return fail(
      "multipart_required_field_missing",
      "The upload form is missing required metadata.",
      {
        fields: missingFields,
      }
    );
  }

  const overLimitFields = [];

  for (const [fieldName, value] of Object.entries(fields)) {
    const limit = fieldLimit(fieldName);

    if (String(value).length > limit) {
      overLimitFields.push({
        field: fieldName,
        length: String(value).length,
        max_length: limit,
      });
    }
  }

  if (overLimitFields.length) {
    return fail(
      "multipart_field_too_long",
      "One or more upload metadata fields are too long.",
      {
        fields: overLimitFields,
      }
    );
  }

  return {
    ok: true,
    value: {
      domain,
      fields,
      file,
      file_metadata: {
        original_filename: file.name || "",
        mime_type: file.type || "",
        size: file.size,
      },
    },
    warnings: [],
  };
}

export async function parseStrictUploadRequest(request, options = {}) {
  const formResult = await readStrictMultipartFormData(request);

  if (!formResult.ok) {
    return formResult;
  }

  return parseStrictUploadFormData(formResult.value, options);
}

export function requiredUploadFieldsForDomain(domain) {
  const allowed = allowedFieldsForDomain(cleanText(domain));

  if (!allowed) {
    return [];
  }

  return [...allowed.required];
}

export function optionalUploadFieldsForDomain(domain) {
  const allowed = allowedFieldsForDomain(cleanText(domain));

  if (!allowed) {
    return [];
  }

  return [...allowed.optional];
}

export const uploadMultipartPolicy = {
  fileFieldName: FILE_FIELD_NAME,
  domains: {
    cdas_document: {
      requiredFields: [...CDAS_REQUIRED_FIELDS],
      optionalFields: [...CDAS_OPTIONAL_FIELDS],
    },
    private_file: {
      requiredFields: [...PRIVATE_FILE_REQUIRED_FIELDS],
      optionalFields: [...PRIVATE_FILE_OPTIONAL_FIELDS],
    },
  },
  fieldLimits: { ...FIELD_LIMITS },
  acceptedContentType: "multipart/form-data",
};
