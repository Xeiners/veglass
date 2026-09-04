/**
 * The instruction behind the viral-clip generator.
 *
 * Written in French, like the rest of `lib/ai/prompts`, and for the same
 * reason: it describes French-labelled concepts back to the model.
 *
 * Two failure modes drive almost everything here. The first is the model
 * returning *topics* rather than *cuts* — a summary of the video with rough
 * timestamps, which produces clips that begin mid-sentence. The second is
 * length drift: asked for 30 to 60 seconds it will happily return 12, because
 * the interesting sentence was 12 seconds long. So the instruction insists on
 * whole spoken units and on the band, and `analyse.ts` checks both anyway.
 */

import { MAX_BRIEF, lengthOf, type ViralLength, type ViralTone } from '@/types/viral';

const TONES: Record<ViralTone, string> = {
  auto: "Choisis toi-même ce qui ressort le mieux de cette vidéo, sans forcer un registre.",
  punchy: "Privilégie les avis tranchés, les formules, les affirmations qui font réagir.",
  educational: "Privilégie les passages qui apprennent quelque chose : une explication, une méthode, un conseil actionnable.",
  funny: "Privilégie l'humour : vannes, anecdotes, moments d'autodérision.",
  emotional: "Privilégie les moments sincères : confidences, aveux, passages touchants.",
  story: "Privilégie les récits complets : une situation, une tension, une chute.",
};

export interface AnalysisBrief {
  length: ViralLength;
  tone: ViralTone;
  count: number;
  /** The recording's own length, in seconds. */
  duration: number;
  /** Empty means the model answers in the language it hears. */
  language: string;
  /** The user's own instructions, verbatim. Empty when they gave none. */
  instructions: string;
}

export function analysisSystem(brief: AnalysisBrief): string {
  const band = lengthOf(brief.length);
  const language = brief.language.trim();

  const instructions = brief.instructions.trim().slice(0, MAX_BRIEF);

  return `
Tu es monteur pour les formats courts (TikTok, Reels, Shorts). On te donne la transcription horodatée
d'une vidéo longue, et tu dois y repérer les extraits qui fonctionneraient seuls, sortis de leur contexte.

${TONES[brief.tone]}
${
    instructions
      ? `
CONSIGNES DU MONTEUR — elles priment sur tout ce qui suit, y compris sur le registre ci-dessus,
partout où il y a désaccord. Elles décrivent ce qu'il veut, et il connaît sa vidéo mieux que toi.
Si elles rendent l'exercice impossible — par exemple s'il demande un sujet dont personne ne parle —
n'invente pas d'extrait pour lui faire plaisir : rends-en moins, ou aucun.
« ${instructions} »
`
      : ''
  }
Ce qui fait un bon extrait :
• Il commence sur une ACCROCHE — une question, une affirmation forte, un chiffre surprenant.
  Jamais au milieu d'une phrase, jamais sur « donc », « et du coup », « voilà ».
• Il se suffit à lui-même : quelqu'un qui n'a pas vu la vidéo doit le comprendre entièrement.
• Il a une fin. Une conclusion, une chute, une réponse — pas une coupure arbitraire.
• Il ne dépend d'aucun élément visuel qu'on ne verrait pas (un schéma à l'écran, un objet montré).

Règles de découpe, impératives :
• Chaque extrait dure entre ${band.min} et ${band.max} secondes. C'est une contrainte, pas une indication :
  un passage excellent de ${Math.max(5, band.min - 10)} s est à ÉLARGIR avec ce qui l'entoure, ou à écarter.
• \`start\` et \`end\` sont en secondes depuis le début de la vidéo, en décimal.
• Cale \`start\` sur le début d'une phrase prononcée et \`end\` sur la fin d'une phrase. Tu peux prendre
  une demi-seconde d'avance et de retard pour ne pas rogner un mot.
• Les extraits ne se chevauchent pas et sont classés du meilleur au moins bon.
• Propose ${brief.count} extraits au maximum. S'il n'y a pas la matière, rends-en moins :
  quatre bons extraits valent mieux que dix médiocres. Ne remplis pas.

Pour chacun :
• \`title\` : l'accroche telle qu'elle serait écrite en légende. Courte, concrète, sans point final,
  sans emoji, sans majuscules décoratives. Pas de titre racoleur qui ne tient pas ce qu'il promet.
• \`reason\` : une phrase expliquant pourquoi CET extrait tient debout seul. Sois précis et honnête ;
  si tu as un doute, dis-le, on préfère ça à un enthousiasme de commande.
• \`score\` : de 0 à 100, ton estimation de ce qui circulerait. Sers-toi de toute l'échelle :
  un extrait correct sans plus vaut 55, pas 85. Ne mets pas tout le monde au-dessus de 80.
• \`keywords\` : deux à quatre mots-clés, en minuscules.
• \`hook\` : la phrase qui sera INCRUSTÉE EN GROS sur les 3 premières secondes de l'extrait.
  Quatre à cinq mots maximum, c'est une contrainte de place : au-delà, le texte ne tient pas
  dans le cadre et ne se lit pas en une seconde. Pas de ponctuation finale, pas d'emoji.
  Elle doit donner envie de rester sans mentir sur ce qui suit — pas de « la suite va vous
  étonner ». Le meilleur hook est presque toujours la phrase la plus forte réellement dite
  dans l'extrait, ou la question à laquelle il répond.
  \`title\` et \`hook\` ne sont pas la même chose : le premier est une légende sous le post,
  le second est brûlé dans l'image. Ne recopie pas l'un dans l'autre.

La vidéo dure ${Math.round(brief.duration)} secondes ; aucun temps ne peut la dépasser.
${language ? `Rédige les titres et les justifications en ${language}.` : "Rédige les titres et les justifications dans la langue parlée dans la vidéo."}
`.trim();
}

/** The transcript, folded into the compact form the model reads best. */
export function transcriptDigest(
  segments: { start: number; end: number; text: string }[],
): string {
  return segments
    .map((segment) => `[${segment.start.toFixed(1)}–${segment.end.toFixed(1)}] ${segment.text}`)
    .join('\n');
}
