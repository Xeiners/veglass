/**
 * Response schemas.
 *
 * Gemini can be *constrained* to a JSON shape rather than merely asked for one,
 * and that is the difference between a feature that works and one that works
 * most of the time. Every call in this suite sets `responseMimeType:
 * application/json` together with one of the schemas below, so parsing is a
 * `JSON.parse` and not a hunt for a fenced code block.
 *
 * The schemas use Gemini's OpenAPI subset — `type`, `properties`, `items`,
 * `required`, `enum`, `description`, `propertyOrdering`. Deliberately no
 * `anyOf`: an action is a flat object with a `kind` discriminator and optional
 * fields, which every model version handles, and validation on our side
 * (`lib/ai/plan.ts`) is what actually enforces the per-kind shape.
 */

import { BACKGROUNDS } from '@/types/background';
import { EFFECTS } from '@/types/effects';
import { TRANSITIONS } from '@/types/transitions';

export type Schema = Record<string, unknown>;

const STRING = { type: 'STRING' } as const;
const NUMBER = { type: 'NUMBER' } as const;
const BOOLEAN = { type: 'BOOLEAN' } as const;

const described = (base: Schema, description: string): Schema => ({ ...base, description });

/* ------------------------------------------------------------------ *
 * Plan
 * ------------------------------------------------------------------ */

const ACTION_KINDS = [
  'addTrack',
  'addBackground',
  'setBackground',
  'addText',
  'addClip',
  'moveClip',
  'trimClip',
  'removeClip',
  'renameClip',
  'setClip',
  'updateText',
  'splitText',
  'setEntrance',
  'animate',
  'addEffect',
  'addTransition',
] as const;

const TEXT_STYLE: Schema = {
  type: 'OBJECT',
  description: "Style du calque de texte. Tout est optionnel ; ce qui est omis garde le style par défaut.",
  properties: {
    fontFamily: described(STRING, 'Identifiant de police parmi ceux listés dans `available.fonts`.'),
    fontSize: described(NUMBER, 'Taille en pixels du projet (une image 1920×1080 : titre ≈ 96, sous-titre ≈ 52).'),
    fontWeight: described(NUMBER, 'Graisse CSS, 300 à 800.'),
    color: described(STRING, 'Couleur hexadécimale, par exemple #FFFFFF.'),
    align: { type: 'STRING', enum: ['left', 'center', 'right'] },
    italic: BOOLEAN,
    x: described(NUMBER, 'Décalage horizontal depuis le centre du cadre, en pixels projet.'),
    y: described(NUMBER, 'Décalage vertical depuis le centre du cadre ; positif = vers le bas.'),
  },
};

const KEYFRAME: Schema = {
  type: 'OBJECT',
  properties: {
    time: described(NUMBER, 'Secondes depuis le DÉBUT DU CLIP, pas depuis le début de la timeline.'),
    value: NUMBER,
    easing: {
      type: 'STRING',
      enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'hold'],
      description: 'Courbe du segment qui commence à cette image clé.',
    },
  },
  required: ['time', 'value'],
  propertyOrdering: ['time', 'value', 'easing'],
};

const ACTION: Schema = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: [...ACTION_KINDS] },

    // References: an id from the project description, or a name to be matched.
    clip: described(
      STRING,
      "Identifiant du clip visé (`cl_…`), son libellé, ou `selection` pour viser d'un coup tous les clips listés dans `selection` — c'est la forme à utiliser quand la demande parle de « ce clip », « ces clips » ou « la sélection ».",
    ),
    track: described(STRING, "Identifiant de piste (`tr_…`), son nom (« V2 »), ou « new » pour en créer une."),
    asset: described(STRING, "Identifiant du média (`as_…`) ou son nom de fichier."),
    fromClip: described(STRING, 'Clip sortant de la transition.'),
    toClip: described(STRING, 'Clip entrant de la transition.'),

    // Placement.
    start: described(NUMBER, 'Position sur la timeline, en secondes.'),
    duration: described(NUMBER, 'Durée visible, en secondes.'),
    offset: described(NUMBER, "Point d'entrée dans le média source, en secondes."),

    // Payload.
    content: described(STRING, 'Texte affiché. Utilisez \\n pour un retour à la ligne.'),
    label: described(STRING, 'Nom du clip dans la timeline.'),
    name: described(STRING, "Nom de la piste à créer."),
    trackKind: { type: 'STRING', enum: ['video', 'audio'] },
    style: TEXT_STYLE,
    animate: described(BOOLEAN, "Ajoute une apparition en fondu + agrandissement sur le texte."),
    animation: {
      type: 'STRING',
      enum: ['none', 'fade', 'pop', 'rise', 'punch'],
      description:
        "Style d'apparition du texte. `punch` est l'entrée sèche sans sortie du mot à mot ; `pop` et `rise` conviennent aux titres et aux sous-titres.",
    },
    unit: {
      type: 'STRING',
      enum: ['word', 'line'],
      description: "Découpage de `splitText` : un clip par mot, ou un clip par ligne.",
    },

    // Numeric clip properties.
    opacity: described(NUMBER, '0 → 1.'),
    scale: described(NUMBER, '1 = image pleine.'),
    x: NUMBER,
    y: NUMBER,
    rotation: described(NUMBER, 'Degrés, sens horaire.'),
    volume: described(NUMBER, '0 → 1.'),
    muted: BOOLEAN,

    // Animation.
    channel: {
      type: 'STRING',
      enum: [
        'x',
        'y',
        'scale',
        'rotation',
        'opacity',
        'volume',
        'bg:speed',
        'bg:scale',
        'bg:intensity',
      ],
      description:
        "Propriété à animer. Les `bg:` visent les réglages d'un fond généré — `bg:scale` est la taille de ses formes, `scale` est celle du calque.",
    },
    keyframes: { type: 'ARRAY', items: KEYFRAME },

    // Registries.
    effect: { type: 'STRING', enum: EFFECTS.map((item) => item.kind) },
    background: {
      type: 'STRING',
      enum: BACKGROUNDS.map((item) => item.kind),
      description: BACKGROUNDS.map((item) => `${item.kind} — ${item.hint}`).join(' · '),
    },
    base: described(STRING, 'Couleur de fond hexadécimale, la plus sombre du décor.'),
    colors: {
      type: 'ARRAY',
      description: "Deux à cinq teintes d'accent, en hexadécimal.",
      items: STRING,
    },
    speed: described(NUMBER, 'Vitesse du mouvement, 0 fige le motif. 0,3 lent · 1 vif.'),
    intensity: described(NUMBER, "Force des accents sur le fond, 0 → 1,5."),
    transition: { type: 'STRING', enum: TRANSITIONS.map((item) => item.kind) },
  },
  required: ['kind'],
  propertyOrdering: ['kind', 'clip', 'track', 'asset', 'start', 'duration', 'content'],
};

/**
 * The assistant's answer: something to read, and optionally something to apply.
 *
 * `reply` is required and `actions` is not, because most turns are a
 * conversation — a question about the montage deserves an answer, not an edit.
 */
export const PLAN_SCHEMA: Schema = {
  type: 'OBJECT',
  properties: {
    reply: described(
      STRING,
      "Réponse à afficher dans le fil de discussion, en français, concise et sans balisage lourd.",
    ),
    title: described(
      STRING,
      "Résumé en trois à six mots des modifications proposées — sert de libellé dans l'historique d'annulation.",
    ),
    actions: {
      type: 'ARRAY',
      description:
        "Modifications proposées, dans l'ordre d'application. Vide si la demande n'appelle aucune modification.",
      items: ACTION,
    },
  },
  required: ['reply'],
  propertyOrdering: ['reply', 'title', 'actions'],
};

/* ------------------------------------------------------------------ *
 * Transcription
 * ------------------------------------------------------------------ */

export const TRANSCRIPT_SCHEMA: Schema = {
  type: 'OBJECT',
  properties: {
    language: described(STRING, 'Langue détectée, en français (« français », « anglais »…).'),
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: described(NUMBER, "Secondes depuis le début de l'extrait audio fourni."),
          end: described(NUMBER, "Secondes depuis le début de l'extrait audio fourni."),
          text: described(STRING, 'Une réplique, prête à être affichée telle quelle.'),
        },
        required: ['start', 'end', 'text'],
        propertyOrdering: ['start', 'end', 'text'],
      },
    },
  },
  required: ['segments'],
  propertyOrdering: ['language', 'segments'],
};

/* ------------------------------------------------------------------ *
 * Smart cut
 * ------------------------------------------------------------------ */

export const CUTS_SCHEMA: Schema = {
  type: 'OBJECT',
  properties: {
    cuts: {
      type: 'ARRAY',
      description: "Intervalles à supprimer, triés, sans chevauchement.",
      items: {
        type: 'OBJECT',
        properties: {
          start: described(NUMBER, "Secondes depuis le début de l'extrait audio fourni."),
          end: described(NUMBER, "Secondes depuis le début de l'extrait audio fourni."),
          reason: described(
            STRING,
            "Trois mots au plus : « euh », « faux départ », « répétition », « blanc ».",
          ),
        },
        required: ['start', 'end', 'reason'],
        propertyOrdering: ['start', 'end', 'reason'],
      },
    },
  },
  required: ['cuts'],
};
