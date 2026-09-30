# Murmure – clavier iOS avec dictée Whisper locale

Clavier AZERTY pour iPhone avec :

- **Dictée vocale 100 % locale** : Whisper large-v3-turbo tourne sur le Neural Engine via [WhisperKit](https://github.com/argmaxinc/WhisperKit). Aucun serveur.
- **Français, anglais et italien** : en mode Auto, Whisper choisit l'une des trois langues à chaque dictée.
- **Correcteur orthographique trilingue** : un mot est accepté s'il existe dans l'une des trois langues. Sinon, la correction privilégie la langue que tu tapes en ce moment. Suggestions dans la barre du haut, et retour arrière pour annuler une correction.
- AZERTY complet : accents en appui long (é è ê à ç ù œ…), majuscules auto, double espace → « . », barre d'espace pour déplacer le curseur, verrouillage des majuscules.

## Comment ça marche

iOS interdit le micro aux claviers. Comme Wispr Flow, Murmure fonctionne donc en deux parties :

1. **L'app Murmure** tient le micro ouvert en arrière-plan pendant une « session », fait tourner Whisper et renvoie le texte.
2. **Le clavier** envoie « start » et « stop » à l'app (notifications Darwin + App Group partagé) et insère le texte reçu.

La première fois que tu touches 🎤, le clavier ouvre Murmure, qui démarre la session et l'enregistrement. Reviens dans ton app avec « ◀︎ » en haut à gauche. Ensuite, tant que la session est active (15 min d'inactivité par défaut), 🎤 démarre et arrête la dictée sans jamais quitter ton app.

## Installer avec SideStore

1. Sur l'iPhone, ouvre la page **Releases** du repo → `ios-latest` → télécharge `Murmure.ipa`.
2. Dans SideStore : **My Apps › +** → choisis `Murmure.ipa`. Si SideStore demande quoi faire des extensions, choisis **Keep App Extensions** : sinon le clavier n'est pas installé.
3. Ouvre Murmure → télécharge le modèle **Large v3 Turbo** en Wi-Fi (≈ 630 Mo) et attends « Prêt ». Le premier chargement compile le modèle, ce qui prend 1 à 3 minutes.
4. Réglages › Général › Clavier › Claviers › Ajouter › **Murmure**, puis active **Autoriser l'accès complet**.

> En cas de souci, la section **Diagnostic du clavier** en bas de l'app indique ce qui bloque.
>
> Avec un Apple ID gratuit, SideStore limite à 3 app IDs actifs. Murmure en utilise 2 (l'app et le clavier). Il faut aussi rafraîchir tous les 7 jours dans SideStore.

## Compiler

Pas besoin de Mac : chaque push qui touche `ios/` lance `.github/workflows/ios.yml` sur un runner macOS. Ce workflow génère le projet avec XcodeGen, compile sans signature, signe en ad-hoc avec les entitlements (App Group), puis publie l'IPA.

En local, sur un Mac :

```sh
brew install xcodegen
cd ios && xcodegen generate && open Murmure.xcodeproj
```

## Structure

| Dossier | Contenu |
|---|---|
| `Shared/` | App Group (compatible SideStore), état et résultat partagés, notifications Darwin |
| `MurmureApp/` | App SwiftUI : session micro, capture 16 kHz, WhisperKit, nettoyage du texte |
| `MurmureKeyboard/` | Extension clavier : disposition, vue des touches, correcteur, barre de suggestions et micro |
