/**
 * The shape the analysis pass is constrained to.
 *
 * Same reasoning as `lib/ai/schema.ts`: constraining the response is what makes
 * parsing a `JSON.parse` rather than a hunt through prose. Gemini's OpenAPI
 * subset only — no `anyOf`, and every per-field rule is re-checked in
 * `analyse.ts`, because a schema can force a number to exist but not force it
 * to fall inside the recording.
 */

import type { Schema } from '@/lib/ai/schema';

export const CLIPS_SCHEMA: Schema = {
  type: 'OBJECT',
  properties: {
    clips: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          start: {
            type: 'NUMBER',
            description: 'Début, en secondes depuis le début de la vidéo.',
          },
          end: {
            type: 'NUMBER',
            description: 'Fin, en secondes depuis le début de la vidéo.',
          },
          title: {
            type: 'STRING',
            description: "L'accroche, telle qu'elle serait écrite en légende. Sans emoji.",
          },
          reason: {
            type: 'STRING',
            description: 'Une phrase : pourquoi cet extrait tient debout seul.',
          },
          score: {
            type: 'NUMBER',
            description: 'Estimation de 0 à 100. Sers-toi de toute l’échelle.',
          },
          keywords: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'Deux à quatre mots-clés en minuscules.',
          },
          hook: {
            type: 'STRING',
            description:
              "L'accroche incrustée sur les 3 premières secondes. 4 à 5 mots maximum.",
          },
        },
        required: ['start', 'end', 'title', 'score', 'hook'],
        propertyOrdering: ['start', 'end', 'title', 'hook', 'reason', 'score', 'keywords'],
      },
    },
  },
  required: ['clips'],
  propertyOrdering: ['clips'],
};
