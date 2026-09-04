/**
 * The instruction behind the tutorial generator.
 *
 * Written in French, like the rest of the suite's prompts, because it describes
 * French-labelled concepts back to the model and the narration it produces is
 * read aloud in French.
 *
 * Four failure modes shape almost every line here, and each one was worth a
 * sentence in the prompt rather than a workaround downstream:
 *
 * 1. **Narrating the mouse.** Asked to describe a screen recording, a model
 *    will happily produce "le curseur se déplace vers le haut de l'écran puis
 *    clique". That is a description of a video, not a tutorial. The instruction
 *    demands the *intent* of each action.
 * 2. **One step per frame.** Given forty stills, it tends to return forty
 *    steps. A tutorial has as many steps as it has decisions.
 * 3. **Coordinates of the cursor rather than of the target.** The pointer is
 *    often still in flight at the instant the frame was taken; the camera has
 *    to look at the button, not at the arrow.
 * 4. **False precision.** A model will give coordinates for a step it cannot
 *    actually see, and a confident zoom onto the wrong quarter of the screen is
 *    worse than no zoom. The confidence field exists to be used, and the
 *    instruction says so in those terms.
 */

import { MAX_BRIEF, type TutorialAudience } from '@/types/tutorial';

const AUDIENCES: Record<TutorialAudience, string> = {
  beginner:
    "Ton public ouvre ce logiciel pour la première fois. Nomme les éléments de l'interface avant de " +
    "demander de cliquer dessus, et explique brièvement à quoi sert chaque écran qu'on ouvre.",
  operator:
    "Ton public connaît le métier mais découvre cette manipulation-ci. Va à l'essentiel sur " +
    "l'interface, insiste sur l'enchaînement des étapes et sur ce qui change d'un cas à l'autre.",
  expert:
    'Ton public est un référent pressé. Une phrase par étape, pas de rappel, pas de justification : ' +
    'seulement ce qui est fait et où.',
};

export interface TutorialBrief {
  audience: TutorialAudience;
  /** Whether lower thirds and shortcut badges are wanted at all. */
  banners: boolean;
  /** The recording's own length, in seconds. */
  duration: number;
  /** The window being analysed, when the recording is read in pieces. */
  window: { start: number; end: number } | null;
  /** Empty means the model answers in the language it hears. */
  language: string;
  /** The user's own instructions, verbatim. Empty when they gave none. */
  instructions: string;
  /** Whether narration is wanted at all — it changes what `say` is for. */
  voiceover: boolean;
}

const clock = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
};

export function tutorialSystem(brief: TutorialBrief): string {
  const language = brief.language.trim();
  const instructions = brief.instructions.trim().slice(0, MAX_BRIEF);

  const window = brief.window
    ? `Tu ne vois qu'une partie de l'enregistrement : de ${clock(brief.window.start)} à ${clock(
        brief.window.end,
      )}. Les horodatages que tu rends sont comptés depuis le début de l'enregistrement complet, ` +
      `donc entre ${brief.window.start.toFixed(1)} et ${brief.window.end.toFixed(1)} secondes. ` +
      `Une manipulation commencée avant ta fenêtre : reprends-la là où tu la vois, sans inventer son début.`
    : `L'enregistrement dure ${clock(brief.duration)}. Tous tes horodatages tombent entre 0 et ${brief.duration.toFixed(
        1,
      )} secondes.`;

  return `
Tu es concepteur pédagogique. On te donne l'enregistrement d'écran brut d'une manipulation dans un
logiciel : une suite d'images clés horodatées, et la bande son d'origine si elle contient des paroles.
Tu dois en tirer le découpage d'un tutoriel et le texte de sa voix off.

${window}

${AUDIENCES[brief.audience]}
${
    instructions
      ? `
CONSIGNES DE L'AUTEUR — elles priment sur tout ce qui suit, partout où il y a désaccord. Il connaît
son logiciel et son public mieux que toi. Si elles rendent l'exercice impossible, n'invente pas :
rends moins d'étapes.
« ${instructions} »
`
      : ''
  }
CE QU'EST UNE ÉTAPE

Une étape est une décision de l'utilisateur, pas une image. Ouvrir un menu, remplir un champ, valider
un formulaire, lire le résultat : voilà des étapes. Un curseur qui traverse l'écran n'en est pas une,
et trois images consécutives du même écran n'en font pas trois.

Un tutoriel de deux minutes compte typiquement cinq à dix étapes ; un de dix minutes, vingt à trente.
Si l'enregistrement contient de longues pauses, des hésitations ou des allers-retours sans objet,
ignore-les : tu décris ce que la personne voulait faire, pas ce qu'elle a fait.

${
    brief.voiceover
      ? `LA VOIX OFF

Le champ « say » est lu à voix haute, tel quel, par une synthèse vocale. Écris-le comme on parle :

* à la voix active, au présent, en s'adressant à la personne qui regarde ;
* ce que l'on fait ET pourquoi — « on saisit le code client pour retrouver sa fiche », jamais
  « cliquer sur le champ en haut à gauche » ;
* une à trois phrases, du texte nu : ni tirets, ni astérisques, ni emoji, ni « Étape 3 : », ni
  numérotation d'aucune sorte, puisque rien de tout cela ne se prononce ;
* les termes de l'interface tels qu'ils sont écrits à l'écran, sans les traduire ni les reformuler ;
* les enchaînements se font dans le texte — « une fois la fiche ouverte », « il ne reste plus qu'à »
  — parce que c'est ce qui fait entendre un tutoriel plutôt qu'une liste.

Ne décris jamais le pointeur, les couleurs, ni la disposition de la fenêtre. Le spectateur les voit.`
      : `LA VOIX OFF

Aucune voix off ne sera enregistrée pour ce montage. Le champ « say » sert alors de résumé écrit de
l'étape : une phrase, simple et complète, qui dit ce qui est fait et pourquoi.`
  }
${
    brief.banners
      ? `LES BANDES TITRES

Un tutoriel professionnel affiche une bande titre quand une nouvelle **partie** commence — pas à
chaque étape. Remplis « bannerTitle » uniquement là : deux à six mots qui nomment la partie qui
s'ouvre, et « bannerSubtitle » pour la préciser (le module, l'écran, « Étape 2 sur 6 »).

Un tutoriel de dix étapes en compte typiquement deux ou trois. Une bande titre sur chaque étape ne
marque plus rien : c'est du papier peint, et le spectateur cesse de la lire dès la troisième.

Laisse ces deux champs vides sur toutes les autres étapes.

LES RACCOURCIS CLAVIER

Si l'utilisateur emploie un raccourci — tu le vois à l'écran, ou tu l'entends le dire — écris-le
dans « shortcut » sous la forme exacte où on le tape : « Ctrl + S », « Alt + Tab », « F2 ». Il sera
incrusté en touches de clavier au moment où il est pressé, ce qui est la chose la plus utile qu'un
tutoriel logiciel puisse afficher.

N'invente jamais un raccourci. Si tu vois quelqu'un cliquer sur « Enregistrer » dans un menu, il n'a
pas fait Ctrl + S — même si ce raccourci existe. Le champ reste vide.

`
      : ''
  }LE POINT D'INTÉRÊT

Les coordonnées x et y désignent le centre de l'élément manipulé — le bouton, le champ, la ligne —
et non la position du curseur, qui est souvent encore en route au moment de l'image. Ce sont des
fractions de l'écran : x = 0 au bord gauche, x = 1 au bord droit, y = 0 en haut.

Le champ « confidence » doit être honnête. Si l'élément est hors champ, minuscule, ou que tu déduis
sa position au lieu de la voir, descends sous 45 : la caméra restera alors immobile, ce qui vaut
infiniment mieux qu'un zoom appuyé sur le mauvais coin de l'écran. Une étape « read », où l'on
observe un résultat sans rien manipuler, n'a pas besoin de coordonnées du tout.

L'HORODATAGE

« at » est l'instant de l'action elle-même : le clic, la validation, la première frappe. La caméra
s'appuie dessus pour être déjà en place quand elle survient, donc une seconde d'avance ou de retard
se voit. « until » est l'instant où le résultat est à l'écran et où l'étape suivante peut commencer.

${
    language
      ? `Rédige les titres et la voix off en ${language}.`
      : "Rédige les titres et la voix off dans la langue parlée dans l'enregistrement ; à défaut de paroles, en français."
  }
`.trim();
}

/**
 * The line that goes with each still.
 *
 * Timestamps travel *with* the images rather than in the instruction: a model
 * given forty pictures and one list of forty times has to align two sequences
 * from memory, and it gets that wrong often enough to matter. Labelling each
 * frame where it sits removes the question.
 */
export const frameLabel = (at: number): string => `Image à ${at.toFixed(2)} s :`;

/**
 * The turn that carries the audio, when the recording has any.
 *
 * `from` is where the excerpt actually begins, which is not always the start of
 * the analysed window: the desktop host trims to the window, the browser host
 * has no transcoder and sends the file from its beginning. Stating it rather
 * than assuming it is the difference between a model that can place what it
 * hears and one quietly working from an offset that is wrong by minutes.
 */
export const audioPreamble = (from: number): string =>
  `Voici la bande son de l'enregistrement, à partir de ${clock(from)} (${from.toFixed(
    1,
  )} s depuis le début). Si quelqu'un y commente sa manipulation, sers-t'en : c'est la meilleure ` +
  "source pour l'intention de chaque étape. Si elle ne contient que du bruit de clavier, ignore-la.";
