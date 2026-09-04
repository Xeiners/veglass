# Veglass

Éditeur vidéo hybride, rapide, local-first — Tauri v2 · React · TypeScript · Tailwind.

Bibliothèque de médias, preview synchronisée et timeline multi-pistes dans un seul plan de
travail. Les projets vivent sur votre machine, en JSON lisible.

---

## Démarrage

### Mode navigateur (immédiat, aucune dépendance système)

```bash
npm install
npm run dev          # http://localhost:1420
```

L'application est **entièrement fonctionnelle** dans le navigateur : création de projet, import
par glisser-déposer, preview, timeline, montage. Les projets sont enregistrés dans le
`localStorage`, et les médias sont référencés par `blob:` — ils ne survivent donc pas à un
rechargement de page (la bibliothèque signale les fichiers à réimporter).

### Mode desktop (Tauri)

Nécessite la [toolchain Rust](https://rustup.rs). L'export a en plus besoin de **ffmpeg** —
sur le PATH, à côté de l'exécutable, ou désigné par `VEGLASS_FFMPEG` :

```bash
rustup default stable        # une fois
npm run desktop              # tauri dev
npm run desktop:build        # bundle signé (.msi / .exe / .dmg / .AppImage)
```

En mode desktop, l'import passe par le sélecteur natif : Veglass conserve le **chemin absolu** de
chaque média, les projets sont écrits en JSON dans le répertoire applicatif, et un projet rouvert
retrouve tous ses fichiers.

| | Navigateur | Desktop |
|---|---|---|
| Stockage projet | `localStorage` | `%APPDATA%/app.veglass.editor/projects/*.veglass.json` |
| Import | glisser-déposer, `<input type=file>` | dialogue natif + glisser-déposer |
| Médias persistants | non (`blob:`) | oui (chemin disque + `asset://`) |
| Moteur de rendu | jumeau TypeScript | Rust natif |
| Export vidéo | indisponible | ffmpeg (H.264 / AAC) |
| Médias déplacés | ré-import manuel | relocalisation automatique |

---

## Ce que fait le MVP

- **Accueil** — création de projet (nom, résolution, cadence), grille des projets récents avec
  durée / nombre de clips, suppression avec confirmation.
- **Bibliothèque** — glisser-déposer depuis le bureau, vignettes extraites de la vidéo,
  formes d'onde calculées pour l'audio, filtre par nom.
- **Preview** — lecteur HTML5 piloté par l'horloge de transport : play/pause, seek, saut
  début/fin, boucle, volume général, plein écran, timecode `HH:MM:SS:FF`.
- **Timeline** — pistes vidéo et audio, clips déplaçables entre pistes, poignées de rognage,
  aimantation magnétique, coupe au curseur, duplication, zoom (boutons, `+`/`-`, `Ctrl`+molette),
  playhead déplaçable et suivi automatique pendant la lecture.
- **Effets & filtres** — luminosité, contraste, saturation, flou, teinte, noir & blanc. Chaîne
  ordonnée par clip, chaque filtre activable, réinitialisable et déplaçable dans la chaîne ;
  rendu en direct dans la preview.
- **Transitions** — fondu enchaîné, fondu au noir, fondu au blanc. Glissées depuis la
  bibliothèque sur un point de coupe, redimensionnables directement sur la timeline.
- **Inspecteur** — placement (début / durée / point d'entrée), opacité, échelle, volume, mute,
  chaîne d'effets, propriétés de transition ; réglages du projet quand rien n'est sélectionné.
- **Images clés** — position, échelle, rotation, opacité et chaque curseur de filtre s'animent ;
  courbes de vitesse linéaire, doux, palier ou bézier libre, éditables à la main.
- **Calques de texte** — police, graisse, corps, couleur, alignement, interlignage, contour et
  ombre portée, avec rendu identique à l'export.
- **Objets statiques** — PNG, JPG, SVG posés à leur taille naturelle, comme des surimpressions.
- **Gizmo sur la preview** — cliquer un calque pour le sélectionner, le déplacer, le redimensionner
  par les coins, le faire pivoter.
- **Pile de calques** — l'ordre des pistes *est* l'ordre de composition, réordonnable au glisser.
- **Sélection multiple** — `Ctrl` + clic ajoute ou retire un clip ; couper, supprimer, copier
  et dupliquer agissent alors sur tout le lot, en une seule étape d'annulation.
- **Copier / coller des clips** — avec effets, courbes, style de texte et point d'entrée source.
  Le collage reproduit l'écart entre les clips copiés, ancré sur le curseur.
- **Duplication de projet** — depuis la grille d'accueil, sous un nom libre.
- **Annuler / Rétablir** — historique global, un geste continu = une étape.
- **Rendu MP4** — export H.264 / AAC piloté par ffmpeg, avec progression en direct.
- **Médias en ligne** — recherche filtrée (type, durée, tri, licence Creative Commons) avec
  défilement continu, sélecteur de qualité lisant les formats réellement disponibles, puis
  téléchargement via `yt-dlp` avec file d'attente, progression en temps réel et annulation. Un fichier récupéré entre par le même
  chemin d'import que le sélecteur natif : il se comporte ensuite comme n'importe quel média local.
- **Relocalisation des médias** — un fichier déplacé est retrouvé tout seul ; sinon un seul clic
  relie tout le lot.
- **Qualité de preview** — Intégrale / 1/2 / 1/4 pendant la lecture, pleine résolution à l'arrêt.
- **Plan de travail ajustable** — les trois panneaux (bibliothèque, inspecteur, timeline) se
  redimensionnent à la souris ; double-clic sur une poignée pour revenir au défaut. Les tailles
  sont mémorisées par machine, hors du fichier projet.
- **Sauvegarde automatique** — chaque modification est écrite après 700 ms d'inactivité.

### Suite IA (Gemini)

- **Clé API** — saisie dans les réglages de l'assistant, vérifiée auprès de Google avant d'être
  enregistrée, puis rangée dans le trousseau du système. Elle n'entre jamais dans le webview.
- **Bascule automatique de modèle** — les quotas Gemini sont comptés par modèle. Quand celui
  choisi est à court, la requête repart sur le suivant de la liste, sans attente, et le
  basculement est annoncé.
- **Choix du modèle** — le panneau interroge `models.list` à l'ouverture et propose ce que la clé
  atteint réellement. Un identifiant retiré par Google dans une préférence enregistrée est reporté
  sur son remplaçant au chargement, une seule fois — voir `RETIRED_MODELS`.
- **Assistant conversationnel** — onglet du panneau droit. Il voit la timeline (pistes, clips,
  médias, sélection, zone de travail), répond, et propose des **plans** : ajout de calques de
  texte, chapitrage, placement de médias, images clés de motion design, effets, transitions.
  Rien n'est écrit sans validation, et un plan entier s'annule d'une seule pression.
- **Agir sur la sélection** — sélectionnez un ou plusieurs clips (`Ctrl` + clic), puis demandez
  « agrandis-les de 20 % » ou « ajoute un flou ». Une action visant `selection` est développée en
  une action par clip, et les valeurs courantes voyagent avec la demande pour que le relatif
  fonctionne.
- **Fonds animés générés** — quatre décors (boules floues, bokeh, dégradé maillé, ondes),
  palette au choix ou couleur par couleur. Vitesse, taille et intensité s'**animent** avec le
  même losange que la transformation, courbes de vitesse comprises. Dessinés par le même
  code dans le viewer et à l'export, donc identiques par construction.
- **Typographie mot à mot** — « fais apparaître les paroles mot par mot » découpe un calque de
  texte en un clip par mot, répartis sur sa durée et animés d'une entrée sèche. Disponible aussi
  au clic droit sur un calque de texte, sans passer par l'assistant.
- **Sous-titres automatiques** — l'audio de chaque clip audible est extrait par ffmpeg, transcrit
  par Gemini avec ses timecodes, puis posé en calques de texte sur une piste dédiée, stylés et
  pré-animés (fondu, pop, montée). Les images clés produites sont éditables comme les vôtres.
- **Calage d'un texte existant** — vous fournissez les mots (paroles, script, traduction), Gemini
  ne renvoie que le minutage. Le texte est repris mot pour mot ; ce que le modèle n'entend pas
  dans l'étendue choisie est omis plutôt que deviné.
- **Smart cut** — mesure déterministe de la bande son (enveloppe RMS décodée par ffmpeg), seuil
  et durée minimale réglables, détection optionnelle des hésitations par le modèle. Les
  intervalles sont proposés un par un, et le montage se referme dessus **toutes pistes ensemble**.

### Raccourcis

| Touche | Action |
|---|---|
| `Espace` | Lecture / pause (au relâchement) |
| `Espace` maintenu + glisser | Déplacer la vue de la timeline |
| `Ctrl` + clic | Ajouter / retirer un clip de la sélection |
| `S` | Couper au curseur — toute la sélection |
| `N` / `L` / `M` | Aimantation / boucle / mute |
| `←` `→` | Image par image (`⇧` : 10 images) |
| `Début` `Fin` | Début / fin du montage |
| `Suppr` | Supprimer la sélection |
| `Ctrl + D` | Dupliquer la sélection |
| `Ctrl + S` | Enregistrer |
| `+` `-` | Zoom timeline |
| `Suppr` | Supprime aussi la transition sélectionnée |
| `Ctrl + Z` | Annuler |
| `Ctrl + ⇧ + Z` | Rétablir |
| `Ctrl + ⇧ + T` | Nouveau calque de texte |
| `Ctrl + C / V` | Copier / coller les clips — les images clés si une est sélectionnée |
| `Ctrl` + molette | Zoom centré sur le curseur |
| `Maj` + molette | Défilement horizontal |

---

## Architecture

```
src/
├── types/            Modèle de domaine — la source de vérité
│   ├── animation     Images clés : easing, bézier, évaluation, échantillonnage
│   ├── effects       Registre des filtres : plages, valeurs neutres, mapping CSS
│   ├── text          Calques de texte : polices, style, ombre, contour
│   └── transitions   Types de transition, ancres, descripteurs
│   └── ai            Suite IA : erreurs typées, réglages, plan d'actions, sous-titres, coupes
├── lib/              Temps, ids, média, persistance, chaîne d'effets, plan de rendu
│   └── ai/           client (transport) · context · prompts · schema · plan
│                     motion · scope · subtitles · silence
├── store/
│   ├── editorStore   État global Zustand + toutes les mutations du document
│   ├── aiStore       Session IA : conversation, clé, travaux en cours (hors document)
│   └── selectors     Lectures dérivées (composition, ancres, aimantation…)
├── hooks/            Horloge de lecture, raccourcis, drag, mesure d'élément
└── components/
    ├── ui/            Primitives (Button, Modal, Field, Slider, Toaster, Logo)
    ├── home/          Dashboard et modal de création
    └── editor/        Workspace, TopBar, LeftRail, MediaPool, EffectsPanel,
        │              VideoPreview, PreviewLayer, Gizmo, AudioMixer, Inspector
        ├── effects/   EffectStack
        ├── inspector/ TextInspector, TransitionInspector, AnimatableRow, EasingEditor
        ├── ai/        AssistantPanel, AiSettingsModal, SubtitleDialog, SmartCutDialog
        └── timeline/  Timeline, Ruler, TrackHead, TimelineClip, TransitionBlock,
                       KeyframeLane, PlayheadLayer, Waveform

src-tauri/
├── model.rs          Miroir Rust du document (serde camelCase ⇄ types TS)
├── error.rs          Erreurs typées sérialisées vers l'IPC
├── commands/
│   ├── project.rs    list / load / save (écriture atomique) / delete / projects_dir
│   ├── engine.rs     process_timeline_segments · describe_effect_chain
│   └── ai.rs         Clé, génération, extraction et analyse audio (tout en async)
├── online/
│   ├── ytdlp.rs      Localisation et installation du binaire (testé)
│   ├── search.rs     Requête ou lien → résultats structurés (testé)
│   ├── download.rs   Téléchargement, progression, annulation (testé)
│   └── error.rs      Erreur typée : binaire absent, vidéo fermée, réseau (testé)
├── ai/
│   ├── secrets.rs    Trousseau système, repli fichier masqué (testé)
│   ├── gemini.rs     Client REST : mapping des erreurs, réessais bornés (testé)
│   ├── audio.rs      Extrait compressé pour le modèle · enveloppe RMS (testé)
│   └── error.rs      Erreur IA sérialisée en objet, pas en chaîne
└── engine/
    ├── effects.rs    Chaîne de filtres → fragments ffmpeg (testé)
    ├── render.rs     Timeline → segments ordonnés + planning des transitions (testé)
    └── mod.rs        Trait `Encoder` — point d'ancrage du futur backend ffmpeg/Python
```

### Comment la lecture reste synchrone

L'horloge de transport ([`usePlaybackClock`](src/hooks/usePlaybackClock.ts)) avance le playhead
au temps réel via `requestAnimationFrame`, **indépendamment** des éléments média. Les lecteurs
suivent ensuite ce playhead :

- [`VideoPreview`](src/components/editor/VideoPreview.tsx) résout le clip vidéo visible (ordre des
  pistes = ordre de composition), calcule le temps source `offset + (playhead − start)` et ne
  reseek que si la dérive dépasse 180 ms.
- [`AudioMixer`](src/components/editor/AudioMixer.tsx) monte un `<audio>` par clip audio et
  applique la même logique, avec le volume `clip × master`.

C'est ce découplage qui permet aux trous de timeline, aux images fixes et aux pistes muettes
d'avancer au même rythme que la vidéo.

### Comment une propriété s'anime

Une propriété est un simple nombre jusqu'à ce qu'on l'anime. À partir de là une liste d'images clés
la pilote et le scalaire devient le repli — c'est le modèle d'After Effects, et c'est ce qui rend
l'ajout non destructif : un clip sans `animation` se comporte exactement comme avant.

Les temps d'images clés sont **relatifs au début du clip**, donc déplacer un clip emporte son
animation intacte.

`evaluateKeyframes()` ([types/animation.ts](src/types/animation.ts)) résout la valeur à n'importe
quel instant : maintien à plat en dehors de la plage animée, interpolation par une courbe de Bézier
cubique entre deux clés. Le solveur combine Newton-Raphson et une bissection de repli — Newton
converge en quelques pas sur des poignées normales, la bissection prend le relais là où la pente
s'aplatit et où Newton cale.

Le losange de l'inspecteur a trois états, comme partout : creux (propriété fixe), vide (animée, pas
de clé sur cette image), plein (clé sur cette image). Cliquer parcourt exactement ces états.

### Comment l'animation survit à l'export

Le langage d'expressions de ffmpeg n'a pas de solveur de Bézier. Plutôt que de réimplémenter
l'easing en Rust — deux évaluateurs à garder synchronisés, donc une dérive garantie — **le
front-end aplatit chaque courbe** avec le même code que la preview, et n'envoie au moteur que des
points de rupture linéaires.

Rust les transforme ensuite en expressions ffmpeg :

| Canal | Traduction |
|---|---|
| position X/Y | `overlay=x='(W-w)/2+(…)'` sur le temps timeline |
| rotation | `rotate=a='(…)*PI/180'`, boîte dimensionnée à la diagonale |
| échelle | `scale=eval=frame:w='2*round(iw*(…)/2)'` |
| opacité | `geq` sur le plan alpha — le seul filtre qui accepte une expression |
| luminosité / contraste / saturation / teinte | expressions `eq` et `hue` |
| flou | **non animable** — `gblur` n'accepte pas d'expression ; signalé au rendu |

Les expressions sont truffées de virgules, qu'un filtergraph lirait comme des séparateurs de
filtres : chacune part donc entre apostrophes, que le parseur de ffmpeg gère nativement.

Les calques **texte et vectoriels** ne passent pas par là. Comme ils sont déjà rasterisés, une
animation les transforme en **séquence d'images numérotées** — une PNG par image de sortie,
`-framerate F -start_number 1 -i …/%06d.png`. Le rendu est alors exact au pixel près, easing
compris.

### Comment les calques se composent

L'ordre de la liste des pistes **est** l'ordre de composition, de haut en bas : la première piste
vidéo peint par-dessus toutes les autres. `stackAt()` parcourt donc la liste à l'envers, et le
moteur Rust trie les segments par couche décroissante avant de les empiler par `overlay`. Les deux
lisent la même donnée — il n'y a pas de champ « z-index » à tenir synchronisé.

Le glisser vertical sur une tête de piste réordonne en direct, borné au bloc de pistes du même
type : mélanger image et son n'aurait aucun sens.

Un clip porte désormais un `kind` (`media` ou `text`), un `assetId` optionnel, et une
transformation plate — `x`, `y`, `rotation` en plus de `scale`. Le gizmo et les curseurs de
l'inspecteur écrivent au même endroit.

### Comment le texte survit à l'export

`drawtext` de ffmpeg réclame un *fichier* de police, s'échappe mal, et ne rendrait jamais tout à
fait comme le webview. Donc c'est le webview qui dessine : [`lib/bake.ts`](src/lib/bake.ts)
rasterise chaque calque de texte — et chaque SVG, que ffmpeg ne sait généralement pas décoder — sur
un canvas à la résolution native du projet, transformation et chaîne d'effets comprises. Ce que
ffmpeg reçoit est un PNG transparent qu'il superpose en 0,0.

Le rendu est donc identique à la preview **par construction**, pas par approximation : les deux
utilisent la même pile de polices et le même `filter` CSS.

### Comment un média perdu se retrouve tout seul

Un chemin absolu ne survit ni à un dossier déplacé, ni à un changement de machine, ni à une lettre
de lecteur qui bouge. À chaque ouverture, [`commands/media.rs`](src-tauri/src/commands/media.rs)
vérifie donc chaque chemin, et pour ceux qui ont disparu cherche **le même nom de fichier** dans,
par ordre de vraisemblance : les dossiers désignés par l'utilisateur, ceux des médias qui ont bien
répondu, puis le dossier d'origine et son parent. La recherche est bornée — profondeur 3, 20 000
entrées maximum — et ne suit pas les liens symboliques, pour ne jamais bloquer l'ouverture.

Ce qui reste introuvable arrive dans le dialogue de relocalisation. Y désigner **un seul** fichier
suffit le plus souvent : son dossier devient un indice et le reste du lot est résolu dans la foulée.
Les chemins réparés sont réécrits dans le projet.

### Comment la lecture reste fluide en 4K

Le sélecteur de qualité de la barre supérieure fait rasteriser le viewer à une fraction de la
résolution du projet **pendant la lecture** — une image à l'arrêt est toujours pleine résolution, et
l'encodeur ne voit jamais ce réglage.

Ce qui est réellement économisé : le décodeur continue de produire des images pleine résolution
(seuls des proxies changeraient cela), mais le compositeur ne remplit plus qu'un quart des pixels en
1/2 et un seizième en 1/4 — c'est exactement là qu'une timeline 4K s'effondre sur une machine
modeste.

### Comment une transition est rendue en direct

`composeAt()` ([selectors.ts](src/store/selectors.ts)) répond à une seule question : *que faut-il
dessiner à l'instant t ?* Hors transition, une couche. Pendant un fondu enchaîné, **deux** couches
d'opacités complémentaires ; pendant un fondu au noir, une couche plus un voile coloré qui culmine
sur la coupe.

Le point subtil : pendant un fondu enchaîné, le plan sortant doit continuer **au-delà** de son
point de sortie et l'entrant démarrer **avant** son point d'entrée. C'est exactement ce que font
les poignées (*handles*) d'un montage professionnel. `sourceTimeAt()` extrapole naturellement, et
la composition borne le résultat à la durée réelle du média : là où il n'y a pas de poignée
disponible, l'image se fige sur la première ou la dernière frame au lieu d'échouer.

Chaque couche est un [`PreviewLayer`](src/components/editor/PreviewLayer.tsx) autonome qui
poursuit son propre temps source. Les couches sont indexées par identifiant de clip, si bien qu'à
la fin d'un fondu le plan entrant conserve son élément `<video>` — pas de remontage, pas de
saccade.

### Pourquoi les filtres sont un protobuf et pas une table

Une recherche filtrée est une page de résultats ordinaire portant un paramètre `sp`, et ce
paramètre est un **protobuf en base64** — pas un jeton opaque à retrouver dans une table. Les
tables de jetons pré-calculés sont la façon dont la plupart des outils s'y prennent, et elles
cassent dès que deux filtres doivent se combiner : la table ne contient que les combinaisons que
quelqu'un a pensé à y coller.

Construire le message correctement tient en quarante lignes et se compose par construction : durée,
type, tri et licence se règlent ensemble, dans n'importe quel mélange. Les numéros de champ sont
vérifiés contre les jetons que YouTube émet lui-même, et chaque test en épingle un.

Une nuance de vocabulaire compte ici : les valeurs de durée ne suivent pas l'ordre des longueurs —
*courte* vaut 1, *longue* 2 et *moyenne* 3, parce que la catégorie moyenne a été ajoutée après les
deux autres. De même pour le tri, où 1 est la note et non la date.

Il n'existe **aucun filtre « musique »** dans cette API. Le son est une propriété de ce qu'on
télécharge, pas de ce qu'on cherche : ce choix vit dans le sélecteur de format. La barre offre à la
place le filtre *Creative Commons*, qui est celui qui aide réellement quelqu'un cherchant de la
matière destinée à être publiée.

### Comment le sélecteur de qualité ne peut pas mentir

`yt-dlp -F` imprime quarante lignes, dont la plupart sont la même image à la même taille dans un
conteneur différent. C'est un listing de diagnostic, pas un choix — personne ne tranche entre `137`
et `299` volontairement. Le module agrège donc : une offre par **résolution**, une par codec audio,
chacune portant déjà les nombres qu'une décision réclame.

C'est là que vit l'exigence de robustesse. Une vidéo qui plafonne en 720p n'a tout simplement pas
d'offre 1080p : le sélecteur n'a rien à griser et rien vers quoi retomber, parce que **la liste
*est* ce qui existe**. Et la hauteur choisie est exprimée comme un plafond (`height<=`) plutôt
qu'une égalité, donc une vidéo dont la meilleure copie est en 720p se télécharge quand même
lorsqu'on a demandé 1080p.

Le poids affiché additionne l'image et le son qu'elle devra fusionner : montrer la seule piste
vidéo sous-estimerait le fichier d'un dixième sur un long métrage.

### Comment un média en ligne devient un média du projet

Le webview ne peut pas afficher un site vidéo — les intégrations refusent de tourner dans une
fenêtre applicative — alors l'application n'essaie pas. Elle parle à `yt-dlp` et dessine les
résultats elle-même, ce qui est à la fois plus rapide à parcourir et la seule version de cette
fonctionnalité qui rende un vrai fichier à la fin.

Le point d'arrivée est ce qui compte : un fichier récupéré passe par
`useEditor.getState().importPaths(...)`, **la même route que le sélecteur natif**. À partir de là
l'éditeur ignore d'où il vient — glisser-déposer, découpe, effets, mixage, export fonctionnent
parce que rien ne les distingue d'un fichier local. C'est aussi pourquoi le format de document
n'apprend rien de ce module : une recherche et une file d'attente appartiennent à la session, pas
au projet.

Deux détails rendent la progression lisible plutôt que devinée :

* `--progress-template` demande à yt-dlp d'imprimer exactement les champs voulus, sur des lignes
  marquées. Le parseur n'a donc jamais à interpréter une ligne écrite pour un humain, et un
  changement dans la sortie par défaut de l'outil ne peut pas casser la barre.
* La **conversion** — fusion image + son, ou extraction audio — est un état distinct. Elle prend du
  temps réel sur un fichier long et n'a aucun pourcentage : sans la nommer, la file resterait à
  100 % en donnant l'impression d'être bloquée.

`--ignore-config` compte plus qu'il n'y paraît : un fichier de configuration présent sur la machine
pourrait changer le gabarit de sortie, le format ou la destination sous nos pieds, et l'application
perdrait alors la trace du fichier qu'elle vient de récupérer.

### Comment la clé Gemini reste hors du webview

Elle n'y entre jamais. Le front-end ne peut que l'**écrire** (`ai_set_key`) et demander un
*statut* — configurée ou non, quel dépôt, quatre derniers caractères. Il n'existe aucune commande
qui la renvoie.

L'appel HTTP part donc de Rust, ce qui règle trois choses d'un coup : la clé ne traverse pas le
processus de rendu, aucune CSP ni CORS ne s'applique, et la mise en forme de l'erreur se fait là où
l'on connaît le code HTTP. Deux dépôts, dans cet ordre :

| Dépôt | Ce que ça vaut |
|---|---|
| `keychain` | Trousseau du système (Credential Manager, Keychain). Chiffré par l'OS, lié au compte. |
| `file` | Repli : XOR contre un keystream SHA-256 dans le dossier applicatif. **Ce n'est pas du chiffrement** — qui lit le fichier lit le sel à côté. Ça évite la clé en clair dans une sauvegarde, rien de plus. |

Le panneau de réglages affiche lequel est actif et le dit dans ces termes. Linux passe par le
repli : le backend secret-service impose D-Bus au build *et* à l'exécution, et une session sans
interface n'a pas de trousseau.

En mode navigateur (`npm run dev`), la clé vit dans `localStorage` et l'appel part du navigateur —
suffisant pour mettre au point un prompt, et l'interface le signale sans détour.

### Comment un quota épuisé ne bloque pas le montage

L'API renvoie **deux problèmes très différents** sous le même code 429, et les distinguer est ce
qui décide du remède :

| | Ce que c'est | Le remède |
|---|---|---|
| `rate-limit` | Une rafale de requêtes en quelques secondes | Attendre — le délai exact vient de `details[].retryDelay`, lu dans le corps et non dans un en-tête |
| `quota` | L'allocation du palier gratuit, épuisée | Attendre ne sert à rien : seul un autre modèle a de la marge |

Un quota épuisé n'est donc **pas** réessayé sur le même modèle — ce serait trois refus au lieu
d'un. Le client parcourt à la place une chaîne de modèles, et comme Gemini compte les quotas
**par modèle**, le suivant repart d'un compteur neuf immédiatement.

La chaîne n'est parcourue que pour un quota. Une clé refusée, une requête malformée ou un réseau
coupé échoueraient à l'identique sur chaque modèle de la liste : y insister ne ferait que
multiplier l'attente avant de le dire.

Le modèle qui a réellement répondu est renvoyé avec la réponse, et le basculement est annoncé —
sans quoi on verrait le ton changer sans savoir pourquoi.

### Comment un plan de l'IA n'est qu'une seule annulation

Chaque action générée est une fonction **pure** `Project → Project` ([`lib/ai/plan.ts`](src/lib/ai/plan.ts)). Un plan
de quatorze modifications se plie donc en une seule, et part par `transact()` — l'unique accès
public au chemin d'écriture du store :

```
actions[] ──reduce──▶ (project) => project'  ──transact()──▶ patchProject()
                                                              └─ une entrée d'historique
                                                              └─ une sauvegarde
                                                              └─ un balayage des transitions orphelines
```

Passer par les mutations publiques aurait produit quatorze entrées d'historique — donc quatorze
pressions sur Ctrl+Z pour défaire un geste unique. C'est la même raison qui vaut pour les sous-titres
(cent clips) et le smart cut (toutes les pistes réécrites).

Rien de ce qui revient du modèle n'est pris pour argent comptant : `normalizePlan` reconstruit
chaque action champ par champ, et chaque gestionnaire résout ses références ou **rejette** avec un
motif. Un plan peut être partiellement appliqué — onze bonnes modifications valent d'être gardées,
et les trois écartées sont listées dans la carte plutôt qu'avalées.

### Comment une suite de textes reste une suite

Un titre et une série de paroles n'ont pas la même règle de placement, et les confondre casse la
seconde. Un titre est un **empilement** : posé sur une couche occupée, il monte d'un cran — c'est à
ça que servent les couches. Une suite de répliques est une **séquence** : elle tient sur une piste
et chaque ligne se retire quand la suivante arrive.

Appliquer les actions une par une ne peut pas produire ça. La ligne à 11,2 s trouve V2 libre, celle
à 13,6 s la trouve occupée et monte sur V3 — deux paroles à l'écran en même temps. Les actions
`addText` d'un même plan sont donc réconciliées **avant** d'être appliquées :

* celles qui visent la même piste forment une *run*, triée par temps de départ ;
* chaque ligne est raccourcie pour finir là où la suivante commence — le modèle donne un timing
  juste et une durée par défaut, et c'est la durée qu'il faut corriger, pas la demande ;
* la piste est choisie une fois pour **toute l'étendue** de la run, pas ligne par ligne.

Une seule action `addText` n'est pas une séquence et garde le comportement d'empilement.

### Comment les sous-titres retombent au bon endroit

La transcription ne se fait pas sur un mixage de la timeline mais **clip par clip** : chaque plan
audible est extrait de son propre fichier, sur ses propres points d'entrée / sortie. Un clip rogné
transcrit donc ce qu'on entend, pas ce que le fichier contient.

Le report des temps est la partie délicate, et elle est composée explicitement :

```
extrait  : couvre le temps source à partir de `sourceStart`
clip     : temps source `s` ⟶ timeline `clip.start + (s - clip.offset)`
segment  : timeline = clip.start + (sourceStart + t) - clip.offset
```

Sous Tauri, `sourceStart` vaut le point d'entrée du clip et les deux termes s'annulent. Dans le
navigateur, faute de transcodeur, le fichier entier part au modèle et ils ne s'annulent pas. Écrire
la composition en toutes lettres est ce qui fait tomber les deux hôtes au même endroit.

L'audio envoyé est du mono 16 kHz en Opus 24 kbit/s — au-delà, la précision de transcription
n'augmente plus et la charge utile, elle, oui. Si `libopus` manque à l'installation de ffmpeg, on
descend l'échelle : MP3, puis AAC, tous deux acceptés par Gemini.

### Pourquoi animer une vitesse demande une intégrale

Les trois réglages d'un fond s'animent par les canaux `bg:speed`, `bg:scale` et `bg:intensity`.
Le préfixe n'est pas décoratif : un fond a une `scale` et le calque qui le porte aussi ; sans
espace de noms, animer les formes redimensionnerait la couche.

Le reste de la machinerie n'a rien demandé. `toggleChannel`, les images clés, l'éditeur de courbes,
le copier-coller travaillent déjà sur une chaîne de caractères quelconque : il a suffi d'apprendre
à `staticValueOf`, `writeStatic` et `resolveClipAt` à lire et écrire ces trois valeurs. Le bornage
vit dans `resolveClipAt`, c'est-à-dire à l'endroit où la valeur est *lue* — donc le viewer, le bake
et un plan composé à la main sont tenus aux mêmes limites par la même fonction.

La vitesse, elle, a demandé un vrai changement. Un taux ne se multiplie pas par l'horloge dès qu'il
varie : dessiner à `temps × vitesse(t)` fait **sauter** le motif au moment où la vitesse change —
accélérer de 0,2 à 1 à t = 10 le téléporterait huit secondes plus loin. Ce dont les décors ont
besoin est l'intégrale de la vitesse, continue par construction quelle que soit la brutalité du
changement.

Le peintre ne lit donc plus `speed` du tout : il reçoit une **phase**. Sans image clé, elle vaut
`vitesse × temps`, exactement — le cas courant ne coûte rien. Avec, elle s'accumule segment par
segment sur les courbes d'easing : quelques images clés, quelques subdivisions chacune, et un coût
indépendant de la durée du clip.

### Comment un fond généré arrive jusqu'à l'export

Un fond est **un `kind` plus un sac de nombres et de couleurs** — la même forme qu'un effet, et
pour la même raison : le format de document ne bouge pas quand un décor s'ajoute. Aucun pixel n'est
stocké, seulement la recette.

Une seule fonction dessine, `paintBackground`, et deux appelants très différents s'en servent : le
canvas de la preview soixante fois par seconde, et le bake d'export une fois par image de sortie.
Qu'ils partagent le code est tout l'intérêt — un fond correct dans le viewer et différent au rendu
serait pire que pas de fond du tout.

« Pure » se prend au sens strict : rien ne lit d'horloge ni n'appelle `Math.random`. Chaque
position vient de la graine du calque et du temps qu'on lui passe, donc l'image 412 de l'export est
au pixel près celle que le viewer affiche à l'arrêt sur 412.

Le moteur de rendu, lui, n'apprend jamais que les fonds générés existent : il reçoit des PNG,
exactement comme pour le texte. Un fond en mouvement est bâti comme une séquence — c'est le seul
cas où l'absence d'image clé ne veut pas dire immobile — et une vitesse à zéro le ramène à une
image unique.

Deux détails de dessin qui font la différence entre « généré » et « joli » : les formes sont des
**dégradés radiaux à décroissance alpha**, pas des `ctx.filter = blur()` — le flou canvas au rayon
qu'il faudrait coûte des dizaines de millisecondes par image en 4K, et un dégradé est un seul
remplissage pour le même résultat. Et chaque décor se termine par une vignette : sans elle,
l'image est uniformément lumineuse jusqu'aux bords, ce qui est la signature d'un rendu par boucle.

### Comment un calque devient une suite de mots

`splitTextClips` remplace un calque de texte par un clip par mot. Piste, style, position et effets
sont repris tels quels ; seuls le contenu, le minutage et l'entrée changent. Le premier morceau
garde l'identifiant du calque, donc une sélection ou le focus de l'inspecteur y survivent.

La seule vraie décision est le partage de la durée. Des tranches égales lisent mal — « je » et
« extraordinaire » occupent l'écran aussi longtemps, ce qui a l'air mécanique parce que ça l'est.
La pondération se fait donc sur la longueur, avec un plancher : un mot de deux lettres doit rester
visible, et le calage sur les images doit laisser la suite couvrir **exactement** la portée du
calque d'origine — une erreur d'arrondi répétée quinze fois est une dérive visible. Un calque trop
court pour son nombre de mots est refusé, avec sa raison, plutôt que découpé en clips invisibles.

L'apparition `punch` a ses propres règles. Un mot présent un tiers de seconde ne peut pas s'offrir
un cinquième de seconde d'arrivée : l'entrée est deux fois plus courte que les autres, elle
**descend** depuis au-dessus de la taille pleine — le dépassement est ce qui fait lire un impact
plutôt qu'un fondu — et elle n'a aucune sortie, puisque le mot suivant remplace le précédent.
Faire disparaître un mot pendant que le suivant arrive est exactement ce qui rend une ligne
karaoké molle.

L'opération est pure et passe par `transact`, donc quinze mots restent **une** annulation.

### Comment l'assistant agit sur la sélection

Trois pièces, et il en faut les trois pour que « agrandis-les de 20 % » marche.

**Ce qu'il voit.** La description du projet porte un tableau `selection`, et chaque clip concerné
un `"selected": true` — les clips sélectionnés échappent d'ailleurs à la troncature qui limite les
longs montages, puisqu'ils sont précisément ce dont la demande parle.

**Ce qu'il sait.** `scale`, `opacity`, `x`, `y`, `rotation` et `volume` accompagnent chaque clip,
mais **seulement lorsqu'ils diffèrent du défaut**. Un montage de deux cents clips reste donc
compact, et une demande relative devient calculable : sans la valeur courante, « 20 % plus grand »
n'a pas de réponse.

**Ce qu'il écrit.** Une action peut viser `selection` au lieu de nommer chaque identifiant —
l'énumération est exactement ce qu'un modèle rate au quatrième clip. L'expansion en une action par
clip a lieu **à la construction du plan**, pas à son application : la carte affiche donc de vrais
noms, et appliquer plus tard ne peut pas agir sur une sélection entre-temps modifiée.

`moveClip` est délibérément exclu de l'expansion : déplacer plusieurs clips au même instant les
empilerait les uns dans les autres, ce que la demande ne veut jamais dire.

### Pourquoi l'assistant n'écrit jamais un texte de mémoire

Un modèle de langue interrogé sur des paroles de chanson ou un dialogue ne les *lit* pas : il s'en
souvient, approximativement. Le résultat est presque juste — et un texte presque juste posé sur une
timeline est pire qu'un texte absent, parce qu'il a l'air correct. Aucun réglage de température ni
formulation de prompt ne corrige un défaut de rappel.

L'assistant a donc pour consigne de ne jamais produire un texte qu'il n'a pas sous les yeux, et
d'orienter vers l'un des deux chemins qui, eux, lisent quelque chose :

| Chemin | Ce que le modèle fait | Quand |
|---|---|---|
| **Transcrire** | Il écoute l'audio et écrit ce qu'il entend | Le texte n'existe nulle part ailleurs |
| **Caler** | Il reçoit le texte et ne renvoie que les timecodes | Vous avez déjà les mots |

Le second est nettement le plus fiable, parce qu'il remplace une tâche de mémoire par une tâche de
lecture. La consigne de calage répète la même règle de trois façons — pas une correction
d'orthographe, pas une reformulation, pas un ajout — et demande explicitement d'**omettre** les
lignes inaudibles plutôt que de les placer au jugé.

Un texte que l'utilisateur donne dans la conversation, en revanche, l'assistant le pose sans
hésiter : c'est lui qui l'apporte, le modèle ne fait que le découper et le minuter.

### Comment le smart cut ne casse pas la synchro

Le silence est **mesuré**, pas jugé : ffmpeg décode en PCM mono 8 kHz, on calcule une enveloppe RMS
par paquets, et un seuil en dBFS plus une durée minimale donnent les intervalles. Le même fichier
donne toujours les mêmes coupes. Les hésitations, elles, sont **jugées** par le modèle — c'est une
passe distincte, optionnelle, et les deux jeux d'intervalles fusionnent avant application.

La suppression, elle, est globale. Ne couper que la piste analysée décalerait tout le reste de la
durée retirée : chaque piste subit donc le même glissement, qu'une coupe l'ait touchée ou non.

Trois choses sont préservées, et c'est ce qui sépare une coupe propre d'une coupe à refaire :

- **le point d'entrée source** — un morceau qui survit repart à `offset + (coupe - début du clip)`,
  donc l'image ne saute pas ;
- **les images clés** — recalées sur le nouveau début, et une clé **interpolée** est posée aux
  bornes : un fondu coupé en deux reste à mi-course à l'endroit de la coupe. Un clip qu'aucune
  coupe n'a touché garde ses courbes à l'octet près ;
- **l'identité** — le premier morceau conserve l'`id` du clip, donc une sélection, une transition
  ou le focus de l'inspecteur y survivent.

Un seuil qui ne trouve rien n'est pas un montage déjà serré : c'est presque toujours un réglage
inadapté à la prise. La fenêtre propose alors le seuil qu'elle a *mesuré* sur le matériau — le
90ᵉ centile du RMS moins 26 dB.

### Comment la barre d'espace fait deux choses

Maintenue, elle transforme la timeline en outil main : clic gauche et glisser déplacent la vue.
Tapée, elle reste la lecture / pause. Les deux tiennent sur la même touche parce que la décision
est prise au **relâchement**, pas à l'enfoncement :

```
keydown  espace ──▶ spaceHeld = true          (rien d'autre)
pointerdown pendant ──▶ markSpacePan()        (capture : gagne sur le clip et sur la règle)
keyup    espace ──▶ spacePanned ? rien : togglePlay()
```

Le geste de panoramique est capté en phase de **capture** sur le conteneur défilant, sinon il
perdrait contre le clip en dessous — qui se déplacerait — ou contre la règle — qui scrubberait.
Une perte de focus en cours de maintien relâche l'état : sans cela, un `alt-tab` laisserait la
timeline coincée en mode main, le `keyup` n'étant jamais livré.

### Comment une modification dans la preview atteint une propriété animée

Le gizmo et le glisser de calque n'écrivent pas les champs du clip : ils passent par
`setProperty(clipId, channel, value)`, qui pose une **image clé sous le curseur** quand le canal
est animé et écrit le champ statique sinon. Manipuler à la souris et taper une valeur dans
l'inspecteur suivent donc exactement le même chemin.

Deux détails rendent le geste correct plutôt que seulement fonctionnel :

- le glisser part du clip **résolu** — la valeur affichée à cet instant, pas le champ statique que
  l'animation ne lit plus. Sans cela, le calque sauterait au premier mouvement du pointeur ;
- `x` et `y` sont écrits séparément, parce qu'ils s'animent séparément : déplacer un calque dont
  seul `y` est animé ne doit pas se mettre à animer `x`.

### Comment une sélection multiple reste lisible

`Ctrl` + clic ajoute ou retire ; un clic simple recommence une sélection d'un seul clip. Cette
seconde règle n'est pas cosmétique : le glisser qui suit un clic déplace **un** clip, et laisser un
groupe surligné pendant ce geste ferait mentir le surlignage sur ce que l'on est en train de
déplacer. Le clic droit, lui, conserve le groupe — c'est par le menu contextuel qu'on agit dessus.

Le store garde les deux formes côte à côte : `selectedClipIds` est l'ensemble, `selectedClipId` le
dernier ajouté. La seconde n'est pas dérivée de la première parce que des dizaines de lecteurs
mono-clip — inspecteur, éditeur de courbes, panneau d'animation — continuent ainsi de fonctionner
sans être touchés.

Couper, supprimer, copier et dupliquer parcourent l'ensemble en **une** écriture : boucler sur les
mutations unitaires produirait une entrée d'historique par clip, donc cinq `Ctrl+Z` pour défaire
une suppression de cinq clips.

### Format de projet

Un fichier par projet, lisible et diffable :

```jsonc
{
  "id": "…", "name": "Teaser produit", "createdAt": 0, "updatedAt": 0,
  "settings": { "width": 1920, "height": 1080, "fps": 30 },
  "assets":  [{ "id": "as_…", "name": "a.mp4", "kind": "video", "path": "C:\\…\\a.mp4",
                "duration": 12.4, "width": 1920, "height": 1080, "size": 4210000 }],
  "tracks":  [{ "id": "tr_…", "kind": "video", "name": "V1", "height": 68,
                "muted": false, "locked": false, "hidden": false }],
  "clips":   [{ "id": "cl_…", "assetId": "as_…", "trackId": "tr_…",
                "start": 0, "duration": 12.4, "offset": 0,
                "volume": 1, "opacity": 1, "scale": 1, "muted": false,
                "effects": [{ "id": "fx_…", "kind": "saturation", "enabled": true,
                              "params": { "amount": 1.35 } }] }],
  "transitions": [{ "id": "tx_…", "kind": "crossfade", "trackId": "tr_…",
                    "fromClipId": "cl_…", "toClipId": "cl_…", "duration": 0.8 }],
  "schemaVersion": 4
}
```

Un clip animé porte en plus une carte `animation` : `{ "x": [{ "id", "time", "value", "easing" }] }`,
où `time` est en secondes depuis le début du clip. Rust la transporte sans jamais l'interpréter.

Un clip de texte porte `"kind": "text"`, `"assetId": null` et un objet `text` (contenu, police,
style). Rust le transporte tel quel sans jamais l'interpréter : la rasterisation est le travail du
front-end.

Un effet est volontairement **un `kind` plus un sac de nombres**. Les plages, libellés et valeurs
neutres vivent dans le registre [`types/effects.ts`](src/types/effects.ts) : ajouter un filtre est
une entrée dans ce tableau, et l'inspecteur, la preview et le plan de rendu suivent seuls. Le
format de document, lui, ne bouge jamais.

Une transition stocke ses **voisins**, pas un temps absolu : déplacer ou rogner un clip l'emporte
avec lui. Quand la jonction disparaît, le store balaie l'orpheline à l'écriture suivante.

Les documents en schéma 1 (sans `effects` ni `transitions`) sont migrés à l'ouverture par
`normalizeProject()` — côté Rust, `#[serde(default)]` fait le même travail.

`assets[].path` est le seul lien vers le disque : c'est lui qui est reconstruit en URL `asset://`
à la réouverture.

---

## Le moteur, et la suite

Le montage produit un **plan de rendu** — la timeline aplatie en segments ordonnés par couche,
avec chemins source, points d'entrée/sortie, gains, **chaînes de filtres** et **planning des
transitions**. Le bouton *Exporter* l'affiche, puis l'encode.

Les commandes Rust qui portent cette passerelle :

| Commande | Rôle |
|---|---|
| `process_timeline_segments(project)` | Aplatit tout le document en `RenderPlan` |
| `describe_effect_chain(effects)` | Traduit une pile de filtres en fragments ffmpeg |
| `encoder_status()` | Où est ffmpeg, quelle version, ffprobe présent ou non |
| `export_render(project, output)` | Encode réellement, progression par événements |
| `resolve_media(requests, hints)` | Vérifie et relocalise les chemins de médias |
| `write_baked_layer(key, png)` | Reçoit une rasterisation du front-end |

### Le filtergraph, en une phrase par étape

[`engine/ffmpeg.rs`](src-tauri/src/engine/ffmpeg.rs) traduit le plan en un seul `-filter_complex` :

1. chaque segment vidéo est découpé à l'entrée (`-ss` / `-t`), conformé au cadre du projet
   (`scale` + `pad`), passé dans sa chaîne d'effets, puis zoomé si le clip l'est ;
2. il reçoit son alpha — opacité du clip, plus les rampes de fondu enchaîné — en `yuva420p` ;
3. `tpad` le décale à sa position sur la timeline avec des images transparentes ;
4. les segments sont empilés du bas vers le haut par `overlay` sur un fond noir : **un fondu
   enchaîné tombe alors tout seul des rampes alpha**, sans `xfade` ;
5. les fondus au noir et au blanc s'appliquent à la composition finie ;
6. l'audio est décalé (`adelay`), pondéré (`volume`) et mixé (`amix`).

`repeatlast=0` sur chaque `overlay` est ce qui empêche la dernière image d'un plan de rester peinte
sur toute la suite du montage.

La construction des arguments est une fonction pure : neuf tests la couvrent sans que ffmpeg soit
installé.

La seconde est appelée **à chaque mouvement de curseur** dans l'inspecteur : la chaîne affichée
sous les réglages est celle que le moteur produirait réellement, pas une approximation de
l'interface. Le badge indique laquelle des deux implémentations a répondu — Rust en desktop, le
[jumeau TypeScript](src/lib/effectChain.ts) en navigateur.

Les deux traductions doivent coïncider au caractère près. Huit tests Rust (`cargo test --lib`)
verrouillent les chaînes attendues :

```
eq=brightness=0.150 · eq=contrast=1.200 · eq=saturation=1.350
gblur=sigma=3.00    · hue=h=30          · hue=s=0.000
xfade=transition=fade:duration=0.8:offset=3.6
fade=t=out:st=3.6:d=0.4:color=black,fade=t=in:st=4:d=0.4:color=black
```

L'encodage lui-même est le prochain jalon. Le point d'ancrage est le trait
[`Encoder`](src-tauri/src/engine/mod.rs) :

```rust
pub trait Encoder {
    fn name(&self) -> &'static str;
    fn encode(&self, plan: &RenderPlan, output: &Path,
              on_progress: &mut dyn FnMut(EncodeProgress)) -> Result<(), String>;
}
```

Une implémentation ffmpeg en Rust et un worker Python hors-processus s'y branchent de la même
manière — la couche commande n'a pas à savoir lequel tourne.

Pistes suivantes : proxies de lecture (la seule vraie réponse au décodage 4K), décodage de
vignettes par intervalles (vrai film-strip), historique undo/redo, courbes d'animation sur les
paramètres d'effet, choix du codec et du débit à l'export.

---

## Scripts

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur Vite (navigateur) |
| `npm run build` | Typecheck + bundle de production |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run desktop` | `tauri dev` |
| `npm run desktop:build` | Bundle desktop |
| `npm run icons` | Régénère `src-tauri/icons/` (icônes dessinées par code) |
| `cargo test --lib` | 33 tests : mapping ffmpeg, filtergraph, relocalisation (depuis `src-tauri/`) |

## Design

Fond ardoise profond (`#0D0F12`), surfaces translucides à filets `white/6`, accent indigo → violet
(`#4F46E5` base, `#7C3AED` au survol) réservé aux actions et à la matière vidéo, or (`#FBBF24`)
réservé à l'audio — deux teintes opposées sur la roue, pour qu'une piste son ne soit jamais
confondue avec une piste image.
Typographie Inter Variable embarquée (aucun appel réseau). Les jetons vivent dans
[`tailwind.config.js`](tailwind.config.js) et [`src/styles/index.css`](src/styles/index.css).
