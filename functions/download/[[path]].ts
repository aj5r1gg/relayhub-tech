/// <reference types="../../worker-configuration" />

interface Env {
  RELAYHUB_DOWNLOADS: R2Bucket;
  DOWNLOAD_ANALYTICS?: AnalyticsEngineDataset;
}

const ALLOWED_PREFIXES = ["docs/"];
const ALLOWED_EXTENSIONS = [".pdf", ".zip", ".txt", ".sha256", ".sig"];

function normalisePath(path: unknown): string {
  const key = Array.isArray(path) ? path.join("/") : String(path ?? "");

  try {
    return decodeURIComponent(key).replace(/^\/+/, "");
  } catch {
    return "";
  }
}

function isSafeKey(key: string): boolean {
  if (!key) return false;
  if (key.includes("..")) return false;
  if (key.includes("\\")) return false;
  if (key.startsWith("/")) return false;
  if (key.includes("//")) return false;

  const hasAllowedPrefix = ALLOWED_PREFIXES.some((prefix) =>
    key.startsWith(prefix)
  );

  const hasAllowedExtension = ALLOWED_EXTENSIONS.some((extension) =>
    key.toLowerCase().endsWith(extension)
  );

  return hasAllowedPrefix && hasAllowedExtension;
}

function safeFilename(key: string): string {
  const raw = key.split("/").pop() || "download";
  return raw.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const request = context.request;
  const started = Date.now();

  const key = normalisePath(context.params.path);

  if (!isSafeKey(key)) {
    return new Response("Invalid or disallowed download path", {
      status: 400,
    });
  }

  const object = await context.env.RELAYHUB_DOWNLOADS.get(key);

  if (!object) {
    return new Response("Download not found", {
      status: 404,
    });
  }

  const url = new URL(request.url);
  const durationMs = Date.now() - started;

  context.env.DOWNLOAD_ANALYTICS?.writeDataPoint({
    blobs: [
      key,
      request.headers.get("cf-ipcountry") ?? "unknown",
      url.searchParams.get("utm_source") ?? "direct",
      url.searchParams.get("utm_campaign") ?? "none",
      request.headers.get("referer") ?? "none",
      object.httpMetadata?.contentType ?? "unknown",
    ],
    doubles: [1, object.size, durationMs],
    indexes: [key],
  });

  const headers = new Headers();

  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=3600");
  headers.set("x-content-type-options", "nosniff");
  headers.set(
    "content-disposition",
    `attachment; filename="${safeFilename(key)}"`
  );

  return new Response(object.body, {
    status: 200,
    headers,
  });
};