import UIKit

/// Autocorrect and suggestions across French, English and Italian at the same time.
///
/// A word is accepted if any of the three dictionaries knows it. Otherwise candidates from all
/// three are ranked by a keyboard-aware edit distance, with a bias towards the language the user
/// has been typing recently (so "tre" becomes "tré…" in a French sentence but stays in Italian).
final class SpellEngine {
    struct Suggestion: Equatable {
        enum Kind { case literal, correction, completion }
        let text: String
        let kind: Kind
        /// Would be applied automatically on the next space.
        var isAutocorrection = false
    }

    private struct Candidate {
        let text: String
        let cost: Double
        let accentOnly: Bool
    }

    private let checker = UITextChecker()
    private let queue = DispatchQueue(label: "bubl.spell", qos: .userInitiated)
    private let languages: [String]
    private var weights: [String: Double] = [:]
    private var ignored: Set<String>
    private var lexiconWords = Set<String>()
    private var shortcuts: [String: String] = [:]

    private static let ignoredKey = "ignoredWords"

    init() {
        let available = UITextChecker.availableLanguages
        func pick(_ preferred: [String], prefix: String) -> String? {
            preferred.first(where: available.contains) ?? available.first { $0.hasPrefix(prefix) }
        }
        languages = [
            pick(["fr_FR", "fr"], prefix: "fr"),
            pick(["en_US", "en_GB", "en"], prefix: "en"),
            pick(["it_IT", "it"], prefix: "it"),
        ].compactMap { $0 }
        for language in languages { weights[language] = 1 / Double(max(1, languages.count)) }
        ignored = Set(UserDefaults.standard.stringArray(forKey: Self.ignoredKey) ?? [])
    }

    // MARK: - Public API

    func load(lexicon: UILexicon) {
        var words = Set<String>()
        var map: [String: String] = [:]
        for entry in lexicon.entries {
            if entry.userInput.caseInsensitiveCompare(entry.documentText) == .orderedSame {
                words.insert(entry.documentText.lowercased())
            } else {
                map[entry.userInput.lowercased()] = entry.documentText
            }
        }
        queue.async {
            self.lexiconWords = words
            self.shortcuts = map
        }
    }

    /// Remember a word the user explicitly kept (tapped the literal suggestion or undid a correction).
    func ignore(_ word: String) {
        queue.async {
            self.ignored.insert(word.lowercased())
            UserDefaults.standard.set(Array(self.ignored.suffix(500)), forKey: Self.ignoredKey)
        }
    }

    /// Correction to apply when a word is finished (space or punctuation), or nil to keep it.
    /// Also feeds the language-context model. Synchronous: it runs on the key press.
    func autocorrection(for word: String, atSentenceStart: Bool) -> String? {
        queue.sync { computeAutocorrection(for: word, atSentenceStart: atSentenceStart, learn: true) }
    }

    /// Suggestions for the word being typed, delivered on the main queue.
    func suggestions(for word: String, atSentenceStart: Bool, completion: @escaping ([Suggestion]) -> Void) {
        queue.async {
            let result = self.computeSuggestions(for: word, atSentenceStart: atSentenceStart)
            DispatchQueue.main.async { completion(result) }
        }
    }

    /// Whether a word is known in any of the languages (used to decide casing of dictated text).
    func isKnown(_ word: String) -> Bool {
        queue.sync { known(word) }
    }

    // MARK: - Core

    private func computeAutocorrection(for word: String, atSentenceStart: Bool, learn: Bool) -> String? {
        guard word.count >= 2, word.rangeOfCharacter(from: .decimalDigits) == nil else { return nil }
        if let shortcut = shortcuts[word.lowercased()] { return shortcut }

        let knownIn = knownLanguages(word)
        if !knownIn.isEmpty || isUserWord(word) {
            if learn { updateWeights(knownIn: knownIn) }
            return nil
        }

        // Capitalized word mid-sentence is probably a name: leave it alone.
        if !atSentenceStart, word.first?.isUppercase == true, word.count > 1 { return nil }

        let candidates = rankedCandidates(for: word)
        guard let best = candidates.first else { return nil }

        let maxCost = word.count >= 7 ? 1.6 : 1.05
        if best.accentOnly {
            // "tres" → "très", "perche" → "perché": always safe.
        } else {
            guard word.count >= 3, best.cost <= maxCost else { return nil }
            if candidates.count > 1, !candidates[1].accentOnly, candidates[1].cost - best.cost < 0.12 { return nil }
        }
        return matchCase(of: word, to: best.text)
    }

    private func computeSuggestions(for word: String, atSentenceStart: Bool) -> [Suggestion] {
        guard !word.isEmpty else { return [] }
        let range = NSRange(location: 0, length: (word as NSString).length)
        var result: [Suggestion] = [Suggestion(text: word, kind: .literal)]
        var seen: Set<String> = [word.lowercased()]

        func add(_ text: String, _ kind: Suggestion.Kind, auto: Bool = false) {
            let cased = matchCase(of: word, to: text)
            guard seen.insert(cased.lowercased()).inserted else { return }
            result.append(Suggestion(text: cased, kind: kind, isAutocorrection: auto))
        }

        if let correction = computeAutocorrection(for: word, atSentenceStart: atSentenceStart, learn: false) {
            add(correction, .correction, auto: true)
        }

        let isKnownWord = !knownLanguages(word).isEmpty || isUserWord(word)
        if !isKnownWord, word.count >= 3 {
            for candidate in rankedCandidates(for: word).prefix(2) where candidate.cost <= 2 {
                add(candidate.text, .correction)
            }
        }

        // Completions from the most likely language first.
        for language in languagesByWeight() {
            let completions = checker.completions(forPartialWordRange: range, in: word, language: language) ?? []
            for completion in completions.prefix(3) { add(completion, .completion) }
            if result.count >= 5 { break }
        }
        return Array(result.prefix(3))
    }

    // MARK: - Dictionary checks

    private func knownLanguages(_ word: String) -> [String] {
        let range = NSRange(location: 0, length: (word as NSString).length)
        return languages.filter {
            checker.rangeOfMisspelledWord(in: word, range: range, startingAt: 0, wrap: false, language: $0).location == NSNotFound
        }
    }

    private func isUserWord(_ word: String) -> Bool {
        let lower = word.lowercased()
        return ignored.contains(lower) || lexiconWords.contains(lower) || UITextChecker.hasLearnedWord(word)
    }

    private func known(_ word: String) -> Bool {
        isUserWord(word) || !knownLanguages(word).isEmpty
    }

    // MARK: - Ranking

    private func rankedCandidates(for word: String) -> [Candidate] {
        let range = NSRange(location: 0, length: (word as NSString).length)
        let typed = word.lowercased()
        var best: [String: Candidate] = [:]

        for language in languages {
            let guesses = checker.guesses(forWordRange: range, in: word, language: language) ?? []
            for (rank, guess) in guesses.prefix(6).enumerated() {
                let lower = guess.lowercased()
                let accentOnly = fold(lower) == fold(typed)
                var cost = Self.editCost(typed, lower)
                cost += 0.08 * Double(rank)
                cost -= 0.3 * (weights[language] ?? 0)
                if guess.contains(" ") { cost += 0.6 }
                if let existing = best[lower], existing.cost <= cost { continue }
                best[lower] = Candidate(text: guess, cost: cost, accentOnly: accentOnly)
            }
        }
        return best.values.sorted { $0.cost < $1.cost }
    }

    private func languagesByWeight() -> [String] {
        languages.sorted { (weights[$0] ?? 0) > (weights[$1] ?? 0) }
    }

    /// Words valid in only some languages tell us which language is being typed.
    private func updateWeights(knownIn: [String]) {
        guard !knownIn.isEmpty, knownIn.count < languages.count else { return }
        let share = 0.2 / Double(knownIn.count)
        for language in languages {
            weights[language] = (weights[language] ?? 0) * 0.8 + (knownIn.contains(language) ? share : 0)
        }
    }

    private func fold(_ text: String) -> String {
        text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
    }

    private func matchCase(of typed: String, to candidate: String) -> String {
        guard let first = typed.first else { return candidate }
        if typed.count > 1, typed == typed.uppercased(), typed != typed.lowercased() {
            return candidate.uppercased()
        }
        if first.isUppercase, let candidateFirst = candidate.first {
            return candidateFirst.uppercased() + candidate.dropFirst()
        }
        return candidate
    }

    // MARK: - Edit distance

    private static let neighbours: [Character: Set<Character>] = {
        let rows: [(String, CGFloat)] = [("azertyuiop", 0), ("qsdfghjklm", 0.25), ("wxcvbn", 1.5)]
        var positions: [Character: CGPoint] = [:]
        for (rowIndex, (letters, offset)) in rows.enumerated() {
            for (column, letter) in letters.enumerated() {
                positions[letter] = CGPoint(x: CGFloat(column) + offset, y: CGFloat(rowIndex))
            }
        }
        var map: [Character: Set<Character>] = [:]
        for (a, pa) in positions {
            for (b, pb) in positions where a != b {
                if abs(pa.y - pb.y) <= 1, hypot(pa.x - pb.x, pa.y - pb.y) <= 1.3 {
                    map[a, default: []].insert(b)
                }
            }
        }
        return map
    }()

    private static func baseLetter(_ c: Character) -> Character {
        String(c).folding(options: .diacriticInsensitive, locale: nil).first ?? c
    }

    private static func substitutionCost(_ a: Character, _ b: Character) -> Double {
        if a == b { return 0 }
        let fa = baseLetter(a), fb = baseLetter(b)
        if fa == fb { return 0.25 }
        if neighbours[fa]?.contains(fb) == true { return 0.7 }
        return 1
    }

    private static func indelCost(_ c: Character) -> Double {
        c == "'" || c == "’" || c == "-" ? 0.3 : 1
    }

    /// Weighted Damerau-Levenshtein: accents and neighbouring keys are cheap mistakes.
    static func editCost(_ lhs: String, _ rhs: String) -> Double {
        let a = Array(lhs), b = Array(rhs)
        if a.isEmpty { return b.reduce(0) { $0 + indelCost($1) } }
        if b.isEmpty { return a.reduce(0) { $0 + indelCost($1) } }
        var d = Array(repeating: Array(repeating: 0.0, count: b.count + 1), count: a.count + 1)
        for i in 1...a.count { d[i][0] = d[i - 1][0] + indelCost(a[i - 1]) }
        for j in 1...b.count { d[0][j] = d[0][j - 1] + indelCost(b[j - 1]) }
        for i in 1...a.count {
            for j in 1...b.count {
                var value = min(
                    d[i - 1][j] + indelCost(a[i - 1]),
                    d[i][j - 1] + indelCost(b[j - 1]),
                    d[i - 1][j - 1] + substitutionCost(a[i - 1], b[j - 1])
                )
                if i > 1, j > 1, a[i - 1] == b[j - 2], a[i - 2] == b[j - 1] {
                    value = min(value, d[i - 2][j - 2] + 0.7)
                }
                d[i][j] = value
            }
        }
        return d[a.count][b.count]
    }
}
