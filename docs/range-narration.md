# Voix off sur une sélection

Dans la timeline, placer le curseur au début du passage et appuyer sur **I**, puis
à la fin et appuyer sur **O**. Cliquer sur **Voix sur plage**. Sans plage I/O complète,
le dialogue propose jusqu’à 15 secondes depuis le curseur. Les temps restent
modifiables ; une sélection doit durer entre 2 et 180 secondes.

Le contexte du tutoriel (logiciel, objectif, vocabulaire, ton, informations déjà
expliquées) est sauvegardé **dans le projet** avec « Mémoriser le contexte », ou
lors d’une génération. Il est repris pour les autres plages et après réouverture
du projet. La consigne locale n’est pas enregistrée comme contexte général.

« Proposer le texte » utilise le modèle et la clé Gemini existants. Jusqu’à 40
images des sources vidéo visibles dans la plage sont extraites, en tenant compte
des coupes et des points d’entrée. Ce n’est pas une capture du rendu final : les
effets, les titres superposés et le son ne sont pas envoyés. Des instants sans
vidéo lisible sont signalés. On peut aussi écrire le texte directement.

Le texte est modifiable avant la synthèse ElevenLabs avec la voix déjà configurée.
Écouter le résultat avant « Ajouter la voix dans la plage ». Si la durée réelle
dépasse la sélection, raccourcir le texte et régénérer : ni troncature automatique,
ni débordement hors de la plage. Les générations utilisent les quotas habituels.

L’ajout crée une piste audio dédiée sans déplacer, recadrer, remplacer ou atténuer
les clips existants. Les sons présents restent audibles ; ce mode ne détecte pas
automatiquement les silences. L’insertion s’annule en une opération avec Ctrl+Z.
Les changements du montage analysé ou un changement de projet empêchent une
insertion périmée. L’annulation ignore les réponses tardives ; une synthèse déjà
envoyée peut finir côté service, mais son fichier inutilisé est nettoyé.

Le contexte est persistant (`tutorialContext`, schéma 12). Le texte proposé et la
prise non insérée restent seulement dans la session, y compris après fermeture
du dialogue. Changer de plage abandonne la proposition précédente ; les fichiers
audio déjà insérés restent conservés, y compris pour l’annulation/rétablissement.

Vérifications : `node scripts/test-range-narration.mjs` (services et état éditeur
simulés), `npm run build`, `cargo test`. Aucun appel payant dans les tests.
