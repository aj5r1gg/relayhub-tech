function cleanText(value) {
  return String(value ?? "").trim();
}

function slugify(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function safeFilename(value) {
  return cleanText(value)
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function buildCdasGeneratedPdfObjectKey({
  licence,
  document,
}) {
  const documentSlug = slugify(
    document?.slug ||
    document?.id ||
    licence?.document_id ||
    "document",
  );

  const versionSlug = slugify(
    licence?.document_version ||
    document?.version ||
    "version",
  );

  const licenceSlug = slugify(
    licence?.licence_number ||
    licence?.id ||
    "licence",
  );

  return [
    "docs",
    "generated",
    "cdas",
    documentSlug,
    versionSlug,
    `${licenceSlug}.pdf`,
  ].join("/");
}

export function buildCdasGeneratedPdfFilename({
  licence,
  document,
}) {
  const title = safeFilename(
    document?.title ||
    licence?.document_id ||
    "RelayHub-Document",
  );

  const version = safeFilename(
    licence?.document_version ||
    document?.version ||
    "version",
  );

  const licenceNumber = safeFilename(
    licence?.licence_number ||
    licence?.id ||
    "licence",
  );

  return `${title}-v${version}-${licenceNumber}.pdf`;
}