// @ts-check

import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

const SITE = "https://www.relayhub.tech";

const excludedSitemapPaths = [
  "/access/",
  "/document-access/",
  "/document-access/verify/",
  "/document-download/",
  "/download-requested/",
];

/** @param {string} page */
function shouldIncludeInSitemap(page) {
  const url = new URL(page);

  if (url.pathname.startsWith("/admin/")) {
    return false;
  }

  return !excludedSitemapPaths.some(
    (path) =>
      url.pathname === path ||
      url.pathname.startsWith(path)
  );
}

export default defineConfig({
  site: SITE,

  integrations: [
    sitemap({
      filter: shouldIncludeInSitemap,
    }),
  ],
});
