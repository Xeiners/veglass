/**
 * What Gemini is told before it says anything.
 *
 * The whole of the copilot's intelligence about *this* montage is in here, and
 * none of it is guesswork: the tempo, the three movements and their boundaries,
 * the reference's measured shot lengths, the clips actually available. The model
 * is not asked to work any of it out — all of it is already measured — it is
 * asked to have an opinion about what to do with it.
 *
 * That distinction is the design. A copilot told nothing invents numbers and
 * they are wrong; a copilot told everything argues about intent, which is the
 * only part a language model is actually better at than the arithmetic.
 *
 * # Why the measurements go in the system instruction
 *
 * Gemini keeps the system instruction in front of the model for every turn,
 * while a first user message drifts out of a long conversation's window. The
 * facts must not drift: a model that has forgotten the drop is at 00:41 will
 * cheerfully agree to move it.
 */

import { formatClock } from '@/lib/time';
import type { DirectorContext } from '@/types/director';
import type { PhaseId } from '@/types/amv';

/** How many clip names travel with the prompt before it becomes a list. */
const MAX_CLIPS = 24;

const PHASE_WORD: Record<PhaseId, string> = {
  intro: 'intro',
  build: 'montée',
  drop: 'drop',
};

const seconds = (value: number): string =>
  `${value.toFixed(value < 1 ? 2 : 1).replace('.', ',')} s`;

/**
 * The role, the rules, and everything measured about this montage.
 *
 * Rebuilt on every turn rather than cached: the user can change the music, add
 * clips or drop the reference between two messages, and a stale brief is worse
 * than none — it is a confident answer about a montage that no longer exists.
 */
export function directorSystem(context: DirectorContext): string {
  const lines: string[] = [];

  lines.push(
    `Tu es chef monteur, spécialiste des edits rythmés courts — AMV, Shorts, TikTok.`,
    `Tu pilotes un moteur de montage qui coupe sur les temps forts d'une musique et découpe le montage en trois mouvements : intro, montée, drop.`,
    '',
    `## Ce que tu décides`,
    `Le profil (« aggressive » ou « cinematic »), la durée moyenne d'un plan dans chacun des trois mouvements, quatre effets (punch, flashes, split, smear) — et surtout **la distribution des rushs** : quel plan ouvre le montage, et quels plans sont réservés à quel mouvement.`,
    '',
    `## Les trois règles de montage`,
    `**1. Coupe sur le sens, pas seulement sur le temps.** Le moteur pose les coupes sur les temps forts ; c'est à toi de décider ce qu'il y a dessus. Un plan dont l'action démarre ou culmine doit tomber sur un impact, pas sur un temps faible. Réserve tes plans les plus dynamiques au drop, et refuse d'y mettre un plan immobile sous prétexte qu'il faut bien remplir.`,
    `**2. Laisse respirer l'intro.** Les plans d'ouverture doivent être longs, stables et lisibles — le spectateur doit avoir le temps de regarder. Les plans du drop sont courts et percutants. Un montage qui commence déjà saturé n'a nulle part où aller.`,
    `**3. Les effets de choc se méritent.** L'aberration chromatique et les flashs négatifs ne sont pas une texture : ils sont réservés à un ou deux impacts dans tout l'edit. Le moteur les espace déjà, mais si tu penses que ce morceau n'a pas de moment qui les justifie, coupe-les.`,
    `Les durées de plan doivent décroître d'un mouvement au suivant. Un montage qui coupe plus vite en intro qu'au drop n'a pas de forme.`,
    '',
    `## Ce que tu ne décides pas`,
    `L'instant exact des coupes, la position du drop, le tempo : tout cela est mesuré et posé par le moteur, à la milliseconde, sur la musique. Ne propose jamais de déplacer un temps fort ni de changer la structure du morceau — tu choisis *ce qu'il y a* sur chaque coupe, pas *où* elle tombe.`,
    '',
    `## Mesures`,
  );

  /* ---- the music ---- */
  if (context.music) {
    lines.push(
      `Musique : « ${context.music.name} », ${formatClock(context.music.duration)}.`,
      context.tempo !== null
        ? `Tempo mesuré : ${context.tempo} BPM, ${context.beats} temps détectés.`
        : `Tempo irrégulier ; ${context.beats} temps détectés.`,
    );
  } else {
    lines.push(`Musique : aucune choisie pour l'instant.`);
  }

  /* ---- the arc ---- */
  if (context.arc.length > 0) {
    const arc = context.arc
      .map(
        (phase) =>
          `${PHASE_WORD[phase.id]} ${formatClock(phase.from)}–${formatClock(phase.to)}`,
      )
      .join(', ');
    lines.push(
      `Structure de la musique (${
        context.arcSource === 'measured' ? 'mesurée sur la piste' : 'supposée, faute de rupture nette'
      }) : ${arc}.`,
    );
  }

  /* ---- the rushes ---- */
  if (context.clips.length > 0) {
    const shown = context.clips.slice(0, MAX_CLIPS);
    const total = context.clips.reduce((sum, clip) => sum + clip.duration, 0);
    const described = shown.filter((clip) => clip.note !== null).length;

    lines.push(
      '',
      `## Les rushs`,
      `${context.clips.length} clips, ${formatClock(total)} au total.`,
      /*
       * The notes, when the frames were looked at.
       *
       * A clip with no note is named as unlabelled rather than left to look
       * described-but-empty: the model must know which of its choices rest on
       * something it saw and which are a guess from a filename.
       */
      shown
        .map(
          (clip) =>
            `- ${clip.name} (${formatClock(clip.duration)})` +
            (clip.note ? ` — ${clip.note}` : ' — non décrit'),
        )
        .join('\n') +
        (context.clips.length > shown.length
          ? `\n- … et ${context.clips.length - shown.length} autres, non décrits`
          : ''),
    );

    if (context.looked && described > 0) {
      lines.push(
        `Ces descriptions viennent d'images réellement extraites des fichiers. Sers-t'en pour distribuer les plans : le mouvement décrit est ce qui décide si un plan tient un temps calme ou encaisse un impact.`,
      );
    } else {
      lines.push(
        `Aucun clip n'a pu être décrit. Traite-les comme une séquence narrative d'après leurs noms et leurs durées : un plan d'ouverture, des plans d'action, des plans de transition — et dis dans ta réponse que tu travailles sans les avoir vus.`,
      );
    }
  } else {
    lines.push(`Clips disponibles : aucun pour l'instant.`);
  }

  /* ---- the reference ---- */
  if (context.reference) {
    const ref = context.reference;
    lines.push(
      '',
      `## Référence fournie par l'utilisateur`,
      `« ${ref.title} » : ${ref.cuts} coupes mesurées sur ${formatClock(ref.duration)}.`,
      `Elle tient un plan ${seconds(ref.shot.intro)} en intro, ${seconds(ref.shot.build)} en montée et ${seconds(ref.shot.drop)} au drop.`,
      ref.arcSource === 'measured'
        ? `Sa propre structure en trois temps a été mesurée sur sa bande-son ; son drop tombe à ${Math.round(ref.dropAt * 100)} % de sa durée.`
        : `Sa bande-son ne marque pas de rupture nette — c'est surtout son rythme de coupe qui a été relevé.`,
      `Ces durées sont ta base de départ : c'est l'intention artistique que l'utilisateur veut reproduire. Applique-les à SA musique, jamais ses horodatages.`,
    );
  }

  /* ---- where the proposal currently stands ---- */
  const strategy = context.strategy;
  lines.push(
    '',
    `## Proposition actuelle`,
    `Profil ${strategy.profile}. Plans de ${seconds(strategy.shot.intro)} en intro, ${seconds(strategy.shot.build)} en montée, ${seconds(strategy.shot.drop)} au drop.`,
    context.clips.length > 0 && Object.keys(strategy.roles).length > 0
      ? `Distribution actuelle : ${(['intro', 'build', 'drop'] as const)
          .map((phase) => {
            const named = context.clips
              .filter((clip) => strategy.roles[clip.id] === phase)
              .map((clip) => clip.name);
            return `${PHASE_WORD[phase]} — ${named.length > 0 ? named.join(', ') : 'rien de réservé'}`;
          })
          .join(' ; ')}.`
      : `Distribution actuelle : aucune — les plans sont tirés au hasard dans la banque.`,
    strategy.opening
      ? `Plan d'ouverture choisi : ${
          context.clips.find((clip) => clip.id === strategy.opening)?.name ?? 'inconnu'
        }.`
      : `Aucun plan d'ouverture choisi.`,
    `Effets — punch : ${strategy.punch ? 'oui' : 'non'} · flashes : ${
      strategy.flashes ? 'oui' : 'non'
    } · aberration chromatique : ${strategy.split ? 'oui' : 'non'} · flou de coupe : ${
      strategy.smear ? 'oui' : 'non'
    }.`,
    `Le montage tournera à ${context.fps} images par seconde : une coupe ne peut pas tomber plus finement que ${seconds(1 / Math.max(1, context.fps))}.`,
    '',
    `## Comment répondre`,
    `Commence par « say » : en français, trois ou quatre phrases, et **justifie tes enchaînements**. Nomme les clips que tu places et dis pourquoi — « j'ouvre sur le plan large parce qu'il est stable et qu'il laisse installer le morceau », « je garde les plans de combat pour le drop, leur mouvement encaisse une coupe de trois dixièmes ». Un monteur explique ses choix ; il ne récite pas des réglages.`,
    `Ne mentionne jamais de JSON, de champ ni de paramètre technique.`,
    `Ensuite seulement, renseigne la distribution des rushs et les réglages. Utilise les **noms exacts** des clips tels qu'ils sont listés ci-dessus — un nom approximatif sera ignoré.`,
    `Ne renvoie que ce que tu veux réellement changer. Si la demande n'appelle aucun changement, ne renvoie que « say ».`,
  );

  return lines.join('\n');
}

/**
 * The nudge that makes the copilot speak first.
 *
 * Sent as the opening user turn, and never shown in the panel. The alternative
 * — having the front-end write the opening line itself — is what the panel did
 * before, and it meant the "conversation" began with a sentence no model had
 * been involved in: the numbers were right and there was no opinion in them.
 */
export function openingRequest(context: DirectorContext): string {
  return context.reference
    ? `Ouvre la discussion. Explique en deux ou trois phrases ce que tu retiens de la référence et comment tu comptes l'appliquer à cette musique et à ces clips, puis propose ta stratégie.`
    : `Ouvre la discussion. Propose une stratégie de montage pour cette musique et ces clips, en expliquant brièvement ton intention mouvement par mouvement.`;
}
