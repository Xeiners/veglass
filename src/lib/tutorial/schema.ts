/**
 * The shape the tutorial analysis is constrained to.
 *
 * Same reasoning as `lib/ai/schema.ts` and `lib/viral/schema.ts`: constraining
 * the response is what makes parsing a `JSON.parse` rather than a hunt through
 * prose. Gemini's OpenAPI subset only — no `anyOf`.
 *
 * Every per-field rule is re-checked in `analyse.ts`. A schema can force `x` to
 * be a number; it cannot force it to be a fraction of the screen, force `at` to
 * land inside the recording, or force the steps to arrive in order. Those are
 * exactly the mistakes a model makes, so they are checked where they can be.
 */

import type { Schema } from '@/lib/ai/schema';

export const TUTORIAL_SCHEMA: Schema = {
  type: 'OBJECT',
  properties: {
    steps: {
      type: 'ARRAY',
      description: "Les étapes de la manipulation, dans l'ordre chronologique.",
      items: {
        type: 'OBJECT',
        properties: {
          at: {
            type: 'NUMBER',
            description:
              "Instant précis de l'action, en secondes depuis le début de l'enregistrement. " +
              'Le moment où le clic ou la frappe se produit, pas le moment où le curseur commence à bouger.',
          },
          until: {
            type: 'NUMBER',
            description:
              "Instant, en secondes, où le résultat de cette action est visible à l'écran " +
              "et où l'étape suivante peut commencer.",
          },
          title: {
            type: 'STRING',
            description:
              'Nom du chapitre, 2 à 5 mots. Sert de repère sur la règle temporelle. Sans numérotation.',
          },
          say: {
            type: 'STRING',
            description:
              'Le texte de la voix off pour cette étape : une à trois phrases, à la voix active, ' +
              "qui disent ce que l'on fait et pourquoi. Pas de balisage, pas d'emoji, pas de « étape 3 ».",
          },
          action: {
            type: 'STRING',
            enum: ['click', 'type', 'select', 'navigate', 'scroll', 'read'],
            description:
              "Nature de l'action. « read » quand rien n'est manipulé et qu'il s'agit d'observer un résultat.",
          },
          x: {
            type: 'NUMBER',
            description:
              "Abscisse du point d'intérêt, en fraction de la largeur de l'écran : 0 = bord gauche, " +
              '0.5 = centre, 1 = bord droit. Le centre de l’élément manipulé, pas celui du curseur.',
          },
          y: {
            type: 'NUMBER',
            description:
              "Ordonnée du point d'intérêt, en fraction de la hauteur : 0 = haut, 1 = bas.",
          },
          bannerTitle: {
            type: 'STRING',
            description:
              "Titre de la bande titre à incruster, SEULEMENT si cette étape ouvre une nouvelle " +
              "partie du tutoriel. 2 à 6 mots. Laisse vide sur toutes les autres étapes : " +
              "une bande titre sur chaque étape ne marque plus rien du tout.",
          },
          bannerSubtitle: {
            type: 'STRING',
            description:
              "Ligne secondaire de la bande titre : le module, l'écran concerné, ou « Étape 2 sur 6 ». " +
              'Quelques mots. Vide si le titre se suffit à lui-même.',
          },
          shortcut: {
            type: 'STRING',
            description:
              "Le raccourci clavier employé à cette étape, tel qu'on le tape : « Ctrl + S », " +
              '« Alt + Tab », « F2 ». Vide si aucune touche n’est utilisée — ne devine jamais ' +
              'un raccourci que tu ne vois pas.',
          },
          confidence: {
            type: 'NUMBER',
            description:
              'De 0 à 100 : ta certitude sur les coordonnées x et y. Sois franc — sous 45 la caméra ' +
              'ne bougera pas, ce qui vaut mieux que de zoomer au mauvais endroit.',
          },
        },
        required: ['at', 'until', 'title', 'say', 'action', 'confidence'],
        propertyOrdering: [
          'at',
          'until',
          'title',
          'action',
          'x',
          'y',
          'confidence',
          'shortcut',
          'bannerTitle',
          'bannerSubtitle',
          'say',
        ],
      },
    },
  },
  required: ['steps'],
  propertyOrdering: ['steps'],
};
