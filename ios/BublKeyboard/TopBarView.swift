import UIKit

protocol TopBarViewDelegate: AnyObject {
    func topBarDidTapMic(_ bar: TopBarView)
    func topBarDidTapCancel(_ bar: TopBarView)
    func topBar(_ bar: TopBarView, didSelect suggestion: SpellEngine.Suggestion)
}

/// Suggestion strip on the left, dictation button on the right. While dictating, the
/// suggestions are replaced by a status line with a level meter.
final class TopBarView: UIView {
    weak var delegate: TopBarViewDelegate?

    var theme = KeyboardTheme(isDark: false) { didSet { applyTheme() } }

    private let suggestionStack = UIStackView()
    private var suggestionButtons: [UIButton] = []
    private var dividers: [UIView] = []
    private var suggestions: [SpellEngine.Suggestion] = []

    private let statusView = UIView()
    private let statusLabel = UILabel()
    private let meter = LevelMeterView()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let cancelButton = UIButton(type: .system)

    private let micButton = UIButton(type: .custom)
    private let micBackground = UIView()
    private let sessionDot = UIView()

    private var flashTimer: Timer?

    override init(frame: CGRect) {
        super.init(frame: frame)

        suggestionStack.axis = .horizontal
        suggestionStack.distribution = .fill
        suggestionStack.alignment = .center
        addSubview(suggestionStack)
        for index in 0..<3 {
            let button = UIButton(type: .custom)
            button.titleLabel?.font = .systemFont(ofSize: 17)
            button.titleLabel?.lineBreakMode = .byTruncatingMiddle
            button.tag = index
            button.addTarget(self, action: #selector(suggestionTapped(_:)), for: .touchUpInside)
            suggestionButtons.append(button)
            suggestionStack.addArrangedSubview(button)
            if index < 2 {
                let divider = UIView()
                divider.translatesAutoresizingMaskIntoConstraints = false
                divider.widthAnchor.constraint(equalToConstant: 1 / UIScreen.main.scale).isActive = true
                divider.heightAnchor.constraint(equalToConstant: 22).isActive = true
                dividers.append(divider)
                suggestionStack.addArrangedSubview(divider)
            }
        }
        suggestionButtons[1].widthAnchor.constraint(equalTo: suggestionButtons[0].widthAnchor).isActive = true
        suggestionButtons[2].widthAnchor.constraint(equalTo: suggestionButtons[0].widthAnchor).isActive = true

        statusView.isHidden = true
        addSubview(statusView)
        statusLabel.font = .systemFont(ofSize: 15, weight: .medium)
        statusLabel.adjustsFontSizeToFitWidth = true
        statusLabel.minimumScaleFactor = 0.7
        statusView.addSubview(statusLabel)
        statusView.addSubview(meter)
        spinner.hidesWhenStopped = true
        statusView.addSubview(spinner)
        cancelButton.setImage(UIImage(systemName: "xmark.circle.fill"), for: .normal)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        statusView.addSubview(cancelButton)

        micBackground.isUserInteractionEnabled = false
        micBackground.layer.cornerRadius = 17
        addSubview(micBackground)
        micButton.setImage(UIImage(systemName: "mic.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
        micButton.addTarget(self, action: #selector(micTapped), for: .touchUpInside)
        addSubview(micButton)
        sessionDot.layer.cornerRadius = 3.5
        sessionDot.backgroundColor = .systemGreen
        sessionDot.isHidden = true
        sessionDot.isUserInteractionEnabled = false
        addSubview(sessionDot)

        applyTheme()
        setSuggestions([])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let micSize: CGFloat = 44
        micButton.frame = CGRect(x: bounds.width - micSize - 4, y: (bounds.height - micSize) / 2, width: micSize, height: micSize)
        micBackground.frame = micButton.frame.insetBy(dx: 5, dy: 5)
        micBackground.layer.cornerRadius = micBackground.bounds.width / 2
        sessionDot.frame = CGRect(x: micBackground.frame.maxX - 6, y: micBackground.frame.minY - 1, width: 7, height: 7)

        let content = CGRect(x: 4, y: 0, width: micButton.frame.minX - 8, height: bounds.height)
        suggestionStack.frame = content
        statusView.frame = content
        let h = content.height
        cancelButton.frame = CGRect(x: 0, y: (h - 36) / 2, width: 36, height: 36)
        meter.frame = CGRect(x: content.width - 44, y: (h - 20) / 2, width: 40, height: 20)
        spinner.center = CGPoint(x: content.width - 24, y: h / 2)
        statusLabel.frame = CGRect(x: 40, y: 0, width: content.width - 40 - 50, height: h)
    }

    // MARK: - Suggestions

    func setSuggestions(_ newSuggestions: [SpellEngine.Suggestion]) {
        suggestions = newSuggestions
        // Slot order like the system: literal on the left, best guess in the middle.
        var slots: [SpellEngine.Suggestion?] = [nil, nil, nil]
        if !newSuggestions.isEmpty {
            let literal = newSuggestions.first { $0.kind == .literal }
            let others = newSuggestions.filter { $0.kind != .literal }
            if let literal, !others.isEmpty {
                slots = [literal, others[0], others.count > 1 ? others[1] : nil]
            } else if let literal {
                slots = [nil, literal, nil]
            } else {
                slots = [others.first, others.count > 1 ? others[1] : nil, others.count > 2 ? others[2] : nil]
            }
        }
        for (index, button) in suggestionButtons.enumerated() {
            let suggestion = slots[index]
            var title = suggestion?.text ?? ""
            if suggestion?.kind == .literal, slots[1] != nil, index == 0 { title = "« \(title) »" }
            button.setTitle(title, for: .normal)
            button.titleLabel?.font = suggestion?.isAutocorrection == true ? .systemFont(ofSize: 17, weight: .semibold) : .systemFont(ofSize: 17)
            button.accessibilityValue = suggestion?.text
            button.isEnabled = suggestion != nil
        }
        slotSuggestions = slots
    }

    private var slotSuggestions: [SpellEngine.Suggestion?] = [nil, nil, nil]

    @objc private func suggestionTapped(_ sender: UIButton) {
        guard let suggestion = slotSuggestions[sender.tag] else { return }
        delegate?.topBar(self, didSelect: suggestion)
    }

    // MARK: - Dictation

    func update(phase: DictationClient.Phase, level: Float) {
        guard flashTimer == nil else { return }
        sessionDot.isHidden = true
        micBackground.layer.removeAnimation(forKey: "pulse")
        spinner.stopAnimating()
        meter.isHidden = true
        cancelButton.isHidden = true
        micButton.isEnabled = true

        switch phase {
        case .noFullAccess, .sessionOff:
            showStatus(false)
            micBackground.backgroundColor = theme.functionalKey
            micButton.tintColor = theme.text
        case .idle:
            showStatus(false)
            sessionDot.isHidden = false
            micBackground.backgroundColor = theme.functionalKey
            micButton.tintColor = theme.text
        case .recording(let since):
            showStatus(true)
            let seconds = max(0, Int(Date().timeIntervalSince(since)))
            statusLabel.text = String(format: "Écoute… %d:%02d", seconds / 60, seconds % 60)
            meter.isHidden = false
            meter.level = CGFloat(level)
            cancelButton.isHidden = false
            micBackground.backgroundColor = .systemRed
            micButton.tintColor = .white
            micButton.setImage(UIImage(systemName: "stop.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .bold)), for: .normal)
            addPulse()
            return
        case .transcribing(let message):
            showStatus(true)
            statusLabel.text = message ?? "Transcription…"
            spinner.startAnimating()
            micBackground.backgroundColor = .systemOrange
            micButton.tintColor = .white
            micButton.isEnabled = false
        }
        micButton.setImage(UIImage(systemName: "mic.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
    }

    /// Temporary message in the status line (errors, hints).
    func flash(_ message: String, duration: TimeInterval = 3) {
        flashTimer?.invalidate()
        showStatus(true)
        statusLabel.text = message
        meter.isHidden = true
        spinner.stopAnimating()
        cancelButton.isHidden = true
        flashTimer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
            self?.flashTimer = nil
            self?.showStatus(false)
        }
    }

    private func showStatus(_ visible: Bool) {
        statusView.isHidden = !visible
        suggestionStack.isHidden = visible
    }

    private func addPulse() {
        guard micBackground.layer.animation(forKey: "pulse") == nil else { return }
        let pulse = CABasicAnimation(keyPath: "transform.scale")
        pulse.fromValue = 1
        pulse.toValue = 1.12
        pulse.duration = 0.6
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        micBackground.layer.add(pulse, forKey: "pulse")
    }

    @objc private func micTapped() {
        UIDevice.current.playInputClick()
        delegate?.topBarDidTapMic(self)
    }

    @objc private func cancelTapped() {
        delegate?.topBarDidTapCancel(self)
    }

    private func applyTheme() {
        for button in suggestionButtons {
            button.setTitleColor(theme.text, for: .normal)
            button.setTitleColor(theme.text.withAlphaComponent(0.4), for: .highlighted)
        }
        dividers.forEach { $0.backgroundColor = theme.text.withAlphaComponent(0.25) }
        statusLabel.textColor = theme.text
        spinner.color = theme.text
        cancelButton.tintColor = theme.text.withAlphaComponent(0.55)
        meter.tintColor = .systemRed
        micBackground.backgroundColor = theme.functionalKey
        micButton.tintColor = theme.text
    }
}

final class LevelMeterView: UIView {
    var level: CGFloat = 0 { didSet { setNeedsLayout() } }
    private var bars: [UIView] = []
    private let shape: [CGFloat] = [0.5, 0.8, 1, 0.8, 0.5]

    override init(frame: CGRect) {
        super.init(frame: frame)
        bars = shape.map { _ in
            let bar = UIView()
            bar.layer.cornerRadius = 1.5
            addSubview(bar)
            return bar
        }
    }

    required init?(coder: NSCoder) { fatalError() }

    override func tintColorDidChange() {
        super.tintColorDidChange()
        bars.forEach { $0.backgroundColor = tintColor }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let barWidth: CGFloat = 3
        let gap = (bounds.width - barWidth * CGFloat(bars.count)) / CGFloat(bars.count - 1)
        for (index, bar) in bars.enumerated() {
            let height = max(3, bounds.height * min(1, level * 1.6) * shape[index])
            bar.backgroundColor = tintColor
            bar.frame = CGRect(x: CGFloat(index) * (barWidth + gap), y: (bounds.height - height) / 2, width: barWidth, height: height)
        }
    }
}
