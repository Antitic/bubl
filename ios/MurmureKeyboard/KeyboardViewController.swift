import UIKit

final class KeyboardViewController: UIInputViewController {
    private let topBar = TopBarView()
    private let keyboardView = KeyboardView()
    private var heightConstraint: NSLayoutConstraint?

    private lazy var spell = SpellEngine()
    private lazy var dictation = DictationClient { [weak self] in self?.hasFullAccess ?? false }

    private var mode: KeyboardMode = .letters
    private var shift: ShiftState = .off {
        didSet { if shift != oldValue { keyboardView.shiftState = shift } }
    }
    private var lastShiftTap = Date.distantPast
    private var lastSpaceTap = Date.distantPast
    /// Set right after an autocorrection so that backspace can undo it.
    private var revertable: (original: String, corrected: String, separator: String)?
    private var suggestionGeneration = 0
    private var dictationTicker: Timer?

    private var autocorrectEnabled: Bool {
        guard hasFullAccess else { return true }
        return MurmureShared.sharedDefaults.object(forKey: SettingsKey.autocorrect) as? Bool ?? true
    }

    private var proxy: UITextDocumentProxy { textDocumentProxy }

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()

        topBar.translatesAutoresizingMaskIntoConstraints = false
        keyboardView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(topBar)
        view.addSubview(keyboardView)
        NSLayoutConstraint.activate([
            topBar.topAnchor.constraint(equalTo: view.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topBar.heightAnchor.constraint(equalToConstant: 46),
            keyboardView.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            keyboardView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            keyboardView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            keyboardView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        topBar.delegate = self
        keyboardView.delegate = self

        dictation.onChange = { [weak self] in self?.dictationChanged() }
        dictation.onResult = { [weak self] text in self?.insertDictation(text) }

        requestSupplementaryLexicon { [weak self] lexicon in
            self?.spell.load(lexicon: lexicon)
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        applyAppearance()
        if proxy.keyboardType == .numbersAndPunctuation || proxy.keyboardType == .numberPad || proxy.keyboardType == .decimalPad {
            mode = .numbers
        }
        reloadKeys()
        updateReturnKey()
        updateAutoShift()
        updateSuggestions()
        dictation.activate()
        dictationChanged()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        dictation.deactivate()
        dictationTicker?.invalidate()
        dictationTicker = nil
    }

    override func updateViewConstraints() {
        let landscape = traitCollection.verticalSizeClass == .compact
        keyboardView.rowHeight = landscape ? 40 : 54
        keyboardView.topPadding = landscape ? 2 : 6
        let height = 46 + keyboardView.topPadding + keyboardView.rowHeight * 4 + 4
        if let heightConstraint {
            heightConstraint.constant = height
        } else {
            let constraint = view.heightAnchor.constraint(equalToConstant: height)
            constraint.priority = UILayoutPriority(999)
            constraint.isActive = true
            heightConstraint = constraint
        }
        super.updateViewConstraints()
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        view.setNeedsUpdateConstraints()
        applyAppearance()
    }

    override func textDidChange(_ textInput: UITextInput?) {
        super.textDidChange(textInput)
        applyAppearance()
        updateReturnKey()
        updateAutoShift()
        updateSuggestions()
    }

    // MARK: - Appearance

    private func applyAppearance() {
        let dark = proxy.keyboardAppearance == .dark || traitCollection.userInterfaceStyle == .dark
        let theme = KeyboardTheme(isDark: dark)
        view.backgroundColor = theme.background
        keyboardView.theme = theme
        topBar.theme = theme
        dictationChanged()
    }

    private func reloadKeys() {
        keyboardView.setRows(KeyboardLayouts.rows(for: mode, showGlobe: needsInputModeSwitchKey), mode: mode)
        keyboardView.shiftState = shift
    }

    private func updateReturnKey() {
        let title: String
        var highlighted = true
        switch proxy.returnKeyType ?? .default {
        case .go: title = "aller"
        case .google, .yahoo, .search: title = "rechercher"
        case .join: title = "rejoindre"
        case .next: title = "suivant"
        case .route: title = "itinéraire"
        case .send: title = "envoyer"
        case .done: title = "OK"
        case .emergencyCall: title = "urgence"
        case .continue: title = "continuer"
        default:
            title = "retour"
            highlighted = false
        }
        keyboardView.returnTitle = title
        keyboardView.returnIsHighlighted = highlighted
    }

    // MARK: - Text helpers

    private var textBefore: String { proxy.documentContextBeforeInput ?? "" }

    private static let wordCharacters: CharacterSet = {
        var set = CharacterSet.letters
        set.insert(charactersIn: "-")
        return set
    }()

    /// The word being typed right before the cursor (without any elided prefix like l' or dell').
    private func currentWord() -> String {
        var word = ""
        for scalarChar in textBefore.reversed() {
            guard scalarChar.unicodeScalars.allSatisfy(Self.wordCharacters.contains) else { break }
            word.insert(scalarChar, at: word.startIndex)
        }
        while word.hasPrefix("-") { word.removeFirst() }
        return word
    }

    private func isSentenceStart(before text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard let last = trimmed.last else { return true }
        return ".!?…\n".contains(last)
    }

    private func delete(characters count: Int) {
        for _ in 0..<count { proxy.deleteBackward() }
    }

    // MARK: - Shift

    private func updateAutoShift() {
        guard mode == .letters, shift != .locked else { return }
        let type = proxy.autocapitalizationType ?? .sentences
        let before = textBefore
        let shouldCapitalize: Bool
        switch type {
        case .none:
            shouldCapitalize = false
        case .allCharacters:
            shouldCapitalize = true
        case .words:
            shouldCapitalize = before.isEmpty || before.last?.isWhitespace == true
        default:
            shouldCapitalize = before.isEmpty
                || before.hasSuffix("\n")
                || (before.last?.isWhitespace == true && isSentenceStart(before: String(before.dropLast())))
        }
        shift = shouldCapitalize ? .once : .off
    }

    // MARK: - Typing

    private func insert(_ text: String) {
        let isSeparator = text.count == 1 && " .,;:!?)»\n".contains(text)
        if isSeparator, autocorrectEnabled, proxy.autocorrectionType != .no {
            autocorrectCurrentWord(separator: text)
        } else {
            revertable = nil
        }
        proxy.insertText(text)

        if shift == .once, mode == .letters { shift = .off }
        if mode != .letters, text == "'" || text == " " {
            // Like the system keyboard: back to letters after an apostrophe or a space.
            mode = .letters
            reloadKeys()
        }
        updateAutoShift()
        updateSuggestions()
    }

    private func autocorrectCurrentWord(separator: String) {
        revertable = nil
        let word = currentWord()
        guard !word.isEmpty else { return }
        let before = String(textBefore.dropLast(word.count))
        guard let correction = spell.autocorrection(for: word, atSentenceStart: isSentenceStart(before: before)),
              correction != word else { return }
        delete(characters: word.count)
        proxy.insertText(correction)
        revertable = (word, correction, separator)
    }

    private func handleSpace() {
        let now = Date()
        let before = textBefore
        defer { lastSpaceTap = now }
        // Double space → ". "
        if now.timeIntervalSince(lastSpaceTap) < 0.45, before.hasSuffix(" "),
           let previous = before.dropLast().last, previous.isLetter || previous.isNumber {
            proxy.deleteBackward()
            proxy.insertText(". ")
            revertable = nil
            lastSpaceTap = .distantPast
            updateAutoShift()
            updateSuggestions()
            return
        }
        insert(" ")
    }

    private func handleBackspace() {
        if let revertable, textBefore.hasSuffix(revertable.corrected + revertable.separator) {
            delete(characters: revertable.corrected.count + revertable.separator.count)
            proxy.insertText(revertable.original)
            spell.ignore(revertable.original)
            self.revertable = nil
        } else {
            revertable = nil
            proxy.deleteBackward()
        }
        updateAutoShift()
        updateSuggestions()
    }

    // MARK: - Suggestions

    private func updateSuggestions() {
        suggestionGeneration += 1
        let generation = suggestionGeneration
        let word = currentWord()
        guard !word.isEmpty else {
            topBar.setSuggestions([])
            return
        }
        let before = String(textBefore.dropLast(word.count))
        spell.suggestions(for: word, atSentenceStart: isSentenceStart(before: before)) { [weak self] suggestions in
            guard let self, generation == self.suggestionGeneration else { return }
            var list = suggestions
            if !self.autocorrectEnabled || self.proxy.autocorrectionType == .no {
                list = list.map { SpellEngine.Suggestion(text: $0.text, kind: $0.kind) }
            }
            self.topBar.setSuggestions(list)
        }
    }

    private func apply(_ suggestion: SpellEngine.Suggestion) {
        let word = currentWord()
        delete(characters: word.count)
        proxy.insertText(suggestion.text + " ")
        if suggestion.kind == .literal { spell.ignore(suggestion.text) }
        revertable = nil
        if shift == .once { shift = .off }
        updateAutoShift()
        updateSuggestions()
    }

    // MARK: - Dictation

    private func dictationChanged() {
        topBar.update(phase: dictation.phase, level: dictation.level)
        if case .recording = dictation.phase {
            if dictationTicker == nil {
                dictationTicker = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
                    guard let self else { return }
                    self.topBar.update(phase: self.dictation.phase, level: self.dictation.level)
                }
            }
        } else {
            dictationTicker?.invalidate()
            dictationTicker = nil
        }
    }

    private func micTapped() {
        dictation.refresh()
        switch dictation.phase {
        case .noFullAccess:
            topBar.flash("Active « Autoriser l'accès complet » dans Réglages › Clavier › Murmure", duration: 4)
        case .sessionOff:
            if !openContainingApp(path: "start") {
                topBar.flash("Ouvre l'app Murmure pour démarrer la session micro", duration: 4)
            }
        case .idle:
            dictation.start()
        case .recording:
            dictation.stop()
        case .transcribing:
            break
        }
    }

    private func insertDictation(_ raw: String) {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        let before = textBefore

        // Continuing a sentence: lower-case Whisper's leading capital unless it is a name or "I".
        if !isSentenceStart(before: before), let firstWord = text.split(separator: " ").first {
            let word = String(firstWord).trimmingCharacters(in: .punctuationCharacters)
            let lowered = word.lowercased()
            let isAcronym = word.count > 1 && word == word.uppercased()
            let isPronounI = ["i", "i'm", "i’m", "i've", "i'll", "i'd"].contains(lowered)
            if !isAcronym, !isPronounI, word.first?.isUppercase == true, spell.isKnown(lowered) {
                text = text.prefix(1).lowercased() + text.dropFirst()
            }
        }

        if let last = before.last, !last.isWhitespace, !"([{\"'’«/-".contains(last) {
            text = " " + text
        }
        text += " "
        proxy.insertText(text)
        revertable = nil
        updateAutoShift()
        updateSuggestions()
    }

    /// Extensions cannot call UIApplication.open directly; walk the responder chain to reach it.
    @discardableResult
    private func openContainingApp(path: String) -> Bool {
        guard let url = URL(string: "\(MurmureShared.urlScheme)://\(path)") else { return false }
        let selector = NSSelectorFromString("openURL:options:completionHandler:")
        var responder: UIResponder? = self
        while let current = responder {
            if current.responds(to: selector), NSStringFromClass(type(of: current)).contains("Application"),
               let method = current.method(for: selector) {
                typealias OpenURL = @convention(c) (AnyObject, Selector, NSURL, NSDictionary, AnyObject?) -> Void
                let open = unsafeBitCast(method, to: OpenURL.self)
                open(current, selector, url as NSURL, NSDictionary(), nil)
                return true
            }
            responder = current.next
        }
        return false
    }
}

// MARK: - KeyboardViewDelegate

extension KeyboardViewController: KeyboardViewDelegate {
    func keyboardView(_ view: KeyboardView, didActivate action: KeyAction) {
        switch action {
        case .insert(let text):
            insert(text)
        case .space:
            handleSpace()
        case .returnKey:
            insert("\n")
        case .nextKeyboard:
            advanceToNextInputMode()
        case .mode(let newMode):
            mode = newMode
            if newMode == .letters { updateAutoShift() }
            reloadKeys()
        case .shift, .backspace:
            break
        }
    }

    func keyboardViewDidPressBackspace(_ view: KeyboardView) {
        handleBackspace()
    }

    func keyboardViewDidPressShift(_ view: KeyboardView) {
        let now = Date()
        if now.timeIntervalSince(lastShiftTap) < 0.3 {
            shift = .locked
        } else {
            shift = shift == .off ? .once : .off
        }
        lastShiftTap = now
    }

    func keyboardView(_ view: KeyboardView, moveCursorBy offset: Int) {
        proxy.adjustTextPosition(byCharacterOffset: offset)
    }
}

// MARK: - TopBarViewDelegate

extension KeyboardViewController: TopBarViewDelegate {
    func topBarDidTapMic(_ bar: TopBarView) {
        micTapped()
    }

    func topBarDidTapCancel(_ bar: TopBarView) {
        dictation.cancel()
    }

    func topBar(_ bar: TopBarView, didSelect suggestion: SpellEngine.Suggestion) {
        apply(suggestion)
    }
}
