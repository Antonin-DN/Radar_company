"use strict";

// Service worker : scanne les onglets en arrière-plan, affine via l'IA locale,
// répond aux demandes du popup (scan à la demande, analyse approfondie,
// appel Pappers).
//
// PASSAGE AU PROXY PLUS TARD :
// dans fetchPappers, remplacer le bloc "appel direct Pappers" par un appel à
// ton service, du type
//   const url = "https://ton-worker.workers.dev/entreprise?siren=" + siren;
//   const r = await fetch(url);           // aucune clé côté extension
// et retirer la lecture de pappersApiKey ci-dessous. Le reste ne bouge pas.

// --- Scans récents, un par domaine, consultables depuis la page réglages --
// Stocké dans chrome.storage.session : gardé tant que le navigateur reste
// ouvert, vidé à sa fermeture. C'est une vue de debug, pas un journal
// permanent. Un appel Pappers pour un domaine s'ajoute sous la même clé de
// domaine que le scan qui l'a précédé (même fonction domainOf des deux
// côtés).

const SCAN_CAP = 10; // nombre de domaines conservés, les plus anciens sautent

function domainOf(url) {
  try {
    return new URL(url).hostname || url;
  } catch (_) {
    return url || "?";
  }
}

// File d'attente : serialise les lire-modifier-ecrire sur une meme cle de
// chrome.storage.session. Sans ça, deux appels concurrents (un scan long et
// un enrichissement Pappers presque simultanes, par exemple) peuvent chacun
// lire avant que l'autre ait ecrit, puis se re-ecraser l'un l'autre en
// sauvegardant en dernier une version qui ne connait pas le changement de
// l'autre.
function makeQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}
const withScansLock = makeQueue();
const withCacheLock = makeQueue();

async function getScans() {
  try {
    const { radarScans = {} } = await chrome.storage.session.get("radarScans");
    return radarScans;
  } catch (_) {
    return {};
  }
}

function upsertScan(domain, patch) {
  return withScansLock(async () => {
    try {
      const scans = await getScans();
      scans[domain] = { ...(scans[domain] || {}), ...patch, domain, ts: Date.now() };
      const keys = Object.keys(scans);
      if (keys.length > SCAN_CAP) {
        keys.sort((a, b) => (scans[a].ts || 0) - (scans[b].ts || 0));
        for (const k of keys.slice(0, keys.length - SCAN_CAP)) delete scans[k];
      }
      await chrome.storage.session.set({ radarScans: scans });
      console.log("[radar] upsertScan ok", domain, Object.keys(scans[domain]));
      return { ok: true, entry: scans[domain] };
    } catch (e) {
      console.error("[radar] upsertScan FAILED", domain, Object.keys(patch || {}), e);
      return { ok: false, error: (e && e.message) || String(e) };
    }
  });
}

function addPappersCall(domain, rec) {
  return withScansLock(async () => {
    try {
      const scans = await getScans();
      const e = scans[domain] || { domain };
      const pappers = (e.pappers || []).concat(rec).slice(-5);
      scans[domain] = { ...e, pappers, ts: Date.now() };
      await chrome.storage.session.set({ radarScans: scans });
    } catch (_) {}
  });
}

function clearScanEntry(domain) {
  return withScansLock(async () => {
    try {
      const scans = await getScans();
      delete scans[domain];
      await chrome.storage.session.set({ radarScans: scans });
    } catch (_) {}
  });
}

// --- Cache de scan par onglet, éphémère (vidé à la fermeture du navigateur) --

async function getCache() {
  try {
    const { radarCache = {} } = await chrome.storage.session.get("radarCache");
    return radarCache;
  } catch (_) {
    return {};
  }
}

function setCacheEntry(tabId, patch) {
  return withCacheLock(async () => {
    try {
      const cache = await getCache();
      cache[tabId] = { ...(cache[tabId] || {}), ...patch };
      await chrome.storage.session.set({ radarCache: cache });
      return cache[tabId];
    } catch (_) {
      return { ...patch };
    }
  });
}

function removeCacheEntry(tabId) {
  return withCacheLock(async () => {
    try {
      const cache = await getCache();
      delete cache[tabId];
      await chrome.storage.session.set({ radarCache: cache });
    } catch (_) {}
  });
}

// --- Appel Pappers, avec timeout, cache et journal -----------------------
// Le payload complet est tres volumineux (etablissements, actes, comptes,
// BODACC...) : on retire les listes qu'on n'affiche jamais avant de mettre
// en cache ou de renvoyer la reponse, pour rester leger en storage.session.

const PAPPERS_DROP_KEYS = [
  "etablissements",
  "depots_actes",
  "comptes",
  "publications_bodacc",
  "beneficiaires_effectifs",
  "procedures_collectives",
  "finances_consolidees",
  "activites_rne",
  "conventions_collectives",
];

function trimCompanyData(d) {
  if (!d || typeof d !== "object") return d;
  const copy = { ...d };
  for (const k of PAPPERS_DROP_KEYS) delete copy[k];
  if (Array.isArray(copy.finances)) copy.finances = copy.finances.slice(0, 3);
  return copy;
}

// Reponse Pappers deja en cache pour ce domaine, si elle correspond au meme
// SIREN : evite un appel reseau (et un jeton Pappers) inutile.
async function getCachedCompany(domain, siren) {
  if (!domain || !siren) return null;
  const scans = await getScans();
  const c = scans[domain] && scans[domain].company;
  return c && c.siren === siren ? c.data : null;
}

async function fetchPappers(siren, domain) {
  const cached = await getCachedCompany(domain, siren);
  if (cached) {
    console.log("[radar] pappers (cache)", { siren, domain });
    return { data: cached, fromCache: true };
  }

  const { pappersApiKey } = await chrome.storage.local.get("pappersApiKey");
  if (!pappersApiKey) {
    return { error: "Aucune clé API enregistrée." };
  }

  // Appel direct Pappers (API v2). À confirmer selon ta formule et ta doc.
  const url =
    "https://api.pappers.fr/v2/entreprise?api_token=" +
    encodeURIComponent(pappersApiKey) +
    "&siren=" +
    encodeURIComponent(siren);

  const started = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) {
      let detail = "";
      try {
        const j = await r.json();
        detail = j.error || j.message || "";
      } catch (_) {}
      const msg = "Pappers a répondu " + r.status + (detail ? " — " + detail : "");
      console.log("[radar] pappers", { siren, domain, ok: false, status: r.status, msg });
      if (domain) await addPappersCall(domain, { siren, ok: false, status: r.status, error: msg, ms: Date.now() - started, t: Date.now() });
      return { error: msg };
    }
    const data = trimCompanyData(await r.json());
    console.log("[radar] pappers", { siren, domain, ok: true, status: r.status });
    if (domain) {
      await addPappersCall(domain, { siren, ok: true, status: r.status, ms: Date.now() - started, t: Date.now() });
      await upsertScan(domain, { company: { siren, data, ts: Date.now() } });
    }
    return { data };
  } catch (e) {
    clearTimeout(to);
    const timedOut = e && e.name === "AbortError";
    const msg = timedOut
      ? "Pappers n'a pas répondu à temps (12 s)."
      : "Appel réseau impossible : " + e.message;
    console.log("[radar] pappers", { siren, domain, ok: false, error: msg, timedOut });
    if (domain) await addPappersCall(domain, { siren, ok: false, error: msg, timedOut, ms: Date.now() - started, t: Date.now() });
    return { error: msg };
  }
}

// --- Scanner injecté dans la page active ---------------------------------
// Fonction autonome : elle est sérialisée puis exécutée dans le contexte de
// la page, donc elle ne peut référencer aucune variable extérieure.

async function scanPageForSirens() {
  function luhnValid(num) {
    let sum = 0;
    let alt = false;
    for (let i = num.length - 1; i >= 0; i--) {
      let d = parseInt(num[i], 10);
      if (alt) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  const KEYWORDS =
    /(siren|siret|r\.?c\.?s|tva|vat|immatricul|registr|registered|company\s*(no|number)|trade\s*register|mentions? l[ée]gales|legal)/i;
  const found = new Map(); // siren -> {siren,siret,viaKeyword,isEditor,match,sourceUrl,info}

  // Enregistre un identifiant avec sa provenance, sa zone et les infos de source.
  function register(siren, siret, match, viaKeyword, isEditor, sourceUrl, info, formeNear, context) {
    const e = found.get(siren) || {
      siren,
      siret: null,
      viaKeyword: false,
      isEditor: false,
      match,
      sourceUrl: sourceUrl || null,
      info: {},
      context: null,
    };
    if (siret) e.siret = siret;
    if (viaKeyword) e.viaKeyword = true;
    if (isEditor) e.isEditor = true;
    if (!sourceUrl) e.sourceUrl = null; // ancre en page preferee
    if (!e.match) e.match = match;
    // fusion champ par champ : on ne comble que les trous. Les pages sont
    // traitees dans l'ordre de pertinence (RANGS, voir plus bas) et jamais
    // dans l'ordre d'arrivee reseau — la premiere page fiable qui donne une
    // info gagne et n'est plus jamais ecrasee par une page moins bien
    // classee trouvee ensuite (sinon adresse/email changent d'un scan a
    // l'autre selon qui repond le plus vite).
    e.info = e.info || {};
    if (info) {
      for (const k of ["raison", "forme", "email", "adresse", "maj"]) {
        if (info[k] && !e.info[k]) e.info[k] = info[k];
      }
    }
    // forme trouvee juste a cote du numero, priorite si rien de mieux
    if (formeNear && !e.info.forme) e.info.forme = formeNear;
    // texte de contexte pour l'IA, meme logique de premier arrivant
    if (context && !e.context) e.context = context;
    found.set(siren, e);
  }

  // Formes juridiques, abreviations et libelles complets.
  const FORME_ABBR =
    /\b(SASU|SAS|SARLU|SARL|EURL|SNC|SCIC|SCI|SCA|SCS|SCOP|SELARL|SELAS|SELAFA|SELCA|SEL|GIE|EIRL|SA|EI)\b/;
  const FORME_FULL =
    /(soci[ée]t[ée]\s+(?:par\s+actions\s+simplifi[ée]es?(?:\s+unipersonnelle)?|[àa]\s+responsabilit[ée]\s+limit[ée]e(?:\s+unipersonnelle)?|anonyme|en\s+nom\s+collectif|civile(?:\s+immobili[èe]re|\s+de\s+moyens|\s+professionnelle)?|coop[ée]rative[^.\n]{0,30}|en\s+commandite(?:\s+(?:simple|par\s+actions))?|d['e]\s*exercice\s+lib[ée]ral)|entreprise\s+unipersonnelle\s+[àa]\s+responsabilit[ée]\s+limit[ée]e|entreprise\s+individuelle)/i;
  // Equivalents anglais courants (sites bilingues ou uniquement en anglais),
  // normalises vers l'abreviation francaise standard.
  const FORME_EN = [
    [/single[\s-]?(member|shareholder)\s+simplified\s+joint[\s-]?stock\s+compan/i, "SASU"],
    [/simplified\s+joint[\s-]?stock\s+compan/i, "SAS"],
    [/single[\s-]?(member|shareholder)\s+limited\s+liability\s+compan/i, "EURL"],
    [/limited\s+liability\s+compan/i, "SARL"],
    [/public\s+limited\s+compan/i, "SA"],
    [/general\s+partnership/i, "SNC"],
    [/(non[\s-]?trading|civil)\s+real\s+estate\s+compan/i, "SCI"],
    [/sole\s+proprietorship/i, "EI"],
  ];

  // Detecte une forme, libelle complet prioritaire, abreviation pointee geree,
  // equivalent anglais normalise en dernier recours.
  function detectForme(str) {
    if (!str) return null;
    const full = str.match(FORME_FULL);
    if (full) return full[1].replace(/\s{2,}/g, " ").trim();
    // aplatit les abreviations pointees, S.A.S. devient SAS
    const flat = str.replace(/([A-Za-z])\.(?=[A-Za-z])/g, "$1");
    const abbr = flat.match(FORME_ABBR);
    if (abbr) return abbr[1].toUpperCase();
    for (const [re, sigle] of FORME_EN) {
      if (re.test(str)) return sigle;
    }
    return null;
  }

  // Extrait raison sociale, forme, capital, email et adresse dans la zone utile.
  function extractInfo(text) {
    // emails, on privilegie les adresses de contact
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi) || [];
    const pref = /^(contact|infos?|hello|bonjour|accueil|commercial|rh|admin|societe|société|direction|rc|serviceclient)@/i;
    const email =
      emails.find((e) => pref.test(e)) ||
      emails.find((e) => !/(sentry|example|@\d|\.png|\.jpg)/i.test(e)) ||
      emails[0] ||
      null;

    // raison sociale apres le marqueur editeur
    let raison = null;
    const rm = text.match(
      /(?:édit[ée]\s*par|edited\s*by|publi[ée]\s*par|published\s*by)\s*:?\s*\n?\s*([^\n]{2,90})/i
    );
    if (rm) {
      raison = rm[1]
        .split(
          /[,;(]|\s[–—-]\s|\.\s|\s(?:immatricul|RCS|R\.?C\.?S|au\s+capital|au\s+RCS|numéro|SIREN|SIRET|dont|sur\s+lequel|repr[ée]sent|sise?|domicili|ci-apr[èe]s)/i
        )[0]
        .replace(/[,;:–—-]\s*$/, "")
        .trim();
      // retirer un prefixe descriptif en tete. On exige "société" ou
      // "entreprise" en minuscule, signe d'un descriptif et non d'un nom
      // propre, ce qui preserve un nom comme la Société Générale.
      raison = raison
        .replace(
          /^(?:La|LA|la|Le|LE|le|L['’]|l['’])\s*(?:société|societe|entreprise|company)\s+/,
          ""
        )
        .replace(
          /^(?:La|LA|la|Le|LE|le|L['’]|l['’])\s*(?:SASU|SAS|SARLU|SARL|EURL|SNC|GIE|SA)\s+/i,
          ""
        )
        .trim();
    }

    // forme juridique via le detecteur commun, libelle complet prioritaire
    const forme = detectForme(text);
    // on retire la forme en fin de raison pour garder le nom propre
    if (raison) {
      raison = raison
        .replace(FORME_FULL, "")
        .replace(
          /[,\s]+(SASU|SAS|SARLU|SARL|EURL|SNC|SCIC|SCI|SCA|SCS|SCOP|SELARL|SELAS|SELAFA|SELCA|SEL|GIE|EIRL|SA|EI)\s*$/i,
          ""
        )
        .replace(/[,;–-]\s*$/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    // capital social retire, donnee souvent perimee, Pappers fait foi

    // adresse, label prioritaire puis repli rue plus code postal
    let adresse = null;
    const am = text.match(
      /(?:siège\s*social|si[èe]ge|registered\s*office|adresse)\s*:?\s*([^\n]{5,120})/i
    );
    if (am) {
      adresse = am[1].replace(/\s{2,}/g, " ").trim();
    } else {
      const pm = text.match(
        /(\d{1,4}(?:\s?(?:bis|ter))?\s+(?:rue|avenue|av\.?|bd|boulevard|impasse|all[ée]e|chemin|quai|place|route|cours)[^\n]{0,60})[\s,]*\n?\s*(\d{5})\s+([A-Za-zÀ-ÿ' -]{2,40})/i
      );
      if (pm)
        adresse = (pm[1] + " " + pm[2] + " " + pm[3]).replace(/\s{2,}/g, " ").trim();
    }
    return { raison, forme, email, adresse };
  }

  // Passe les regex sur un texte, gere les zones editeur/hebergeur et le skip.
  // L'extraction des infos est isolee, une erreur ne bloque jamais le SIREN.
  function scanText(text, sourceUrl, maj) {
    if (!text) return;
    text = text.replace(/ /g, " ");
    const lower = text.toLowerCase();
    const near = (i) => KEYWORDS.test(lower.slice(Math.max(0, i - 60), i + 5));

    // reperage des marqueurs de zone, editeur ou hebergeur
    const markers = [];
    let mk;
    const reEd = /(édit[ée]\s*par|edited\s*by|publi[ée]\s*par|published\s*by)/gi;
    const reHo = /(h[ée]berg[ée]\s*(par|e)|hosted\s*by|h[ée]bergeur)/gi;
    while ((mk = reEd.exec(text)) !== null) markers.push({ i: mk.index, t: "ed" });
    while ((mk = reHo.exec(text)) !== null) markers.push({ i: mk.index, t: "ho" });
    markers.sort((a, b) => a.i - b.i);
    const zoneOf = (i) => {
      let z = null;
      for (const x of markers) {
        if (x.i <= i) z = x.t;
        else break;
      }
      return z;
    };

    // infos complementaires, isolees, ne doivent jamais faire echouer le SIREN
    const hoFirst = markers.find((x) => x.t === "ho");
    const utile = hoFirst ? text.slice(0, hoFirst.i) : text;
    let info = {};
    try {
      info = extractInfo(utile) || {};
    } catch (_) {
      info = {};
    }
    if (maj) info.maj = maj;

    const passe = (re, len) => {
      let m;
      while ((m = re.exec(text)) !== null) {
        const d = m[1].replace(/\D/g, "");
        if (d.length !== len || !luhnValid(d)) continue;
        const z = zoneOf(m.index);
        if (z === "ho") continue; // on saute l'hebergeur, OVH et consorts
        const siren = len === 14 ? d.slice(0, 9) : d;
        // forme juste autour du numero, comble le cas "SAS a cote du SIREN"
        const fenetre = text.slice(
          Math.max(0, m.index - 90),
          m.index + m[1].length + 90
        );
        const formeNear = detectForme(fenetre);
        // contexte pour l'IA, la zone editeur si connue, sinon autour du numero
        const ctx = (utile && utile.length > 40 ? utile : fenetre).slice(0, 1600);
        register(
          siren,
          len === 14 ? d : null,
          m[1].trim(),
          near(m.index),
          z === "ed",
          sourceUrl,
          info,
          formeNear,
          ctx
        );
      }
    };

    passe(/\b(\d{3}[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{5})\b/g, 14);
    passe(/\bFR\s?[0-9A-Z]{2}\s?(\d{3}[\s.]?\d{3}[\s.]?\d{3})\b/gi, 9);
    passe(/\b(\d{3}[\s.]?\d{3}[\s.]?\d{3})\b/g, 9);
  }

  // 1) page courante, texte visible plus URL des liens, avec sa date
  let legalOut = [];
  try {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const majPage = document.lastModified || null;
    scanText(document.body ? document.body.innerText : "", null, majPage);
    scanText(anchors.map((a) => a.href).join("  "), null, majPage);

    // 2) reperer les pages legales du meme site, classees par pertinence
  const origin = location.origin;
  // rangs, du signal le plus fiable au plus faible
  const RANGS = [
    /(mentions?\s*l[ée]gales?|mentions-legales|informations?\s*l[ée]gales?|legal\s*notice|\blegals?\b|legal\s*information|impressum|imprint)/i,
    /(conditions\s*g[ée]n[ée]rales|\bcgv\b|\bcgu\b|terms(\s*(and|&|of))?\s*(conditions|service|use|sale)?|\bt&?cs?\b|conditions\s*of\s*(sale|use))/i,
    /(conformit[ée]|compliance|r[ée]glementaire|regulatory)/i,
    /(politique\s*de\s*confidentialit[ée]|confidentialit[ée]|donn[ée]es\s*personnelles|vie\s*priv[ée]e|\brgpd\b|\bgdpr\b|privacy(\s*policy)?|cookies?)/i,
    /(qui\s*sommes|[àa]\s*propos|about(\s*us)?|company(\s*(info|information|details))?|corporate|notice|disclaimer)/i,
  ];
  const rangDe = (hay) => {
    for (let i = 0; i < RANGS.length; i++) if (RANGS[i].test(hay)) return i;
    return -1;
  };
  const legalMap = new Map(); // url -> meilleur rang
  for (const a of anchors) {
    try {
      const u = new URL(a.href, location.href);
      if (u.origin !== origin) continue;
      const hay = ((a.textContent || "") + " " + u.pathname).toLowerCase();
      const r = rangDe(hay);
      if (r < 0) continue;
      const url = u.href.split("#")[0];
      const prev = legalMap.get(url);
      if (prev === undefined || r < prev) legalMap.set(url, r);
    } catch (_) {}
  }
  const legalUrls = new Set(
    Array.from(legalMap.entries())
      .sort((a, b) => a[1] - b[1])
      .map((e) => e[0])
  );
  legalOut = Array.from(legalUrls);

  // 3) recuperer ces pages, via le service worker d'abord pour contourner
  //    la politique de securite du site, avec repli sur un fetch de page
  const bgFetch = (url) =>
    new Promise((res) => {
      try {
        chrome.runtime.sendMessage({ type: "fetchText", url }, (r) =>
          res(chrome.runtime.lastError ? null : r)
        );
      } catch (_) {
        res(null);
      }
    });

  const urls = Array.from(legalUrls).slice(0, 8);
  // on recupere toutes les pages en parallele (juste du reseau, pas de
  // risque), mais on ne les passe a scanText qu'ensuite, dans l'ordre de
  // pertinence (urls est deja trie par rang) — jamais dans l'ordre
  // d'arrivee reseau, qui est aleatoire et rendait adresse/email instables
  // d'un scan a l'autre.
  const fetched = await Promise.all(
    urls.map(async (url) => {
      let html = null;
      let maj = null;
      try {
        const r = await bgFetch(url);
        if (r && r.ok && r.text) {
          html = r.text;
          maj = r.lastModified || null;
        }
      } catch (_) {}
      if (!html) {
        try {
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 4500);
          const r = await fetch(url, { signal: ctrl.signal });
          clearTimeout(to);
          if (r.ok) {
            html = await r.text();
            maj = r.headers.get("last-modified") || null;
          }
        } catch (_) {}
      }
      if (!html) return null;
      try {
        const doc = new DOMParser().parseFromString(html, "text/html");
        doc.querySelectorAll("script, style, noscript").forEach((n) => n.remove());
        const body = doc.body ? doc.body.textContent || "" : "";
        const linksTxt = Array.from(doc.querySelectorAll("a[href]"))
          .map((a) => a.getAttribute("href") || "")
          .join("  ");
        return { url, text: body + "  " + linksTxt, maj };
      } catch (_) {
        return null;
      }
    })
  );
  for (const r of fetched) {
    if (r) scanText(r.text, r.url, r.maj);
  }
  } catch (_) {
    // toute erreur inattendue ne doit pas effacer les identifiants deja trouves
  }

  const candidates = Array.from(found.values()).sort((a, b) => {
    if (a.isEditor !== b.isEditor) return a.isEditor ? -1 : 1;
    if (a.viaKeyword !== b.viaKeyword) return a.viaKeyword ? -1 : 1;
    if (!!a.siret !== !!b.siret) return a.siret ? -1 : 1;
    return 0;
  });
  return { candidates, legalUrls: legalOut };
}

// --- Second passage via l'IA locale de Chrome, Prompt API ------------------
// Disponible depuis un service worker d'extension (self.LanguageModel).

async function getAISession() {
  const LM =
    (typeof self !== "undefined" && self.LanguageModel) ||
    (typeof LanguageModel !== "undefined" ? LanguageModel : null) ||
    (typeof self !== "undefined" && self.ai && self.ai.languageModel) ||
    null;
  if (!LM) return null;
  try {
    // disponibilite, la langue de sortie est requise par l'API
    let dispo = null;
    if (LM.availability) dispo = await LM.availability({ outputLanguage: "fr" });
    else if (LM.capabilities) {
      const c = await LM.capabilities();
      dispo = c && (c.available || c.availability);
    }
    if (dispo && /no|unavailable/i.test(String(dispo))) return null;

    // temperature la plus basse possible : on veut une extraction stable et
    // reproductible, pas une reponse creative qui varie d'un appel a l'autre
    // sur le meme texte
    const opts = {
      outputLanguage: "fr",
      initialPrompts: [
        {
          role: "system",
          content:
            "Tu extrais des informations d'une mention legale francaise. Tu ne inventes rien, tu recopies ce qui est ecrit. Tu reponds uniquement en JSON.",
        },
      ],
    };
    try {
      if (LM.params) {
        const p = await LM.params();
        if (p && typeof p.defaultTopK === "number") {
          opts.temperature = 0;
          opts.topK = p.defaultTopK;
        }
      }
    } catch (_) {}

    const session = await LM.create(opts);
    return session;
  } catch (_) {
    return null;
  }
}

// Interroge le modele sur le contexte du candidat, fusionne le resultat dans
// cand.info et renvoie {aiStatus, aiTrace} pour affichage/journal.
async function refineWithAI(cand) {
  let aiStatus = "indisponible";
  let aiTrace = null;
  if (!cand || !cand.context) return { aiStatus, aiTrace };

  // sonde l'etat exact du modele pour l'affichage
  try {
    const LM =
      (typeof self !== "undefined" && self.LanguageModel) ||
      (typeof LanguageModel !== "undefined" ? LanguageModel : null);
    if (LM && LM.availability) {
      const d = String(await LM.availability({ outputLanguage: "fr" }));
      if (/download/i.test(d)) aiStatus = "téléchargement en cours";
      else if (/available/i.test(d)) aiStatus = "prêt";
      else aiStatus = "non supporté";
    }
  } catch (_) {}

  const session = await getAISession();
  if (!session) {
    aiTrace = { etat: aiStatus, note: "modèle indisponible, repli regex" };
    console.log("[radar] ia", { etat: aiStatus });
    return { aiStatus, aiTrace };
  }

  const prompt =
    "Voici un extrait de mentions legales, parfois en anglais ou une autre langue.\n\n" +
    '"""' +
    cand.context +
    '"""\n\n' +
    "Pour la societe qui EDITE le site, pas l'hebergeur, rends un JSON avec les cles " +
    "raison, forme, adresse. raison est le nom sans la forme juridique ni article. " +
    "forme est UNIQUEMENT l'abreviation juridique francaise standard : SAS, SASU, SARL, " +
    "SARLU, EURL, SA, SNC, SCI, SCOP, SELARL, SELAS, EI ou EIRL. Meme si le texte source " +
    "est en anglais ou decrit la forme autrement, traduis-la vers cette abreviation " +
    "francaise standard, ne rends jamais une description ni une traduction en toutes lettres. " +
    "adresse est l'adresse du siege. " +
    "Mets null si absent ou si aucune abreviation ne correspond clairement. " +
    "Reponds uniquement le JSON.";

  // trace, on garde entree et sortie pour inspection
  aiTrace = { etat: aiStatus, contexte: cand.context, prompt, sortie: null, retenu: null };

  let out = null;
  try {
    const p = session.prompt(prompt);
    const timeout = new Promise((_, rej) => setTimeout(() => rej("timeout"), 7000));
    out = await Promise.race([p, timeout]);
  } catch (e) {
    try {
      session.destroy && session.destroy();
    } catch (_) {}
    aiTrace.sortie = "ERREUR " + (e && e.message ? e.message : e);
    console.log("[radar] ia", { etat: aiStatus, erreur: String(e) });
    return { aiStatus, aiTrace };
  }
  try {
    session.destroy && session.destroy();
  } catch (_) {}

  aiTrace.sortie = String(out);

  // parse defensif, on isole le premier objet JSON
  let data = null;
  try {
    const s = String(out).replace(/```json|```/g, "");
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) data = JSON.parse(s.slice(a, b + 1));
  } catch (_) {
    console.log("[radar] ia", { etat: aiStatus, parseOk: false });
    return { aiStatus, aiTrace };
  }
  if (!data || typeof data !== "object") return { aiStatus, aiTrace };

  // fusion prudente, l'IA affine le texte, jamais le SIREN valide par Luhn
  cand.info = cand.info || {};
  const propre = (v) =>
    typeof v === "string" && v.trim() && !/^null$/i.test(v.trim())
      ? v.trim()
      : null;
  let touche = false;
  const retenu = {};
  if (propre(data.raison)) {
    cand.info.raison = propre(data.raison);
    retenu.raison = cand.info.raison;
    touche = true;
  }
  if (propre(data.forme)) {
    cand.info.forme = propre(data.forme);
    retenu.forme = cand.info.forme;
    touche = true;
  }
  if (propre(data.adresse)) {
    cand.info.adresse = propre(data.adresse);
    retenu.adresse = cand.info.adresse;
    touche = true;
  }
  aiStatus = touche ? "actif, champs affinés" : "actif, sans changement";
  aiTrace.retenu = retenu;
  console.log("[radar] ia", { etat: aiStatus, siren: cand.siren, retenu });
  return { aiStatus, aiTrace };
}

// Ouvre chaque page legale dans un onglet d'arriere-plan de la fenetre
// courante (active:false, jamais mis au premier plan), la scanne une fois
// rendue, puis referme l'onglet. Contourne le HTML vide des sites en JS.
// Fait partie du scan a la demande, seulement si le premier passage (page
// courante + fetch texte) n'a pas trouve d'editeur solide.
async function scanLegalTabs(urls, base) {
  const byS = new Map();
  const add = (c) => {
    const e = byS.get(c.siren);
    if (!e) {
      byS.set(c.siren, c);
      return;
    }
    e.isEditor = e.isEditor || c.isEditor;
    e.viaKeyword = e.viaKeyword || c.viaKeyword;
    if (!e.siret && c.siret) e.siret = c.siret;
    e.info = e.info || {};
    if (c.info)
      for (const k of ["raison", "forme", "email", "adresse", "maj"])
        if (c.info[k] && (c.isEditor || !e.info[k])) e.info[k] = c.info[k];
    if (c.context && (c.isEditor || !e.context)) e.context = c.context;
  };
  (base || []).forEach(add);

  for (const url of urls) {
    let tabId = null;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tabId = tab.id;
      await waitForTabLoad(tabId, 8000);
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: scanPageForSirens,
      });
      const pl = (r && r[0] && r[0].result) || {};
      (pl.candidates || []).forEach(add);
    } catch (_) {
    } finally {
      if (tabId) {
        try {
          await chrome.tabs.remove(tabId);
        } catch (_) {}
      }
    }
    // on s'arrete des qu'une page a livre un editeur solide
    if (Array.from(byS.values()).some((c) => c.isEditor)) break;
  }

  return Array.from(byS.values()).sort((a, b) => {
    if (a.isEditor !== b.isEditor) return a.isEditor ? -1 : 1;
    if (a.viaKeyword !== b.viaKeyword) return a.viaKeyword ? -1 : 1;
    if (!!a.siret !== !!b.siret) return a.siret ? -1 : 1;
    return 0;
  });
}

// Attend qu'un onglet finisse de charger, avec un plafond de temps.
function waitForTabLoad(tabId, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      // petite marge pour laisser le JS rendre le contenu
      setTimeout(resolve, 800);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeout);
  });
}

// --- Orchestration du scan, à la demande du popup -------------------------

const inflight = new Map(); // tabId -> Promise en cours

async function runPageScan(tabId) {
  const r = await chrome.scripting.executeScript({
    target: { tabId },
    func: scanPageForSirens,
  });
  return (r && r[0] && r[0].result) || { candidates: [], legalUrls: [] };
}

// Scan complet, déclenché par le popup à l'ouverture : page courante + fetch
// texte des pages légales, puis repli sur des onglets d'arrière-plan si
// aucun éditeur solide n'a été trouvé, puis affinage IA. Dedupe les scans
// concurrents sur le même onglet.
async function scanAndCache(tabId, url, { force = false } = {}) {
  if (!force && inflight.has(tabId)) return inflight.get(tabId);

  const p = (async () => {
    const started = Date.now();
    await setCacheEntry(tabId, { url, status: "scanning", ts: Date.now() });

    const domain = domainOf(url);

    let payload;
    try {
      payload = await runPageScan(tabId);
    } catch (e) {
      const entry = await setCacheEntry(tabId, {
        status: "error",
        error: "Analyse impossible : " + e.message,
      });
      await upsertScan(domain, { url, status: "error", error: e.message, count: 0, solid: false });
      return entry;
    }

    let candidates = payload.candidates || [];
    const legalUrls = payload.legalUrls || [];
    let solid = candidates.some((c) => c.isEditor);

    // repli, si aucun editeur solide n'est trouve mais qu'il existe des
    // pages legales, on les ouvre en arriere-plan pour lire leur rendu JS
    if (!solid && legalUrls.length) {
      try {
        candidates = await scanLegalTabs(legalUrls.slice(0, 4), candidates);
        solid = candidates.some((c) => c.isEditor);
      } catch (_) {}
    }

    let aiStatus = null;
    let aiTrace = null;
    if (candidates.length) {
      try {
        const ai = await refineWithAI(candidates[0]);
        aiStatus = ai.aiStatus;
        aiTrace = ai.aiTrace;
      } catch (_) {}
    }

    const entry = await setCacheEntry(tabId, {
      status: candidates.length ? "ready" : "empty",
      candidates,
      legalUrls,
      solid,
      aiStatus,
      aiTrace,
      error: null,
    });
    await upsertScan(domain, {
      url,
      status: candidates.length ? "ready" : "empty",
      count: candidates.length,
      solid,
      bestSiren: candidates[0] ? candidates[0].siren : null,
      bestInfo: candidates[0] ? candidates[0].info || null : null,
      aiStatus,
      aiTrace,
      error: null,
      ms: Date.now() - started,
    });
    return entry;
  })();

  inflight.set(tabId, p);
  try {
    return await p;
  } finally {
    inflight.delete(tabId);
  }
}

// Vide uniquement ce qui est rattache a cette page (cache d'onglet, scan et
// enrichissement Pappers mis en cache pour son domaine), sans relancer de
// scan ici : le popup renvoie ensuite un "scanTab" force normal, exactement
// comme le bouton « Relancer l'analyse ».
async function clearTabCache(tabId, url) {
  await removeCacheEntry(tabId);
  await clearScanEntry(domainOf(url));
}

// --- Nettoyage du cache quand un onglet se ferme --------------------------
// Le scan n'est plus déclenché automatiquement : il est demandé par le popup
// (message "scanTab") à chaque ouverture, comme avant. Le cache ne sert
// qu'à éviter de rescanner une page déjà analysée si on rouvre le popup sans
// avoir navigué ailleurs.

chrome.tabs.onRemoved.addListener((tabId) => {
  removeCacheEntry(tabId).catch(() => {});
  inflight.delete(tabId);
});

// --- Messages depuis le popup --------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "fetchCompany") {
    fetchPappers(msg.siren, msg.url ? domainOf(msg.url) : null)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: "Erreur interne : " + e.message }));
    return true; // reponse asynchrone
  }

  // Recupere le texte d'une page legale, hors politique de securite du site.
  if (msg && msg.type === "fetchText" && msg.url) {
    (async () => {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(msg.url, { signal: ctrl.signal });
        clearTimeout(to);
        const text = await r.text();
        sendResponse({
          ok: r.ok,
          text,
          lastModified: r.headers.get("last-modified") || null,
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg && msg.type === "scanTab" && msg.tabId) {
    scanAndCache(msg.tabId, msg.url, { force: !!msg.force })
      .then(sendResponse)
      .catch((e) => sendResponse({ status: "error", error: "Analyse impossible : " + e.message }));
    return true;
  }

  if (msg && msg.type === "clearTab" && msg.tabId) {
    clearTabCache(msg.tabId, msg.url)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
