/**
 * Traqueur injecté dans la page du mini-navigateur.
 *
 * Il détecte la lecture d'un élément média (le `<video>` de YouTube) et la
 * signale à l'application via `postMessage`. C'est ce qui fait apparaître le
 * bouton « Télécharger l'audio » : la lecture est le signal, pas la seule URL.
 *
 * La page YouTube monte son lecteur tardivement : un observateur de mutations
 * attend que l'élément existe, et chaque événement utile (`playing`, `pause`,
 * `timeupdate` pour battre la mesure) est écouté sur lui.
 */
export const TRAQUEUR_JS = `
(function () {
  if (window.__neurobeats_traqueur) return;
  window.__neurobeats_traqueur = true;

  function signaler(etat) {
    if (!window.ReactNativeWebView) return;
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "media", ...etat }));
  }

  function ecouter(element) {
    var lectureEnCours = function () {
      signaler({ enLecture: !element.paused && !element.ended });
    };
    var evenements = ["playing", "pause", "emptied", "ended", "seeking"];
    for (var i = 0; i < evenements.length; i++) {
      element.addEventListener(evenements[i], lectureEnCours, true);
    }
    lectureEnCours();
  }

  function chercher() {
    var element = document.querySelector("video") || document.querySelector("audio");
    if (element) {
      window.__neurobeats_element = element;
      ecouter(element);
      return true;
    }
    return false;
  }

  if (chercher()) return;
  var observateur = new MutationObserver(function () {
    if (chercher()) observateur.disconnect();
  });
  observateur.observe(document.documentElement, { childList: true, subtree: true });
})();
`;

/**
 * Met le média de la page en pause — injecté quand le mini-navigateur perd le
 * focus (on a changé d'onglet) : la page reste en place, mais le son s'arrête.
 * `true;` est la valeur que react-native-webview exige en retour.
 */
export const PAUSE_MEDIA_JS = `
(function () {
  var elements = document.querySelectorAll("video,audio");
  for (var i = 0; i < elements.length; i++) {
    elements[i].pause();
  }
  true;
})();
`;