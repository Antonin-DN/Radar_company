# Radar société — extension Chrome (version locale)

Détecte le SIREN/SIRET sur la page consultée et affiche les informations
légales via Pappers, en un clic.

## Installation (mode développeur)

1. Décompresse le dossier `radar-societe`.
2. Ouvre `chrome://extensions`.
3. Active « Mode développeur » en haut à droite.
4. Clique « Charger l'extension non empaquetée » et sélectionne le dossier.
5. Épingle l'icône dans la barre, puis clique dessus → « Réglages » pour saisir
   ta clé Pappers.

## Fonctionnement

- Le scan se déclenche à l'ouverture du popup (clic sur l'icône), comme
  avant — pas d'accès permanent à tes pages. La logique de scan vit dans le
  service worker (`background.js`) et le popup lui demande le résultat par
  message ; le résultat est mis en cache par onglet
  (`chrome.storage.session`, vidé à la fermeture du navigateur) pour éviter
  de rescanner si tu rouvres le popup sans avoir changé de page. Le bouton
  « Relancer l'analyse » force un nouveau scan.
- Si aucun éditeur solide n'est trouvé sur la page ni dans le texte brut des
  pages légales, l'extension ouvre les pages de mentions légales/CGV dans un
  onglet d'arrière-plan (jamais mis au premier plan, tu restes sur ta page)
  pour en lire le rendu JavaScript, puis referme l'onglet.
- La détection repose sur une regex plus le contrôle de Luhn, ce qui écarte les
  numéros de téléphone et références qui ne sont pas des identifiants valides.
- Priorité aux identifiants proches d'un mot-clé (SIREN, SIRET, RCS, TVA,
  mentions légales) et à ceux portant un SIRET.
- Un second passage par l'IA locale de Chrome (Prompt API / Gemini Nano)
  affine nom, forme juridique et adresse à partir du texte trouvé, sans rien
  inventer si le modèle n'est pas disponible sur ce poste.
- L'appel à Pappers ne se déclenche jamais seul : c'est uniquement le bouton
  « Enrichir avec Pappers » qui l'appelle, une fois la clé enregistrée.
- La réponse Pappers est mise en cache par domaine (`chrome.storage.session`) :
  ré-enrichir la même société sur la même page ne refait pas d'appel réseau
  ni ne consomme un jeton supplémentaire. Le payload est allégé avant mise en
  cache (listes d'établissements, actes, comptes, BODACC… retirés) car la
  réponse brute peut peser plusieurs centaines de Ko.
- « ↻ Réinitialiser le scan de cette page » (sous le bouton Pappers) vide tout
  le cache lié à cette page — scan et enrichissement Pappers — puis relance
  un scan propre, sans appel Pappers. Utile si un résultat semble figé ou
  incorrect.

## Débogage

- « Réglages » (clic sur le bouton en haut du popup) n'ouvre pas une autre
  page : c'est une simple bascule de section à l'intérieur du même popup, un
  bouton « ← Retour » ramène à l'écran précédent. On y trouve la clé Pappers
  et « Scans récents » : un scan par domaine visité (les 10 derniers), avec
  ce qui a été détecté, l'état de l'IA locale et les derniers appels Pappers
  pour ce domaine. Gardé en `chrome.storage.session` — en mémoire tant que
  le navigateur reste ouvert, vidé à sa fermeture, jamais transmis nulle part.

## Points à adapter

- **Champs Pappers** : le rendu mappe les noms de champs courants de l'API v2,
  avec des variantes de secours. Ouvre « Données brutes » dans le popup pour voir
  la réponse réelle de ta formule, puis ajuste `renderCompany` dans `popup.js`.
- **Endpoint** : `background.js` appelle `api.pappers.fr/v2/entreprise`. Vérifie
  l'URL et les paramètres selon ta doc et ton abonnement.
- **Passage au proxy** : dans `background.js`, remplace le bloc d'appel direct par
  un appel à ton service serverless. La clé disparaît alors de l'extension. Le
  commentaire en tête du fichier indique la ligne exacte à changer.

## Sécurité de la clé

En version locale, la clé vit dans `chrome.storage` de chaque poste et reste
lisible par le détenteur du navigateur. C'est acceptable pour un usage interne
assumé. Pour mutualiser une clé sans l'exposer, bascule vers le proxy.
