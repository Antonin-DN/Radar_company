"use strict";

// --- Utilitaires d'affichage --------------------------------------------

function show(id) {
  document.querySelectorAll(".state").forEach((s) => s.classList.remove("on"));
  document.getElementById(id).classList.add("on");
}

function formatSiren(siren) {
  // 123456789 -> 123 456 789
  return siren.replace(/(\d{3})(\d{3})(\d{3})/, "$1 $2 $3");
}

function esc(v) {
  if (v === null || v === undefined || v === "") return "—";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

// Injectee au clic sur le SIREN, defile jusqu'a lui et le surligne.
function highlightOnPage(variants) {
  const sel = window.getSelection();
  for (const v of variants) {
    if (!v) continue;
    try {
      sel.removeAllRanges();
    } catch (_) {}
    if (window.find && window.find(v, false, false, true, false, true, false)) {
      const r = sel.rangeCount ? sel.getRangeAt(0) : null;
      const el = r && r.startContainer.parentElement;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        const bg = el.style.backgroundColor;
        el.style.transition = "background-color .3s";
        el.style.backgroundColor = "#fff3a3";
        setTimeout(() => (el.style.backgroundColor = bg), 2200);
      }
      return true;
    }
  }
  return false;
}

// --- Enrichissement via le service worker --------------------------------

function fetchCompany(siren, url) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "fetchCompany", siren, url }, resolve);
  });
}

// Envoie un message au service worker, resout null si le canal echoue
// (par exemple si le service worker vient d'etre redemarre).
function sendMsg(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r));
    } catch (_) {
      resolve(null);
    }
  });
}

// --- Rendu de la fiche société -------------------------------------------

function pickStatus(d) {
  const consolide = (d.statut_consolide || "").toLowerCase();
  if (d.entreprise_cessee === true || /cess|radi/.test(consolide)) {
    return { cls: "bad", label: "Cessée" };
  }
  if (consolide) return { cls: "ok", label: "En activité" };
  // repli si le champ consolide manque, sur l'ancien statut RCS
  if (d.statut_rcs && /activ|inscrit/i.test(d.statut_rcs)) return { cls: "ok", label: "En activité" };
  return { cls: "warn", label: "Statut inconnu" };
}

// Nom d'affichage : la denomination officielle, avec le sigle entre
// parentheses seulement s'il n'y figure pas deja (nom_entreprise le prefixe).
function companyName(d) {
  const base = d.denomination || d.nom_entreprise || d.nom || "Société";
  if (d.sigle && !base.includes(d.sigle)) return `${base} (${d.sigle})`;
  return base;
}

// Chiffre d'affaires et resultat du dernier exercice clos, si disponibles.
function latestFinance(d) {
  const list = (d.finances || []).slice().sort((a, b) => (b.annee || 0) - (a.annee || 0));
  return list[0] || null;
}

function renderCompany(siren, d) {
  const nom = companyName(d);
  const forme = d.forme_juridique || "—";
  const sirenF = d.siren_formate || formatSiren(siren);
  const siege = d.siege || {};
  const siret = siege.siret_formate || siege.siret || "—";
  const naf = d.code_naf || siege.code_naf || "";
  const libNaf = d.libelle_code_naf || siege.libelle_code_naf || "";
  const nafText = [naf, libNaf].filter(Boolean).join(" — ") || "—";
  const capital = d.capital_formate || (d.capital ? Number(d.capital).toLocaleString("fr-FR") + " €" : "—");
  const creation = d.date_creation_formate || d.date_creation || "—";
  const ville = [siege.code_postal, siege.ville].filter(Boolean).join(" ") || "—";
  const effectif = d.effectif || "—";
  const tva = d.numero_tva_intracommunautaire || "—";
  const status = pickStatus(d);

  const reps = d.representants || d.dirigeants || [];
  const people = reps
    .slice(0, 8)
    .map((r) => {
      const who = r.nom_complet || [r.prenom, r.nom].filter(Boolean).join(" ") || r.denomination || "—";
      const role = r.qualite || r.fonction || "";
      return `<li><span class="who">${esc(who)}</span><span class="role">${esc(role)}</span></li>`;
    })
    .join("");

  const fin = latestFinance(d);
  const money = (n) => (typeof n === "number" ? n.toLocaleString("fr-FR") + " €" : "—");
  const finance = fin
    ? `
      <div class="section-label">Dernier exercice (${esc(fin.annee)})</div>
      <dl class="fin-grid">
        <dt>Chiffre d'affaires</dt><dd>${money(fin.chiffre_affaires)}</dd>
        <dt>Résultat</dt><dd class="${typeof fin.resultat === "number" && fin.resultat < 0 ? "neg" : "pos"}">${money(fin.resultat)}</dd>
      </dl>`
    : "";

  const rawJson = JSON.stringify(d, null, 2);

  return `
    <p class="name">${esc(nom)}</p>
    <p class="sub">${esc(forme)} · <span class="pill ${status.cls}">${status.label}</span></p>
    <dl class="grid">
      <dt>SIREN</dt><dd class="mono">${esc(sirenF)}</dd>
      <dt>SIRET siège</dt><dd class="mono">${esc(siret)}</dd>
      <dt>Code APE</dt><dd>${esc(nafText)}</dd>
      <dt>Effectif</dt><dd>${esc(effectif)}</dd>
      <dt>Capital</dt><dd>${esc(capital)}</dd>
      <dt>TVA intracom.</dt><dd class="mono">${esc(tva)}</dd>
      <dt>Création</dt><dd>${esc(creation)}</dd>
      <dt>Siège</dt><dd>${esc(ville)}</dd>
    </dl>
    ${finance}
    ${people ? `<div class="section-label">Dirigeants</div><ul class="people">${people}</ul>` : ""}
    <div class="footer-links">
      <a href="https://www.pappers.fr/entreprise/${siren}" target="_blank" rel="noreferrer">Fiche Pappers</a>
      <a href="https://annuaire-entreprises.data.gouv.fr/entreprise/${siren}" target="_blank" rel="noreferrer">Annuaire officiel</a>
    </div>
    <details class="raw">
      <summary>Données brutes (adapter le mapping des champs)</summary>
      <pre>${esc(rawJson)}</pre>
    </details>
  `;
}

// --- Orchestration ---------------------------------------------------------
// Le scan tourne dans le service worker, en arriere-plan, des qu'un onglet
// finit de charger (voir background.js). Le popup lit simplement le resultat
// mis en cache pour l'onglet actif ; s'il n'existe pas encore (extension
// venant d'etre installee/rechargee, onglet ouvert avant), il demande un
// scan et attend la reponse.

let candidates = [];
let currentSiren = null;
let currentEntry = null;
let hasKey = false;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isScannableUrl(url) {
  return !!url && /^https?:\/\//i.test(url);
}

async function readCacheEntry(tabId) {
  const { radarCache = {} } = await chrome.storage.session.get("radarCache");
  return radarCache[tabId] || null;
}

// Reponse Pappers deja en cache pour le domaine de la page courante, si
// elle correspond au SIREN actuellement affiche.
async function getCachedCompanyForCurrent() {
  if (!currentEntry || !currentEntry.url || !currentSiren) return null;
  try {
    const { radarScans = {} } = await chrome.storage.session.get("radarScans");
    let domain;
    try {
      domain = new URL(currentEntry.url).hostname;
    } catch (_) {
      domain = currentEntry.url;
    }
    const c = radarScans[domain] && radarScans[domain].company;
    return c && c.siren === currentSiren ? c.data : null;
  } catch (_) {
    return null;
  }
}

// Affiche la fiche societe dans la meme vue (pas de bascule d'ecran) et
// efface les commandes d'enrichissement, devenues inutiles.
function renderCompanyInline(data) {
  document.getElementById("companyContent").innerHTML = renderCompany(currentSiren, data);
  document.getElementById("enrich").style.display = "none";
  document.getElementById("voirPlus").style.display = "none";
}

// Bouton « Enrichir avec Pappers » si rien n'est encore enrichi, lien
// « Voir plus » si une reponse est deja en cache pour ce SIREN (affichage
// instantane, sans nouvel appel) — jamais les deux a la fois.
function updateEnrichControls(cached) {
  const enrichBtn = document.getElementById("enrich");
  const voirPlus = document.getElementById("voirPlus");
  if (!enrichBtn || !voirPlus) return;
  if (cached) {
    enrichBtn.style.display = "none";
    voirPlus.style.display = "";
  } else {
    enrichBtn.style.display = "";
    enrichBtn.textContent = hasKey ? "Enrichir avec Pappers" : "Ajouter une clé Pappers pour enrichir";
    voirPlus.style.display = "none";
  }
}

// Deja enrichi pour le SIREN affiche : on l'insere directement dans la
// meme vue plutot que de repasser par la case « Enrichir ». Appelee apres
// chaque selectCandidate (chargement initial ou changement de candidat).
async function refreshCompanySection() {
  document.getElementById("companyContent").innerHTML = "";
  const cached = await getCachedCompanyForCurrent();
  if (cached) {
    renderCompanyInline(cached);
  } else {
    updateEnrichControls(false);
  }
}

async function applyEntry(entry) {
  currentEntry = entry;
  candidates = (entry && entry.candidates) || [];

  if (!entry || entry.status === "error") {
    document.getElementById("errorMsg").textContent =
      (entry && entry.error) || "Impossible d'analyser cette page.";
    show("state-error");
    return;
  }
  if (!candidates.length) {
    show("state-empty");
    return;
  }
  selectCandidate(0);
  await refreshCompanySection();
  show("state-found");
}

async function loadForTab(tab, { force = false } = {}) {
  show("state-loading");
  let entry = force ? null : await readCacheEntry(tab.id);
  if (!entry || entry.url !== tab.url || entry.status === "scanning" || force) {
    entry = await sendMsg({ type: "scanTab", tabId: tab.id, url: tab.url, force });
  }
  await applyEntry(entry);
}

async function runScan() {
  const tab = await getActiveTab();
  if (!tab || !tab.id || !isScannableUrl(tab.url)) {
    show("state-empty");
    return;
  }
  await loadForTab(tab, { force: true });
}

// Purge tout ce qui est en cache pour cette page (cache d'onglet, scan et
// enrichissement Pappers pour ce domaine) puis relance un scan propre, sans
// appel Pappers. Utile si un cache semble incorrect ou perime.
async function resetScan() {
  const tab = await getActiveTab();
  if (!tab || !tab.id || !isScannableUrl(tab.url)) {
    show("state-empty");
    return;
  }
  // vide le cache lie a cette page, puis relance exactement comme le bouton
  // « Relancer l'analyse » (meme appel, un seul chemin de code pour les deux)
  await sendMsg({ type: "clearTab", tabId: tab.id, url: tab.url });
  await loadForTab(tab, { force: true });
}

// Lignes de la fiche courante, dans l'ordre affiché ; alimente les boutons
// copier (un par ligne, tous génériques). Partagees entre la vue live
// (selectCandidate) et la vue historique (viewHistoricalCompany).
let infoRows = [];

function renderInfoRows(rows) {
  infoRows = rows;
  const pi = document.getElementById("pageInfo");
  pi.innerHTML = rows
    .map(
      (r, idx) => `
        <div class="pi-row">
          <span class="pi-k">${esc(r.label)}</span>
          <span class="pi-v">${r.html}</span>
          <button class="pi-copy" type="button" data-i="${idx}" title="Copier">${COPY_ICON}</button>
        </div>`
    )
    .join("");

  pi.querySelectorAll(".pi-copy").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = infoRows[Number(btn.dataset.i)];
      if (!row) return;
      await navigator.clipboard.writeText(row.copyValue);
      btn.innerHTML = CHECK_ICON;
      btn.classList.add("done");
      setTimeout(() => {
        btn.innerHTML = COPY_ICON;
        btn.classList.remove("done");
      }, 1200);
    });
  });
}

function selectCandidate(i) {
  const c = candidates[i];
  currentSiren = c.siren;
  const où = c.sourceUrl ? "trouvé dans les mentions légales" : "détecté sur la page";
  document.getElementById("foundLabel").textContent =
    (c.siret ? "SIRET " : "SIREN ") + où;

  // etat par defaut immediat ; refreshCompanySection() (appelee par
  // l'appelant) corrige juste apres si Pappers est deja en cache
  updateEnrichControls(false);

  // le SIREN est la premiere ligne de la liste, comme les autres donnees,
  // juste en gras ; il reste cliquable pour se rendre sur la page
  const info = c.info || {};
  const rows = [
    {
      label: c.siret ? "SIRET" : "SIREN",
      html: `<b class="mono" id="foundSiren" style="cursor:pointer" title="Cliquer pour voir l'emplacement sur la page">${formatSiren(c.siren)}</b>`,
      copyValue: c.siren,
    },
  ];
  if (info.raison) rows.push({ label: "Raison sociale", html: esc(info.raison), copyValue: info.raison });
  if (info.forme) rows.push({ label: "Forme", html: esc(info.forme), copyValue: info.forme });
  if (info.adresse) rows.push({ label: "Siège", html: esc(info.adresse), copyValue: info.adresse });
  if (info.email)
    rows.push({
      label: "Contact",
      html: `<a href="mailto:${esc(info.email)}">${esc(info.email)}</a>`,
      copyValue: info.email,
    });
  renderInfoRows(rows);

  // clic sur le SIREN, on va a son emplacement sur la page ou sur la page legale
  document.getElementById("foundSiren").addEventListener("click", () => locateCandidate(c));

  const alts = document.getElementById("alts");
  if (candidates.length > 1) {
    alts.innerHTML =
      "Autres candidats : " +
      candidates
        .map((cand, idx) =>
          idx === i ? "" : `<button data-i="${idx}">${formatSiren(cand.siren)}</button>`
        )
        .join(" ");
    alts.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", async () => {
        selectCandidate(Number(b.dataset.i));
        await refreshCompanySection();
      })
    );
  } else {
    alts.innerHTML = "";
  }
}

// Va a l'emplacement du candidat : defile et surligne sur la page courante,
// ou ouvre la page legale distante a l'ancre du texte trouve.
async function locateCandidate(c) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) return;

  if (c.sourceUrl) {
    const frag = "#:~:text=" + encodeURIComponent(c.match || c.siren);
    chrome.tabs.update(tab.id, { url: c.sourceUrl + frag });
    window.close();
    return;
  }
  const variants = [c.match, formatSiren(c.siren), c.siren, c.siret].filter(Boolean);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: highlightOnPage,
      args: [variants],
    });
    window.close();
  } catch (_) {}
}

async function doEnrich() {
  if (!hasKey) {
    // detection validee, il manque juste la cle pour l'appel Pappers
    openSettings();
    return;
  }
  const btn = document.getElementById("enrich");
  btn.disabled = true;
  btn.textContent = "Interrogation de Pappers…";

  const res = await fetchCompany(currentSiren, currentEntry && currentEntry.url);
  btn.disabled = false;
  btn.textContent = "Enrichir avec Pappers";

  if (!res || res.error) {
    document.getElementById("errorMsg").textContent =
      (res && res.error) || "Réponse vide du service.";
    show("state-error");
    return;
  }

  renderCompanyInline(res.data);
}

// « Voir plus » : donnee deja en cache, affichage immediat sans appel reseau.
async function showCachedCompany() {
  const cached = await getCachedCompanyForCurrent();
  if (cached) renderCompanyInline(cached);
}

// --- Réglages : clé Pappers + scans récents, sans quitter le popup --------
// Simple changement de section dans le meme document, pas de navigation
// vers une autre page.

const EYE_OPEN =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 1 12s4 7 11 7a9.26 9.26 0 0 0 5.39-1.61"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

const GEAR_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const BACK_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';

function maskKey(k) {
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return k.slice(0, 4) + "•".repeat(Math.max(4, k.length - 8)) + k.slice(-4);
}

let realKey = "";
let keyRevealed = false;
let settingsReturnTo = "state-found";

function renderKeyField() {
  const input = document.getElementById("apiKeyInput");
  input.value = keyRevealed ? realKey : maskKey(realKey);
  input.type = keyRevealed ? "text" : "password";
  const toggle = document.getElementById("toggleShowKey");
  toggle.innerHTML = keyRevealed ? EYE_OPEN : EYE_OFF;
  toggle.title = keyRevealed ? "Masquer la clé" : "Afficher la clé";
  // un seul des deux a la fois : enregistrer tant qu'il n'y a pas de cle,
  // retirer une fois qu'il y en a une (la retirer fait reapparaitre enregistrer)
  document.getElementById("saveKey").style.display = realKey ? "none" : "";
  document.getElementById("removeKey").style.display = realKey ? "" : "none";
  document.getElementById("keyStatusLine").innerHTML = realKey
    ? '<span class="k">Clé enregistrée</span> — utilisée par « Enrichir avec Pappers ».'
    : '<span class="n">Aucune clé enregistrée</span> — l\'enrichissement restera désactivé.';
}

function summaryLineScan(e) {
  if (e.status === "error") return e.error || "erreur";
  if (!e.count) return "aucun SIREN détecté";
  // le SIREN est deja dans le detail juste en dessous, pas la peine de le
  // repeter ici
  const bits = [];
  if (e.pappers && e.pappers.length) bits.push(e.pappers.length + " appel(s) Pappers");
  return bits.join(" — ") || "SIREN détecté";
}

function scanDetailRows(e) {
  const rows = [{ k: "Scan", v: esc(e.ts ? new Date(e.ts).toLocaleString("fr-FR") : "—") }];
  rows.push({ k: "URL", v: esc(e.url || "—") });
  if (e.bestSiren) rows.push({ k: "SIREN", v: esc(formatSiren(e.bestSiren)) });
  if (e.aiStatus) rows.push({ k: "IA locale", v: esc(e.aiStatus) });
  if (e.pappers && e.pappers.length) {
    const last = e.pappers
      .slice()
      .reverse()
      .map((p) =>
        esc(
          `${new Date(p.t).toLocaleTimeString("fr-FR")} · ${p.ok ? "OK" : "erreur : " + (p.error || "")}`
        )
      )
      .join("<br>");
    rows.push({ k: "Pappers", v: last });
  }
  return rows
    .map((r) => `<div class="detail-row"><span class="k">${esc(r.k)}</span><span class="v">${r.v}</span></div>`)
    .join("");
}

// Bascule depuis « Scans récents » vers la vue principale, avec la fiche
// deja en cache pour ce domaine (aucun nouvel appel, aucun besoin d'etre
// sur la page d'origine). Fonctionne avec ou sans fiche Pappers en cache.
function viewHistoricalCompany(e) {
  if (!e) return;
  currentSiren = (e.company && e.company.siren) || e.bestSiren || null;
  currentEntry = { url: e.url || null };
  candidates = [];
  document.getElementById("foundLabel").textContent = "Historique — " + e.domain;

  const info = e.bestInfo || {};
  const rows = [];
  if (currentSiren) {
    rows.push({ label: "SIREN", html: `<b class="mono">${formatSiren(currentSiren)}</b>`, copyValue: currentSiren });
  }
  if (info.raison) rows.push({ label: "Raison sociale", html: esc(info.raison), copyValue: info.raison });
  if (info.forme) rows.push({ label: "Forme", html: esc(info.forme), copyValue: info.forme });
  if (info.adresse) rows.push({ label: "Siège", html: esc(info.adresse), copyValue: info.adresse });
  if (info.email)
    rows.push({
      label: "Contact",
      html: `<a href="mailto:${esc(info.email)}">${esc(info.email)}</a>`,
      copyValue: info.email,
    });
  renderInfoRows(rows);
  document.getElementById("alts").innerHTML = "";

  if (e.company) {
    renderCompanyInline(e.company.data);
  } else {
    document.getElementById("companyContent").innerHTML = "";
    updateEnrichControls(false);
  }

  const btn = document.getElementById("openSettings");
  btn.innerHTML = GEAR_ICON;
  btn.title = "Réglages";
  document.getElementById("resetScan").style.display = "";
  show("state-found");
}

function renderScans(radarScans) {
  const list = document.getElementById("scanList");
  const entries = Object.values(radarScans || {}).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!entries.length) {
    list.innerHTML = '<p class="scan-empty">Aucun scan pour l\'instant.</p>';
    return;
  }
  list.innerHTML = entries
    .map((e, idx) => {
      const t = e.ts
        ? new Date(e.ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
        : "";
      return `
        <details class="scan-item">
          <summary>
            <span class="scan-domain">${esc(e.domain)}</span>
            <span class="scan-badge ${esc(e.status)}">${esc(e.status || "?")}</span>
            <span class="scan-summary">${esc(summaryLineScan(e))}</span>
            <span class="scan-time">${esc(t)}</span>
          </summary>
          ${scanDetailRows(e)}
          <a href="#" class="scan-view" data-i="${idx}">Voir plus →</a>
        </details>`;
    })
    .join("");
  list.querySelectorAll(".scan-view").forEach((a) => {
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      viewHistoricalCompany(entries[Number(a.dataset.i)]);
    });
  });
}

async function loadScans() {
  const { radarScans } = await chrome.storage.session.get("radarScans");
  renderScans(radarScans);
}

async function loadSettings() {
  const { pappersApiKey } = await chrome.storage.local.get("pappersApiKey");
  realKey = pappersApiKey || "";
  keyRevealed = false;
  renderKeyField();
  await loadScans();
}

function openSettings() {
  const current = document.querySelector(".state.on");
  settingsReturnTo = (current && current.id) || "state-found";
  const btn = document.getElementById("openSettings");
  btn.innerHTML = BACK_ICON;
  btn.title = "Retour";
  // pas de rescan pertinent depuis l'ecran reglages, on ne garde que le retour
  document.getElementById("resetScan").style.display = "none";
  show("state-settings");
  loadSettings();
}

function closeSettings() {
  const btn = document.getElementById("openSettings");
  btn.innerHTML = GEAR_ICON;
  btn.title = "Réglages";
  document.getElementById("resetScan").style.display = "";
  refreshCompanySection();
  show(settingsReturnTo);
}

// Le meme bouton d'en-tete ouvre les reglages ou y ramene : son libelle
// change selon qu'on y est deja ou non, pas besoin d'un second bouton.
function toggleSettings() {
  const current = document.querySelector(".state.on");
  if (current && current.id === "state-settings") closeSettings();
  else openSettings();
}

// --- Démarrage ------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("openSettings").addEventListener("click", toggleSettings);
  document.getElementById("rescan1").addEventListener("click", runScan);
  document.getElementById("rescan2").addEventListener("click", runScan);
  document.getElementById("enrich").addEventListener("click", doEnrich);
  document.getElementById("voirPlus").addEventListener("click", (e) => {
    e.preventDefault();
    showCachedCompany();
  });
  document.getElementById("resetScan").addEventListener("click", resetScan);

  document.getElementById("toggleShowKey").addEventListener("click", () => {
    keyRevealed = !keyRevealed;
    renderKeyField();
  });
  document.getElementById("apiKeyInput").addEventListener("focus", () => {
    if (!keyRevealed) {
      keyRevealed = true;
      renderKeyField();
    }
  });
  document.getElementById("saveKey").addEventListener("click", async () => {
    realKey = document.getElementById("apiKeyInput").value.trim();
    await chrome.storage.local.set({ pappersApiKey: realKey });
    hasKey = !!realKey;
    keyRevealed = false;
    renderKeyField();
    const flag = document.getElementById("keySaved");
    flag.classList.add("on");
    setTimeout(() => flag.classList.remove("on"), 1500);
  });
  document.getElementById("removeKey").addEventListener("click", async () => {
    await chrome.storage.local.remove("pappersApiKey");
    realKey = "";
    hasKey = false;
    keyRevealed = false;
    renderKeyField();
  });
  document.getElementById("clearScans").addEventListener("click", async () => {
    await chrome.storage.session.set({ radarScans: {} });
    loadScans();
  });

  const { pappersApiKey } = await chrome.storage.local.get("pappersApiKey");
  hasKey = !!pappersApiKey;

  const tab = await getActiveTab();
  if (!tab || !tab.id || !isScannableUrl(tab.url)) {
    show("state-empty");
    return;
  }
  await loadForTab(tab);
});
