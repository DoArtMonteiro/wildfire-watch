import { LEGAL_ROUTES, SITE } from "@/lib/site";
import type { LegalContent } from "./types";

const contact = `[GitHub repository issues](${SITE.contactUrl})`;

const en: LegalContent = {
  chrome: {
    backToMap: "Back to the map",
    navLabel: "Legal information",
    lastUpdated: "Last updated",
    onThisPage: "On this page",
    linkLabels: {
      about: "About",
      privacy: "Privacy",
      terms: "Terms of use",
    },
  },
  documents: {
    about: {
      title: "About WildfireWatch",
      summary:
        "WildfireWatch is a free, non-commercial personal project that maps thermal anomalies detected by satellite. It is not an official source of wildfire information.",
      sections: [
        {
          id: "aviso",
          title: "Important notice",
          blocks: [
            {
              type: "paragraph",
              text: "In an emergency, call 112. Always follow the authorities: in Portugal, the [National Emergency and Civil Protection Authority (ANEPC)](https://prociv.gov.pt/), [IPMA](https://www.ipma.pt/) and [ICNF](https://www.icnf.pt/); elsewhere, your local emergency services.",
            },
            {
              type: "list",
              items: [
                "A thermal anomaly is not necessarily a wildfire: agricultural burning, industrial stacks, gas flares and volcanoes are detected too.",
                "A fire may be missing: clouds, thick smoke and the gap between satellite overpasses prevent some detections.",
                "Data arrives late. NASA publishes detections in near real time (usually within about three hours of the overpass) and WildfireWatch refreshes its copy once an hour.",
                "Satellites measure heat and cannot tell whether a fire is active, contained or out. In mainland Portugal, WildfireWatch shows the status ANEPC reports when a detection lies near an open official occurrence. Otherwise the status is unknown.",
                "Official occurrences are a few minutes behind as well: WildfireWatch reads ANEPC's public list every 15 minutes. That list is not an alert channel.",
                "Burned areas and the air-quality index are estimates, not official measurements. The squares on the map are sensor pixels, not fire perimeters.",
              ],
            },
          ],
        },
        {
          id: "metodologia",
          title: "How the data is handled",
          blocks: [
            {
              type: "list",
              items: [
                "Source: detections from the VIIRS sensor on the Suomi NPP satellite, distributed by NASA FIRMS (VIIRS_SNPP_NRT product), covering the last 72 hours.",
                "Sampling: the map shows up to 15,000 detections. Every detection in Portugal is kept; elsewhere, the highest radiative power and an even geographic spread take priority. Totals refer to this sample, not to every detection worldwide.",
                "Fire radiative power (FRP): measured by the satellite in megawatts. The map groups it into four intensity classes (below 10, 10 to 49, 50 to 149, and 150 MW or more) used only for colour. It is not a measure of how severe a fire is.",
                "Confidence: the category (low, nominal or high) that NASA assigns to each detection.",
                "Burned area: an order-of-magnitude estimate from radiative power and the time since the first detection. It assumes 0.368 kg of biomass burned per MJ of radiated energy (Wooster et al., 2005) and about 3.8 kg/m² of fuel consumed, typical of shrubland and forest. It is not an observed area.",
                "Official occurrences: ANEPC's public list of open occurrences, for mainland Portugal only. WildfireWatch shows rural fires only (nature codes 31xx), leaving out burns, fuel management and mop-up consolidation, and does not keep the occurrence's address.",
                "Linking the sources: a satellite detection is linked to an official occurrence when it lies within 5 km of the registered location and was acquired no more than 6 hours before the occurrence started. If two occurrences are at similar distances (within 1 km of each other), the detection is linked to neither. The rules are fixed and public, and the same data always gives the same result. Both sources keep their own records: linking only relates them.",
                "Data status: the panel tells the age of the snapshot shown apart from the state of the automatic refresh. If a refresh fails, the last valid data stays on screen and the panel says the refresh is failing.",
                "Weather: current values from the Open-Meteo model at the hotspot's coordinates, not from an on-site station.",
                "Air quality: the PM2.5 reading from the nearest OpenAQ monitor within 100 km, converted to an estimated AQI using US EPA breakpoints. The monitor may not reflect this fire's smoke.",
                "News: headlines and links from the last 30 days, found by an automatic Google News and Bing News search for the place name. They may concern other fires. WildfireWatch neither controls nor verifies them.",
              ],
            },
          ],
        },
        {
          id: "responsavel",
          title: "Operator and contact",
          blocks: [
            {
              type: "paragraph",
              text: `WildfireWatch is maintained by ${SITE.maintainer} in a personal capacity as a portfolio project. There is no commercial activity, no advertising and no payment collection.`,
            },
            {
              type: "paragraph",
              text: `For questions, corrections, personal-data requests or accessibility problems, please use the ${contact}. The source code is available in the [public repository](${SITE.repositoryUrl}).`,
            },
          ],
        },
        {
          id: "fontes",
          title: "Data sources and attributions",
          blocks: [
            {
              type: "list",
              items: [
                "Fire detections: we acknowledge the use of data and imagery from NASA's Fire Information for Resource Management System (FIRMS) ([earthdata.nasa.gov/firms](https://www.earthdata.nasa.gov/firms)), part of NASA's Earth Science Data and Information System (ESDIS). NASA does not sponsor or endorse this project.",
                "Official occurrences: National Emergency and Civil Protection Authority (ANEPC). WildfireWatch reads the public layer of open occurrences that ANEPC publishes on ArcGIS Online (the geoPROCIV organisation). ANEPC lists the dataset “ProCiv – Ocorrências em aberto” on [dados.gov.pt](https://dados.gov.pt/pt/datasets/prociv-ocorrencias-em-aberto/) under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Changes made by WildfireWatch: rural fires only, the address is not fetched, phase labels are grouped and translated, times are converted to UTC, and occurrences are linked to satellite detections. ANEPC does not sponsor or endorse this project.",
                "Base map: © [CARTO](https://carto.com/attributions) and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), data available under the ODbL.",
                "Satellite imagery: Powered by Esri. Sources: Esri, Maxar, Earthstar Geographics and the GIS User Community.",
                "Place names: [Nominatim](https://nominatim.org/), with data © OpenStreetMap contributors.",
                "Weather: [Open-Meteo.com](https://open-meteo.com/), under CC BY 4.0.",
                "Air quality: [OpenAQ](https://openaq.org/) and the organisations that publish each monitor.",
                "News: Google News and Bing News. Headlines and articles belong to their publishers.",
                "Typefaces: Geist and JetBrains Mono, under the SIL Open Font License 1.1.",
              ],
            },
          ],
        },
        {
          id: "acessibilidade",
          title: "Accessibility",
          blocks: [
            {
              type: "paragraph",
              text: "The goal is to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA. Contrast, visible keyboard focus, accessible control names and reduced-motion preferences have been reviewed.",
            },
            {
              type: "list",
              items: [
                "The map is a graphical element. With the map focused, the arrow keys pan the view and the + and − keys change the zoom.",
                "For people who do not use a mouse, the side panel lists the most intense detections. Each entry opens that hotspot's details without going through the map.",
                "A skip link at the start of the page jumps straight to the information panel.",
              ],
            },
            {
              type: "paragraph",
              text: `If you find an accessibility barrier, please report it in the ${contact}.`,
            },
          ],
        },
      ],
    },
    privacy: {
      title: "Privacy and cookie policy",
      summary:
        "WildfireWatch has no accounts, forms, cookies, traffic analytics or advertising. This page explains the little technical data involved in using the site.",
      sections: [
        {
          id: "responsavel",
          title: "Data controller",
          blocks: [
            {
              type: "paragraph",
              text: `The controller is ${SITE.maintainer}, who maintains WildfireWatch in a personal capacity. Contact: ${contact}.`,
            },
          ],
        },
        {
          id: "dados",
          title: "What data is processed",
          blocks: [
            {
              type: "list",
              items: [
                "Technical data from each request (IP address, browser, requested page, date and time), processed by Cloudflare, which hosts the site, to deliver it and protect it from abuse.",
                "Server operation logs (Cloudflare Workers Logs) with the requested address and error messages, kept for up to 7 days to detect faults. They are not used to identify visitors.",
                "Language and theme preferences, stored only on your device (see “Cookies and local storage”).",
              ],
            },
            {
              type: "paragraph",
              text: "WildfireWatch does not ask for your location, does not build profiles, does not use data for advertising, and does not sell or share data with third parties for commercial purposes.",
            },
          ],
        },
        {
          id: "terceiros",
          title: "Third-party services",
          blocks: [
            {
              type: "paragraph",
              text: "To draw the map and show the weather, your browser contacts the services below directly. As with any request on the Internet, they receive your IP address and browser identification and handle them under their own privacy policies.",
            },
            {
              type: "table",
              caption: "Services contacted directly by your browser",
              head: ["Service", "Purpose", "Data sent besides your IP"],
              rows: [
                ["[CARTO](https://carto.com/privacy)", "Base map and labels", "Map area being viewed"],
                ["[Esri](https://www.esri.com/en-us/privacy/overview)", "Satellite imagery", "Map area being viewed"],
                ["[Open-Meteo](https://open-meteo.com/en/terms)", "Weather for the selected hotspot", "Hotspot coordinates (not yours)"],
              ],
            },
            {
              type: "paragraph",
              text: "The other services (NASA FIRMS, ANEPC's occurrence list, hosted on Esri's ArcGIS Online, OpenAQ, Nominatim, Google News and Bing News) are contacted by the WildfireWatch server and never receive data about you: they receive only hotspot coordinates or place names or, for ANEPC, a fixed request for the whole list. When you open a news article you browse the publisher's site, which has its own rules.",
            },
            {
              type: "paragraph",
              text: "If a source's automatic refresh keeps failing, the server may notify the maintainer on Discord or Telegram and, once a day, send a technical summary when there is something to report. These messages contain only the technical state of the refreshes (source, time, error code, data age, record counts and, in the summary, status labels published by the source), never visitor data.",
            },
          ],
        },
        {
          id: "fundamento",
          title: "Legal basis and transfers",
          blocks: [
            {
              type: "paragraph",
              text: "Technical data is processed on the basis of the legitimate interest in providing and protecting the site (Article 6(1)(f) of the General Data Protection Regulation). Some providers may process data outside the European Economic Area under the transfer mechanisms provided for in the GDPR.",
            },
          ],
        },
        {
          id: "cookies",
          title: "Cookies and local storage",
          blocks: [
            {
              type: "paragraph",
              text: "WildfireWatch sets no cookies. It only stores two preferences in your browser's local storage (localStorage) when you choose them. They never leave your device.",
            },
            {
              type: "table",
              caption: "Items kept in local storage",
              head: ["Name", "Purpose", "Duration"],
              rows: [
                ["wildfirewatch-locale", "Chosen language (Portuguese or English)", "Until you clear site data"],
                ["theme", "Chosen theme (light or dark)", "Until you clear site data"],
              ],
            },
            {
              type: "paragraph",
              text: "Because they only provide a service you explicitly asked for, these items do not require prior consent under Article 5(3) of the ePrivacy Directive, transposed in Portugal by Article 5 of Law 41/2004. That is why the site shows no cookie banner. You can delete them at any time in your browser settings.",
            },
          ],
        },
        {
          id: "direitos",
          title: "Your rights",
          blocks: [
            {
              type: "paragraph",
              text: `You have the rights of access, rectification, erasure, restriction and objection (Articles 15 to 21 GDPR). Because WildfireWatch keeps no data that identifies you, a request usually cannot be linked to a person. To exercise these rights, please use the ${contact}. You may also lodge a complaint with the Portuguese supervisory authority, the [CNPD](https://www.cnpd.pt/), or with the authority in your own country.`,
            },
          ],
        },
        {
          id: "alteracoes",
          title: "Changes",
          blocks: [
            {
              type: "paragraph",
              text: "This policy is updated whenever the site starts handling data differently, for example if it ever shows advertising or visitor statistics. In that case, any non-essential cookie will only be used with your prior consent.",
            },
          ],
        },
      ],
    },
    terms: {
      title: "Terms of use",
      summary:
        "By using WildfireWatch you accept these terms. The service is free, informational and unofficial.",
      sections: [
        {
          id: "natureza",
          title: "Nature of the information",
          blocks: [
            {
              type: "paragraph",
              text: `WildfireWatch shows public third-party data and its own estimates, with no guarantee of accuracy, completeness or timeliness. It does not replace information from the authorities and must not be used for safety, evacuation or firefighting decisions. In an emergency, call 112. See the data's limits on the [About](${LEGAL_ROUTES.about}#aviso) page.`,
            },
          ],
        },
        {
          id: "utilizacao",
          title: "Acceptable use",
          blocks: [
            {
              type: "list",
              items: [
                "Do not overload the site or its /api/ endpoints with bulk automated requests.",
                "Do not use the site to get around the limits or conditions of the original data sources.",
                "Respect the third-party licences and attributions listed on the About page.",
              ],
            },
          ],
        },
        {
          id: "propriedade",
          title: "Intellectual property",
          blocks: [
            {
              type: "paragraph",
              text: `WildfireWatch's code and design belong to its author. Data, satellite imagery, maps and news belong to their sources, listed on the [About](${LEGAL_ROUTES.about}#fontes) page, and are subject to their licences.`,
            },
          ],
        },
        {
          id: "ligacoes",
          title: "External links",
          blocks: [
            {
              type: "paragraph",
              text: "News items and other links lead to third-party sites. WildfireWatch does not control that content and is not responsible for it.",
            },
          ],
        },
        {
          id: "responsabilidade",
          title: "Liability and availability",
          blocks: [
            {
              type: "paragraph",
              text: "The service is provided as is and may be changed, interrupted or discontinued without notice. To the extent permitted by law, the author is not liable for damage arising from use of the information. Nothing in these terms excludes liability that cannot be excluded by law or limits the rights the law grants to consumers.",
            },
          ],
        },
        {
          id: "lei",
          title: "Governing law and contact",
          blocks: [
            {
              type: "paragraph",
              text: `These terms are governed by Portuguese law. For any question, please use the ${contact}. How data is handled is described in the [Privacy policy](${LEGAL_ROUTES.privacy}).`,
            },
          ],
        },
      ],
    },
  },
};

export default en;
