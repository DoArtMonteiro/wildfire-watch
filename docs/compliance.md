# Legal, compliance and third-party review

Engineering due diligence, not legal advice. It records what WildfireWatch does about each obligation that could plausibly apply, what was checked, and what is left for the owner to decide. It does not claim that the site is fully compliant with any law, and it is not a legal certification. Last reviewed on 12/10/2026.

**Context.** WildfireWatch is a free, non-commercial personal portfolio project operated from Portugal. It has no accounts, forms, payments, reviews, advertising or analytics. It stores two interface preferences in the visitor's browser. It is hosted on Cloudflare Workers.

## Compliance matrix

| Item | Status | Evidence or reason |
|---|---|---|
| Colour contrast | IMPLEMENTED | Secondary text never below 60 % opacity (static test); axe finds no contrast violations in the overview, detail and legal views (E2E). |
| Alt text / non-text content | IMPLEMENTED | Decorative SVGs are `aria-hidden` (static test). The map canvas is graphical; its accessible alternative is the panel's list of the strongest detections. |
| Accessibility (WCAG 2.2 AA target) | IMPLEMENTED | Automated axe checks against WCAG 2.0–2.2 A/AA pass on three views (E2E). Automated checks do not cover everything; no full manual screen-reader audit has been done. |
| Keyboard accessibility | IMPLEMENTED | Skip link to the panel, visible focus, keyboard selection of detections without the map (E2E). |
| Clear button labels | IMPLEMENTED | Every control has an accessible name that includes its visible text (static test, axe). |
| Privacy policy | IMPLEMENTED | `/privacidade` in PT and EN: controller, data, third parties, legal basis, storage, rights, CNPD complaint. The controller-identity question is below. |
| Terms and conditions | IMPLEMENTED | `/termos`: nature of the information, acceptable use, intellectual property, liability. |
| Cookie / storage policy | IMPLEMENTED | Lists the two `localStorage` items, purpose and duration. |
| Cookie consent | NOT APPLICABLE | No cookies. The two preferences are stored only when the visitor chooses them, for a service they asked for, which is exempt from consent under Lei 41/2004, art. 5. A consent banner would be needed before any analytics or advertising. |
| Tracking disclosure | IMPLEMENTED | No trackers (static test forbids them). Direct browser requests to CARTO, Esri and Open-Meteo are disclosed with what each receives. |
| Form consent | NOT APPLICABLE | The site has no forms. Contact goes through GitHub issues. |
| Data minimisation | IMPLEMENTED | No visitor identifiers are used for rate limiting; coordinates are rounded before reaching Nominatim and OpenAQ; logs record error names, not URLs or messages; operator alerts and the daily summary carry no visitor data; the street address of ANEPC occurrences is never stored or served. |
| Operator / contact information | OWNER DECISION | The policy names the maintainer by the pseudonym "WhiteBlindness" and gives GitHub issues as the contact. GDPR art. 13(1)(a) asks for the controller's identity and contact details. The owner has decided to keep the pseudonymous identity and accepts the residual risk; see owner decisions. |
| Local laws | IMPLEMENTED | GDPR and Lei 58/2019 (privacy notice), Lei 41/2004 (storage), unofficial-source notice with 112. DL 7/2004 identification duties and the Livro de Reclamações do not apply to a non-commercial site with no consumer service (see research). |
| Third-party services / embeds | IMPLEMENTED | No iframes or third-party scripts. Third-party requests are listed in the policy and enforced by the Content Security Policy. Provider-specific findings are below. |
| Copyright, image and data rights | IMPLEMENTED | Attributions for NASA FIRMS, ANEPC (CC BY 4.0, with the changes made), CARTO and OpenStreetMap, Esri, Nominatim, Open-Meteo (CC BY 4.0), OpenAQ, news publishers and fonts on `/sobre`; the ANEPC attribution is repeated in every occurrence panel. News shows headline and link only. The ANEPC licensing question is below. |
| Unsupported product claims | IMPLEMENTED | Detections are no longer called active fires or graded by severity; operational status comes only from ANEPC, labelled "reported by ANEPC", and is "unknown" everywhere else; links between sources follow published fixed rules, with no probability presented as fact; the overview no longer extrapolates a burned area; the per-detection estimate states its method; the news note no longer claims coverage starts at the first detection. A static test keeps "severity" out of the model and copy. |
| Fake reviews | NOT APPLICABLE | No reviews or testimonials. |
| Refund policy | NOT APPLICABLE | Nothing is sold. |
| Business identity / details | NOT APPLICABLE | No economic activity today. Becomes required with advertising or paid services (see commercialisation). |

## Legal research summary

Sources were searched on 02/10/2026. Several official sites (EUR-Lex, Diário da República, CNPD) could not be fetched directly from the research environment, so some article numbers rest on secondary summaries; they are marked *to verify*.

| Topic | Finding | Confidence |
|---|---|---|
| GDPR applies? | Yes. IP addresses in hosting logs are personal data (CJEU C-582/14 *Breyer*; recital 30). The household exemption does not cover publication to an indefinite audience (C-101/01 *Lindqvist*). | High |
| Controller identity (art. 13(1)(a)) | The notice must give "the identity and the contact details of the controller". No authority was found accepting a pseudonym alone; Article 29 WP guidelines (WP260 rev.01, endorsed by the EDPB) expect easy identification. An email address suffices; a postal address is not required by the text. | Medium |
| Legal basis for logs | Legitimate interest in operating and securing the site (art. 6(1)(f), recital 49). Cloudflare acts as processor under its DPA. | Medium-high |
| Storage on the device (Lei 41/2004, art. 5, as amended by Lei 46/2012) | Covers `localStorage`. Storage strictly necessary for a service the user explicitly requested is exempt from consent; UI preferences set by the user fit that best when disclosed. | Medium-high |
| Lei 58/2019 | Applies as the GDPR implementing law; nothing specific for a small site beyond the sanctions regime (article numbers *to verify*). | Medium-low |
| Third-party tile and weather requests | A site that makes the browser contact a third party co-determines that transmission (CJEU C-40/17 *Fashion ID*) and must disclose it; consent is needed only if the third party stores or reads data on the device. | Medium |
| DL 7/2004, art. 10 (provider identification) | Applies to information-society services provided for remuneration or in an economic activity; probably not to a free, ad-free portfolio site. Would apply with advertising: name, address, email and tax number. | Medium-low |
| Livro de Reclamações (DL 156/2005, DL 74/2017) | Does not apply: no goods or services supplied to consumers. | Medium-high |
| Accessibility law | The European Accessibility Act (Directive 2019/882, DL 82/2022) covers listed services such as e-commerce and banking; DL 83/2018 covers public bodies. Neither applies. WCAG 2.2 AA is a voluntary engineering target. | High |
| Databases and copyright | Showing individual detections is low risk under the database right (Directive 96/9/EC); FIRMS data is openly shared; headline-and-link news display falls within the press publishers' right exceptions (Directive 2019/790, art. 15; DL 47/2023). | Medium-high |
| Emergency notice | No mandatory wording found; the existing "unofficial, call 112" notice follows good practice (compare fogos.pt). | Medium |

## Third-party services

| Service | Used for | Where | Auth | Practical limits | Current non-commercial use | Material finding |
|---|---|---|---|---|---|---|
| NASA FIRMS (VIIRS_SNPP_NRT) | Detections | Server (cron, detail route) | Free map key, server secret | 5 000 transactions / 10 min per key; area API 1–5 days | Acceptable; acknowledgement shown | Detail requests were allowed up to 10 days; now limited to 5. |
| CARTO basemaps | Vector style, tiles, glyphs | Browser | API key now required | Free non-commercial up to 5 M tiles/month | Acceptable once a key is set | **Key required since 23/09/2026.** Keyless raster tiles are watermarked; keyless vector styles may follow. Key support is in place; registering the key is an owner action. |
| Esri World Imagery (`server.arcgisonline.com`) | Satellite basemap | Browser | None (legacy endpoint) | Not published | Acceptable as non-commercial; "Powered by Esri" shown | Tolerated rather than contracted: Esri says the legacy endpoint is not for commercial use. |
| Open-Meteo | Model weather for a selected detection | Browser | None | < 10 000 calls/day per IP; free for non-commercial use | Acceptable; CC BY 4.0 credit shown | Kept in the browser on purpose: limits are per IP, and Worker egress addresses are shared with other tenants. |
| OpenAQ v3 | Nearest PM2.5 reading | Server | API key, server secret | 60 requests/min, 2 000/hour per key | Acceptable | One lookup can take up to 7 calls; now cached per 2 km cell and capped per isolate. |
| Nominatim (OpenStreetMap) | Place names | Server | None; identifying User-Agent required | 1 request/second for the whole application; caching required | Acceptable | Throttling is per isolate, not global; rounding to 2 km and edge caching keep real traffic far below the limit. |
| Google News RSS | Related headlines | Server | None (no official API) | Undocumented | Grey area: terms reserve the service for use through its own interface | Feeds can be blocked at any time; the panel degrades to "news unavailable". |
| Bing News RSS (fallback) | Related headlines | Server | None | Undocumented | Grey area: Microsoft terms limit Bing content to personal, non-commercial use | Same as Google. The Bing News Search API was retired in 2025. |
| ANEPC open occurrences (ArcGIS Online feature layer `OcorrenciasSite`, organisation geoPROCIV ANEPC) | Official rural-fire occurrences, mainland Portugal | Server (cron four times an hour) | None | maxRecordCount 2 000 per page; responses cached by ArcGIS for 120 s; one request per run (96/day) | Acceptable for personal, non-commercial use with attribution (see below) | Not a contracted API: unavailable for months in 2024–2025 and for eight weeks in 2026, and moved host and schema in March 2026. Checked live on 12/10/2026: fields, page size, time zones, ownership and the dados.gov.pt record. |
| EFFIS (Copernicus) | Not used | n/a | n/a | n/a | n/a | Evaluated and left out: its active-fire layers republish NASA FIRMS; its burnt-area WFS showed hangs, 503 errors, swapped axes and very large payloads in 2026. |
| Cloudflare Workers, KV | Hosting, storage | Server | Account | Free plan (see [operations.md](./operations.md)) | Acceptable | Workers Logs keep request data for 3 days on Free today and up to 7 days from 01/12/2026; the policy says "up to 7 days". |

## Operational data (ANEPC)

The live layer and the dados.gov.pt record were read on 12/10/2026 from a GitHub Actions runner (the development environment's network policy blocks both hosts). The ANEPC website notice and the SGIFR terms could not be fetched there and still rest on search-engine summaries.

| Evidence | What it shows | How it was checked |
|---|---|---|
| Layer ownership | The ArcGIS item "Ocorrencias Site" behind `OcorrenciasSite` is owned by the account `ANEPCdados` of the organisation "geoPROCIV ANEPC" (`VlrHb7fn5ewYhX6y`), public access | ArcGIS item and portal records, live |
| Layer licence | The item's licence and credits fields are empty; the layer's copyright text is empty | ArcGIS item record, live |
| dados.gov.pt | Dataset "ProCiv - Ocorrências em aberto", organisation Autoridade Nacional de Emergência e Proteção Civil, licence `cc-by` (Creative Commons Attribution 4.0), update frequency continuous | dados.gov.pt API, live |
| dados.gov.pt resources | The two listed resources are the earlier prociv.pt web services (last modified 2021); the ArcGIS layer is not listed as a resource | dados.gov.pt API, live |
| ANEPC website notice | Reuse for personal or public purposes without profit, citing the source | Search summary only |
| SGIFR / SIFOR terms | No commercial use; written consent for republication | Search summary only; WildfireWatch does not read the SGIFR host |

**Conclusion.** The publisher is verified: ANEPC owns and publishes the layer. The licence is not attached to the layer itself; the CC BY 4.0 grant comes from ANEPC's own listing of the same information product ("Ocorrências em aberto") on dados.gov.pt, whose resource links predate the move to ArcGIS Online. For a personal, non-commercial site that credits ANEPC and states its changes, the CC BY listing and ANEPC's own notice point the same way. This is a reasoned engineering reading, not a legal opinion, and the site's wording says the dataset is *listed* under CC BY 4.0 rather than that the layer is licensed under it.

**What WildfireWatch does.** It reads the ArcGIS Online layer, not the SGIFR gateway; asks only for the fields it uses, so the street address is never fetched; keeps rural fires only; credits ANEPC in every occurrence panel and on `/sobre`, with a link to the licence and the list of changes (filtering, no address, grouped and translated phases, times in UTC, linking to detections); says ANEPC does not endorse the project; and labels every phase "reported by ANEPC". It stores only the current snapshot, publishes no archive and commits no raw data to the repository.

**Residual risk.** The licence is inferred from the dataset listing, not stated on the layer. An optional, stronger step, for the owner only, is to ask ANEPC (`geral@prociv.pt`) to confirm that the geoPROCIV layer is covered by the dados.gov.pt listing; nothing in the code depends on it.

**Safety wording.** The occurrence list is not an alert channel and arrives minutes late. Every occurrence panel says that WildfireWatch is not an official channel and to call 112 and follow Civil Protection instructions in an emergency.

## Commercialisation blockers / changes required later

Commercialisation is not a current goal. If advertising, sponsorship or paid features were ever added:

1. **Consent and disclosure.** A consent banner before any advertising or analytics cookies, and a rewritten privacy policy.
2. **Provider identity.** DL 7/2004, art. 10 identification (name, geographic address, email, tax number) and possibly professional registration.
3. **Esri.** Move to the ArcGIS Location Platform basemap service with an API key (free tier, then paid per 1 000 tiles); the legacy endpoint is non-commercial only.
4. **CARTO.** Commercial tier: free up to 1 M tiles/month, then a paid plan.
5. **Open-Meteo.** Advertising makes use commercial; a paid plan with a dedicated endpoint is required.
6. **News.** Google News RSS and Bing RSS have no commercial licence; replace with a licensed news API or publishers' own feeds, or remove the news section.
7. **Nominatim.** Heavy or commercial use should move to a paid geocoder or a self-hosted instance.
8. **OpenAQ.** Check each data provider's licence flags (`commercialUseAllowed`) and OpenAQ's paid terms for higher rates.
9. **NASA FIRMS.** No restriction found; keep the acknowledgement.
10. **ANEPC.** CC BY 4.0 would allow commercial reuse, but ANEPC's own website notice allows reuse only without profit, and the SGIFR terms exclude commercial use. Ask ANEPC in writing before any commercial use.

## Owner decisions

Recorded on 03/10/2026 and 04/10/2026.

1. **Controller identity: keep the pseudonym.** The site keeps naming the controller as "WhiteBlindness" with GitHub issues as the contact channel, and publishes no legal name, email address or postal address. Publishing a legal name and a private contact channel would most likely satisfy GDPR art. 13(1)(a) more fully; the owner accepts the residual compliance risk of a pseudonymous controller for as long as WildfireWatch stays personal and non-commercial, with no accounts, forms, analytics, advertising or payments. This is an owner decision, not a finding that the pseudonymous identity is legally sufficient. It must be revisited before any of those conditions change.
2. **CARTO basemaps: free key, no paid plan.** A free CARTO Basemaps key is configured for production builds. The key is public by design, because it travels in every browser request to CARTO, but it is kept out of CI logs where possible (see [operations.md](./operations.md)). Commercial use would need CARTO's commercial tier (see above).
3. **Personal and non-commercial; zero cost.** WildfireWatch stays a personal, non-commercial project. No paid Cloudflare feature is enabled. Commercialisation remains deferred (see the blockers above).
4. **Second source chosen on technical merit.** ANEPC was chosen because it is the only candidate that adds what FIRMS cannot (an authority's phase and resources) with a light, standard query; EFFIS was left out because it duplicates FIRMS or was unreliable, not because of where either is based.
5. **Telegram is the active alert channel.** Discord remains supported and optional. Neither is required for the site to run.
