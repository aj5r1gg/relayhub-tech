import catalogue from "../../private-r2-seed/documents/catalogue/documents.json";

export type DocumentAccess = "free" | "paid" | "internal";
export type DocumentCategory = "relayhub" | "private";

export type LicenceType =
  | "free-public-distribution"
  | "personal-use"
  | "commercial-use"
  | "enterprise-redistribution";

export type DocumentCatalogueItem = {
  documentId: string;
  title: string;
  version: string;
  category: DocumentCategory;
  classification: string;
  access: DocumentAccess;
  licenceType: LicenceType;
  price: number;
  currency: string;
  squareItemId?: string;
  sourceObject: string;
  generatedPrefix: string;
  watermark: boolean;
  requiresDownloaderDetails: boolean;
  requiresPayment: boolean;
  active: boolean;
};

const documents = catalogue as Record<string, DocumentCatalogueItem>;

export function getAllDocuments(): DocumentCatalogueItem[] {
  return Object.values(documents).filter((doc) => doc.active);
}

export function getFreeDocuments(): DocumentCatalogueItem[] {
  return getAllDocuments().filter((doc) => doc.access === "free");
}

export function getPaidRelayHubDocuments(): DocumentCatalogueItem[] {
  return getAllDocuments().filter(
    (doc) => doc.access === "paid" && doc.category === "relayhub",
  );
}

export function getPaidPrivateDocuments(): DocumentCatalogueItem[] {
  return getAllDocuments().filter(
    (doc) => doc.access === "paid" && doc.category === "private",
  );
}

export function getDocumentById(documentId: string): DocumentCatalogueItem | null {
  return documents[documentId] ?? null;
}

export function formatDocumentPrice(doc: DocumentCatalogueItem): string {
  if (doc.price === 0) return "Free";

  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: doc.currency || "AUD",
  }).format(doc.price / 100);
}