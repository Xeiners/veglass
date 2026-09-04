<!-- CAPTURE 1 — docs/images/hero.png
     L'éditeur complet, un projet chargé, timeline garnie, preview qui montre
     quelque chose de reconnaissable. C'est l'image qui décide si on lit la suite.
     Décommentez la ligne ci-dessous une fois le fichier déposé. -->
<!-- ![Veglass](docs/images/hero.png) -->

# Veglass

**Un banc de montage vidéo qui tourne sur votre machine.**

Le montage classique — importer, couper, superposer, titrer, exporter — plus ce
qui prend d'ordinaire le plus de temps : découper une longue vidéo en clips
courts, caler les sous-titres, narrer un tutoriel, passer un 16:9 en vertical.

Vos fichiers restent chez vous. Rien n'est téléversé, aucun compte requis.

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
Veglass propose de le télécharger lui-même.

```bash
rustup default stable        # une fois
npm run desktop              # tauri dev
npm run desktop:build        # bundle signé (.msi / .exe / .dmg / .AppImage)
```

---

## Le montage

<!-- CAPTURE 2 — docs/images/timeline.png
     La timeline avec plusieurs pistes, un clip sélectionné, des images clés
     visibles sur une piste. Cadrez large : c'est le cœur du logiciel. -->
<!-- ![Timeline multi-pistes](docs/images/timeline.png) -->

Timeline multi-pistes, preview synchronisée au rendu, images clés sur la
position, l'échelle, la rotation, l'opacité et le volume — avec éditeur de
courbes.

Six effets empilables et animables (luminosité, contraste, saturation, teinte,
flou, noir et blanc), trois transitions, un mixeur par piste avec compresseur et
filtres.

Texte complet : polices, contour, ombre, fond de boîte. Fonds animés générés,
bandeaux, arrière-plan « verre » qui remplit le vide autour d'un clip recadré.
Repères de chapitre pour naviguer un montage long.

---

## L'assistant

<!-- CAPTURE 3 — docs/images/viral.png
     Le tableau de bord des clips viraux, avec ses vignettes, ses scores et ses
     titres. C'est la fonction la plus démonstrative du logiciel. -->
<!-- ![Générateur de clips viraux](docs/images/viral.png) -->

**Clips viraux.** Une vidéo longue entre ; Veglass l'écoute, repère les passages
qui tiennent debout seuls, et propose une série d'extraits notés. Chacun part
dans le projet ou devient une séquence verticale recadrée, sous-titrée, avec un
bandeau d'accroche sur les trois premières secondes.

**Sous-titres.** Transcription automatique, ou calage d'un texte que vous
fournissez — la seconde méthode est nettement plus fidèle. Ligne par ligne ou
mot par mot, animé.

<!-- CAPTURE 4 — docs/images/kits.png
     L'onglet Brand kits de l'assistant, avec les trois modèles et leurs aperçus
     côte à côte. -->
<!-- ![Brand kits](docs/images/kits.png) -->

**Brand kits.** Vos styles de sous-titres et d'accroche, enregistrés et
réutilisables d'un projet à l'autre. Trois modèles fournis.

**Tutoriels.** Un enregistrement d'écran brut entre, un montage sort : caméra
qui zoome sur ce qui compte, narration calée dessus, un chapitre par étape.

**Coupe intelligente.** Silences et hésitations détectés, supprimés en une seule
annulation.

**Assistant conversationnel.** Vous décrivez ce que vous voulez, en français. Il
propose, vous acceptez ou refusez — rien n'est appliqué sans votre accord.

**Reformatage.** Tout un projet du 16:9 au 9:16 : chaque image recadrée, chaque
titre repositionné, chaque mouvement de caméra recalculé.

> Ces fonctions demandent une clé Google AI Studio (gratuite), rangée dans le
> trousseau du système et jamais lisible depuis l'interface.

---

## Médias en ligne

<!-- CAPTURE 5 — docs/images/online.png
     Le panneau Médias en ligne : recherche à droite, file de téléchargement à
     gauche, avec au moins un résultat visible. -->
<!-- ![Médias en ligne](docs/images/online.png) -->

Recherche et téléchargement depuis YouTube, avec choix de la qualité, du format
et de la piste audio seule. Les fichiers récupérés se comportent comme des
imports locaux.

> Le téléchargement peut contrevenir aux conditions d'utilisation du site et aux
> droits sur l'œuvre. C'est votre responsabilité.

---

## Export

<!-- CAPTURE 6 — docs/images/export.png
     La fenêtre d'export, réglages visibles, idéalement pendant un rendu pour
     qu'on voie la barre de progression. -->
<!-- ![Export](docs/images/export.png) -->

Rendu par ffmpeg : résolution, débit, encodeur — accélération matérielle quand
la machine en a une. Le rendu tourne en tâche de fond, avec une progression
réelle et une annulation qui fonctionne.

Voix de synthèse en option, via une clé ElevenLabs : la narration se pose sur la
timeline comme un clip audio, avec atténuation automatique de la musique.

En mode desktop, Veglass vérifie discrètement au lancement s'il existe une
version plus récente. Hors ligne, il n'en parle pas et s'ouvre normalement.

---

## Où sont vos données

| | |
|---|---|
| Projets | `%APPDATA%\app.veglass.editor\projects` |
| ffmpeg et yt-dlp | `%APPDATA%\app.veglass.editor\bin` |
| Clés d'API | Trousseau du système |

Un projet est un `.json` qui *référence* vos médias sans les copier. Déplacer un
fichier source ne casse rien : Veglass propose de le relocaliser.
