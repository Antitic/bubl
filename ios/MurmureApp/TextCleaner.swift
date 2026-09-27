import Foundation

/// Post-processing of raw Whisper output.
enum TextCleaner {
    /// Phrases Whisper tends to invent on silence or noise (learned from subtitle corpora).
    private static let hallucinations: [String] = [
        "sous-titres réalisés par la communauté d'amara.org",
        "sous-titrage st' 501",
        "sous-titrage société radio-canada",
        "merci d'avoir regardé cette vidéo",
        "merci d'avoir regardé",
        "sottotitoli creati dalla comunità amara.org",
        "sottotitoli a cura di qtss",
        "grazie per la visione",
        "thank you for watching",
        "thanks for watching",
        "subtitles by the amara.org community",
    ]

    private static let fillerPattern = #"(?i)(?<![\p{L}'’])(euh+|heu+|hum+|hmm+|mmh+|uh+|um+|ehm+|ehh+|eh+m)(?![\p{L}'’])[,.…]?"#

    static func clean(_ raw: String, removeFillers: Bool) -> String {
        var text = raw

        // Non-speech annotations like [Musique], (rires), [BLANK_AUDIO], *applause*.
        text = text.replacingOccurrences(of: #"\[[^\]]*\]"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\*[^*]*\*"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(
            of: #"(?i)\((musique|music|musica|rires?|laughs?|laughter|risate|applaudissements|applause|applausi|silence|silenzio)\)"#,
            with: " ",
            options: .regularExpression
        )

        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: ".!… "))
        if hallucinations.contains(where: { normalized == $0 || normalized.hasPrefix($0) && normalized.count < $0.count + 4 }) {
            return ""
        }

        if removeFillers {
            text = text.replacingOccurrences(of: fillerPattern, with: " ", options: .regularExpression)
        }

        // Tidy whitespace left behind: collapse runs, no space before , and .
        text = text.replacingOccurrences(of: #"[ \t]{2,}"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #" +([,.])"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"^[\s,.]+"#, with: "", options: .regularExpression)
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)

        // Removing a leading filler can leave a lowercase start.
        if let first = text.first, first.isLowercase {
            text = first.uppercased() + text.dropFirst()
        }
        return text
    }
}
