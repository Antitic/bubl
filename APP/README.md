# Bubl — Application portable Windows 🫧

Ce dossier contient l'application **Bubl** déjà compilée, prête à l'emploi sous
Windows 10/11 (x64).

## Fichier

- **`Bubl-Portable-1.0.0.exe`** — exécutable portable autonome (~72 Mo).

## Utilisation

1. Copiez `Bubl-Portable-1.0.0.exe` où vous voulez (clé USB, bureau, dossier…).
2. **Double-cliquez** dessus. Aucune installation, aucun droit administrateur
   requis.
3. Au premier lancement, l'exécutable décompresse le runtime dans un dossier
   temporaire et démarre le navigateur.

> Le format « portable » d'electron-builder est un exécutable auto-extractible :
> tout (runtime Electron/Chromium embarqué inclus) est contenu dans ce seul
> fichier. Seul WebView2, déjà présent sur Windows 10/11, est utilisé comme
> dépendance système.

## Comment cet exécutable a été produit

Depuis la racine du dépôt :

```bash
npm install
npm run build      # electron-builder --win portable dir
```

Sortie générée dans `dist/` :
- `Bubl-Portable-1.0.0.exe` (cible **portable**, copié ici dans `APP/`)
- `win-unpacked/` (cible **dir** : dossier décompressé exécutable directement
  via `Bubl.exe` — non versionné car `Bubl.exe` dépasse la limite de 100 Mo de
  GitHub).

Build réalisé avec : Electron 33.4.11, electron-builder 25.1.8, NSIS, sans
signature de code (l'exécutable n'est pas signé — Windows SmartScreen peut
afficher un avertissement au premier lancement ; cliquez sur « Informations
complémentaires » → « Exécuter quand même »).
