# Veglass

**Un banc de montage vidéo qui tourne sur votre machine.**

Veglass fait le montage classique — importer, couper, superposer, titrer, exporter —
et y ajoute ce qui prend d'ordinaire le plus de temps : transformer une longue
vidéo en clips courts, écrire et caler les sous-titres, narrer un tutoriel,
passer un montage 16:9 en format vertical.

Vos fichiers restent chez vous. Rien n'est téléversé, aucun compte n'est requis.

---

## Démarrer

### Mode navigateur

Immédiat, aucune dépendance système.

```bash
npm install
npm run dev          # http://localhost:1420
```

L'application est entièrement fonctionnelle dans le navigateur : création de
projet, import par glisser-déposer, preview, timeline, montage.

Les projets sont enregistrés dans le `localStorage`, et les médias sont
référencés par `blob:` — ils ne survivent donc pas à un rechargement de page. La
bibliothèque signale les fichiers à réimporter.

### Mode desktop

Nécessite la toolchain Rust. L'export a en plus besoin de **ffmpeg** — sur le
`PATH`, à côté de l'exécutable, ou désigné par `VEGLASS_FFMPEG`. À défaut,
Veglass propose de le télécharger dans son propre dossier.

```bash
rustup default stable        # une fois
npm run desktop              # tauri dev
npm run desktop:build        # bundle signé (.msi / .exe / .dmg / .AppImage)
```

---

## Le montage

**Timeline multi-pistes.** Autant de pistes vidéo et audio que nécessaire.
Couper, déplacer, rogner, dupliquer, copier-coller avec les effets. Sélection
multiple au `Ctrl` + clic pour agir sur plusieurs clips d'un coup. `Espace`
maintenu pour naviguer dans la vue.

**Preview synchronisée.** Ce que vous voyez est ce qui sera exporté — même
typographie, même cadrage, même fond. Les manipulations directes sur l'image
(déplacement, échelle, rotation) écrivent des images clés quand le canal est
animé, au lieu d'écraser la valeur.

**Animation.** Images clés sur la position, l'échelle, la rotation, l'opacité et
le volume, avec éditeur de courbes et réglage de l'accélération.

**Effets et transitions.** Luminosité, contraste, saturation, teinte, flou, noir
et blanc — empilables et animables. Fondu enchaîné, au noir, au blanc.

**Texte.** Polices, contour, ombre portée, fond de boîte, alignement. Découpage
d'un titre en un clip par mot, animé.

**Habillages.** Fonds animés générés (dégradés, orbes floutés), bandeaux et
tiers inférieurs, arrière-plan « verre » qui remplit le vide autour d'un clip
recadré plutôt que de laisser du noir.

**Repères de chapitre** sur la règle, pour naviguer un montage long par ses
étapes plutôt qu'en cherchant à l'oreille.

**Mixage.** Volume, panoramique, filtres passe-haut et passe-bas, compresseur
par piste. Solo et coupure.

---

## Ce que l'assistant sait faire

Ces fonctions demandent une clé Google AI Studio (gratuite), à saisir dans les
réglages. Elle est rangée dans le trousseau du système d'exploitation et n'est
jamais lisible depuis l'interface.

**Clips viraux.** Vous donnez une vidéo longue ; Veglass l'écoute, repère les
passages qui tiennent debout seuls, et vous propose une série d'extraits avec
un titre, une estimation et un aperçu. Chacun peut partir dans le projet ouvert
ou devenir une séquence verticale à part, recadrée en 9:16, sous-titrée, avec un
bandeau d'accroche sur les trois premières secondes.

**Sous-titres.** Transcription automatique, ou calage d'un texte que vous
fournissez — la seconde méthode est nettement plus fidèle. Affichage ligne par
ligne ou mot par mot, animé.

**Brand kits.** Vos styles de sous-titres et d'accroche, enregistrés et
réutilisables d'un projet à l'autre : police, couleurs, contour, fond, position,
animation. Trois modèles fournis.

**Tutoriels.** Un enregistrement d'écran brut entre, un montage sort : une
caméra qui se déplace et zoome sur ce qui compte, une narration calée dessus,
un repère de chapitre par étape.

**Coupe intelligente.** Détection des silences et des hésitations, supprimés en
une seule annulation.

**Assistant conversationnel.** Vous décrivez ce que vous voulez, en français ;
il propose des modifications que vous acceptez ou refusez. Rien n'est appliqué
sans votre accord.

**Reformatage.** Passer tout un projet du 16:9 au 9:16 — chaque image
recadrée, chaque titre repositionné, chaque mouvement de caméra recalculé.

---

## Médias en ligne

Recherche et téléchargement depuis YouTube, avec choix de la qualité, du format
et de la piste audio seule. Les fichiers récupérés se comportent exactement
comme des imports locaux.

> Le téléchargement peut contrevenir aux conditions d'utilisation du site et aux
> droits sur l'œuvre. C'est votre responsabilité.

---

## Export

Rendu par ffmpeg, avec choix de la résolution, du débit et de l'encodeur —
accélération matérielle quand la machine en a une. Le rendu tourne en tâche de
fond, avec une progression réelle et une annulation qui fonctionne.

---

## Voix de synthèse

Facultatif, via une clé ElevenLabs. Génère une narration posée sur la timeline
comme n'importe quel clip audio, avec atténuation automatique de la musique
dessous.

---

## Mises à jour

En mode desktop, Veglass vérifie discrètement au lancement s'il existe une
version plus récente et vous propose de l'installer. Hors ligne, il n'en parle
pas et s'ouvre normalement.

---

## Où sont vos données

| | |
|---|---|
| Projets | `%APPDATA%\app.veglass.editor\projects` |
| ffmpeg et yt-dlp | `%APPDATA%\app.veglass.editor\bin` |
| Clés d'API | Trousseau du système, jamais dans un fichier du projet |

Un projet est un fichier `.json` qui *référence* vos médias sans les copier.
Déplacer un fichier source ne casse rien : Veglass propose de le relocaliser.
