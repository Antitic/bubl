import Foundation

/// Checks shown in the app to find out why the keyboard is missing or cannot talk to the app.
enum KeyboardDiagnostics {
    struct Check: Identifiable {
        let id: String
        let title: String
        let ok: Bool
        let detail: String?
    }

    static func run() -> [Check] {
        let extensionPresent = keyboardExtensionPresent()
        let enabled = keyboardEnabled()
        let groupOK = MurmureShared.containerURL != nil
        let lastSeen = MurmureShared.sharedDefaults.object(forKey: SettingsKey.keyboardLastSeen) as? Date

        var checks = [
            Check(
                id: "extension",
                title: "Extension clavier installée",
                ok: extensionPresent,
                detail: extensionPresent ? nil
                    : "SideStore a retiré le clavier à l'installation. Supprime Murmure, réinstalle l'IPA et choisis « Keep App Extensions » (garder les extensions)."
            ),
            Check(
                id: "enabled",
                title: "Clavier ajouté dans les Réglages",
                ok: enabled,
                detail: enabled ? nil
                    : "Réglages › Général › Clavier › Claviers › Ajouter un clavier… › Murmure. Si Murmure n'est pas dans la liste, redémarre l'iPhone."
            ),
            Check(
                id: "group",
                title: "Groupe partagé app ↔ clavier",
                ok: groupOK,
                detail: groupOK ? nil
                    : "Le groupe d'app n'a pas été enregistré à la signature. Réinstalle via SideStore (Apple ID connecté)."
            ),
        ]

        let fullAccessOK = lastSeen != nil
        checks.append(Check(
            id: "fullAccess",
            title: "Accès complet actif",
            ok: fullAccessOK,
            detail: lastSeen.map { "Clavier vu pour la dernière fois \($0.formatted(.relative(presentation: .named)))." }
                ?? "Active « Autoriser l'accès complet » pour Murmure, puis ouvre le clavier une fois dans n'importe quelle app."
        ))
        return checks
    }

    private static func keyboardExtensionPresent() -> Bool {
        guard let plugins = Bundle.main.builtInPlugInsURL,
              let items = try? FileManager.default.contentsOfDirectory(atPath: plugins.path) else { return false }
        return items.contains { $0.hasSuffix(".appex") }
    }

    /// iOS lists enabled keyboards (bundle IDs) in the global "AppleKeyboards" preference.
    private static func keyboardEnabled() -> Bool {
        let keyboards = UserDefaults.standard.array(forKey: "AppleKeyboards") as? [String] ?? []
        let ownPrefix = (Bundle.main.bundleIdentifier ?? "com.tikawski.murmure").lowercased()
        return keyboards.contains { $0.lowercased().hasPrefix(ownPrefix) || $0.lowercased().contains("murmure") }
    }
}
