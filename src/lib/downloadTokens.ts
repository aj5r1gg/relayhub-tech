export type DownloadRequestType = "free" | "paid";

export type DownloadRecord = {
  downloadId: string;
  token: string;
  documentId: string;
  documentVersion: string;
  type: DownloadRequestType;
  firstName: string;
  lastName: string;
  email: string;
  orderNumber?: string;
  generatedObjectKey?: string;
  createdAt: string;
  expiresAt: string;
  maxDownloads: number;
  downloadCount: number;
};

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function createDownloadId(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const random = randomHex(4);

  return `RH-DL-${yyyy}-${random}`;
}

export function createDownloadToken(): string {
  return randomToken(32);
}

export function createExpiry(hours = 48): string {
  const expires = new Date(Date.now() + hours * 60 * 60 * 1000);
  return expires.toISOString();
}

export function createFreeDownloadRecord(input: {
  documentId: string;
  documentVersion: string;
  firstName: string;
  lastName: string;
  email: string;
}): DownloadRecord {
  return {
    downloadId: createDownloadId(),
    token: createDownloadToken(),
    documentId: input.documentId,
    documentVersion: input.documentVersion,
    type: "free",
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    createdAt: new Date().toISOString(),
    expiresAt: createExpiry(48),
    maxDownloads: 3,
    downloadCount: 0,
  };
}