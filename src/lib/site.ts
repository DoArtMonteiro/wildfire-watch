/**
 * Public identity of the deployment, read by the legal pages. The README and
 * the Nominatim User-Agent (src/app/api/reverse-geocode/route.ts) repeat the
 * URL as plain text, so keep them in step if it changes.
 *
 * `maintainer` and `contactUrl` are what the privacy policy names as the data
 * controller and contact channel (GDPR art. 13). Replace them with a legal name
 * and an email address if the project ever becomes commercial.
 */
export const SITE = {
  name: "WildfireWatch",
  url: "https://wildfire-watch.duartemonteiro.workers.dev",
  repositoryUrl: "https://github.com/WhiteBlindness/wildfire-watch",
  contactUrl: "https://github.com/WhiteBlindness/wildfire-watch/issues",
  maintainer: "WhiteBlindness",
  /** Shown as DD/MM/YYYY on every legal page; ISO for the <time> element. */
  legalLastUpdated: "12/10/2026",
  legalLastUpdatedIso: "2026-10-12",
} as const;

export const LEGAL_ROUTES = {
  about: "/sobre",
  privacy: "/privacidade",
  terms: "/termos",
} as const;

export type LegalDocumentId = keyof typeof LEGAL_ROUTES;
