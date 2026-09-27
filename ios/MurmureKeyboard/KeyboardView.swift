import UIKit

protocol KeyboardViewDelegate: AnyObject {
    /// Character keys, space, return, mode switches, globe. Characters already carry shift casing.
    func keyboardView(_ view: KeyboardView, didActivate action: KeyAction)
    /// Called on touch down and on every auto-repeat tick.
    func keyboardViewDidPressBackspace(_ view: KeyboardView)
    func keyboardViewDidPressShift(_ view: KeyboardView)
    func keyboardView(_ view: KeyboardView, moveCursorBy offset: Int)
}

struct KeyboardTheme {
    let isDark: Bool

    var background: UIColor { isDark ? UIColor(white: 0.09, alpha: 1) : UIColor(red: 0.82, green: 0.83, blue: 0.86, alpha: 1) }
    var characterKey: UIColor { isDark ? UIColor(white: 0.42, alpha: 1) : .white }
    var functionalKey: UIColor { isDark ? UIColor(white: 0.26, alpha: 1) : UIColor(red: 0.67, green: 0.69, blue: 0.73, alpha: 1) }
    var pressedCharacterKey: UIColor { isDark ? UIColor(white: 0.26, alpha: 1) : UIColor(red: 0.67, green: 0.69, blue: 0.73, alpha: 1) }
    var pressedFunctionalKey: UIColor { isDark ? UIColor(white: 0.42, alpha: 1) : .white }
    var text: UIColor { isDark ? .white : .black }
    var shadow: UIColor { isDark ? UIColor(white: 0, alpha: 0.6) : UIColor(red: 0.53, green: 0.54, blue: 0.56, alpha: 1) }
    var popup: UIColor { isDark ? UIColor(white: 0.42, alpha: 1) : .white }
}

// MARK: - Key view

final class KeyView: UIView {
    let def: KeyDef
    let label = UILabel()
    let icon = UIImageView()
    private let background = UIView()

    var isPressed = false { didSet { updateColors() } }
    var isHighlightedAction = false { didSet { updateColors() } }
    var theme = KeyboardTheme(isDark: false) { didSet { updateColors() } }

    init(def: KeyDef) {
        self.def = def
        super.init(frame: .zero)
        isUserInteractionEnabled = false

        background.layer.cornerRadius = 5
        background.layer.shadowOffset = CGSize(width: 0, height: 1)
        background.layer.shadowOpacity = 1
        background.layer.shadowRadius = 0
        addSubview(background)

        label.textAlignment = .center
        label.adjustsFontSizeToFitWidth = true
        label.minimumScaleFactor = 0.6
        addSubview(label)

        icon.contentMode = .center
        addSubview(icon)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        background.frame = bounds
        background.layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: 5).cgPath
        label.frame = bounds.insetBy(dx: 2, dy: 0)
        icon.frame = bounds
    }

    func updateColors() {
        let base: UIColor
        if isHighlightedAction {
            base = isPressed ? theme.functionalKey : .systemBlue
        } else if def.isFunctional {
            base = isPressed ? theme.pressedFunctionalKey : theme.functionalKey
        } else {
            base = isPressed ? theme.pressedCharacterKey : theme.characterKey
        }
        background.backgroundColor = base
        background.layer.shadowColor = theme.shadow.cgColor
        let foreground: UIColor = isHighlightedAction && !isPressed ? .white : theme.text
        label.textColor = foreground
        icon.tintColor = foreground
    }
}

// MARK: - Keyboard view

final class KeyboardView: UIView, UIInputViewAudioFeedback {
    weak var delegate: KeyboardViewDelegate?

    var rowHeight: CGFloat = 54 { didSet { setNeedsLayout() } }
    var topPadding: CGFloat = 6

    var theme = KeyboardTheme(isDark: false) {
        didSet { keyViews.forEach { $0.theme = theme } }
    }

    var shiftState: ShiftState = .off { didSet { refreshLabels() } }
    var returnTitle = "retour" { didSet { refreshLabels() } }
    var returnIsHighlighted = false { didSet { refreshLabels() } }

    private(set) var mode: KeyboardMode = .letters
    private var rows: [[KeyDef]] = []
    private var keyViews: [KeyView] = []
    private var rowOfKey: [ObjectIdentifier: Int] = [:]

    private let preview = KeyPreviewView()
    private let callout = VariantCalloutView()

    // Touch tracking
    private final class TouchInfo {
        var key: KeyView
        var longPressTimer: Timer?
        var repeatTimer: Timer?
        var showingVariants = false
        var cursorMode = false
        var lastCursorX: CGFloat
        let startPoint: CGPoint
        init(key: KeyView, point: CGPoint) {
            self.key = key
            startPoint = point
            lastCursorX = point.x
        }
        func invalidate() {
            longPressTimer?.invalidate()
            repeatTimer?.invalidate()
        }
    }

    private var touches: [UITouch: TouchInfo] = [:]

    var enableInputClicksWhenVisible: Bool { true }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isMultipleTouchEnabled = true
        clipsToBounds = false
        preview.isHidden = true
        callout.isHidden = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func setRows(_ rows: [[KeyDef]], mode: KeyboardMode) {
        cancelAllTouches()
        self.rows = rows
        self.mode = mode
        keyViews.forEach { $0.removeFromSuperview() }
        keyViews = []
        rowOfKey = [:]
        for (rowIndex, row) in rows.enumerated() {
            for def in row {
                let view = KeyView(def: def)
                view.theme = theme
                addSubview(view)
                keyViews.append(view)
                rowOfKey[ObjectIdentifier(view)] = rowIndex
            }
        }
        addSubview(preview)
        addSubview(callout)
        refreshLabels()
        setNeedsLayout()
    }

    // MARK: Layout

    private let sideMargin: CGFloat = 3
    private let spacing: CGFloat = 6

    private var unitWidth: CGFloat {
        (bounds.width - 2 * sideMargin - 9 * spacing) / 10
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let unit = unitWidth
        let keyHeight = rowHeight - 11
        var index = 0
        for (r, row) in rows.enumerated() {
            var fixed: CGFloat = 0
            var flexCount: CGFloat = 0
            for def in row {
                switch def.width {
                case .units(let u): fixed += u * unit
                case .flex: flexCount += 1
                }
            }
            let gaps = spacing * CGFloat(max(0, row.count - 1))
            let available = bounds.width - 2 * sideMargin - gaps
            let flexWidth = flexCount > 0 ? max(unit, (available - fixed) / flexCount) : 0
            let rowWidth = fixed + flexWidth * flexCount + gaps
            var x = flexCount > 0 ? sideMargin : (bounds.width - rowWidth) / 2
            let y = topPadding + CGFloat(r) * rowHeight + (rowHeight - keyHeight) / 2
            for def in row {
                let width: CGFloat
                switch def.width {
                case .units(let u): width = u * unit
                case .flex: width = flexWidth
                }
                keyViews[index].frame = CGRect(x: x, y: y, width: width, height: keyHeight).integral
                x += width + spacing
                index += 1
            }
        }
        refreshLabels()
    }

    var preferredHeight: CGFloat { topPadding + CGFloat(rows.count) * rowHeight + 4 }

    // MARK: Labels

    private func refreshLabels() {
        let fontSize: CGFloat = rowHeight < 48 ? 20 : 23
        let uppercase = mode == .letters && shiftState != .off
        for view in keyViews {
            view.label.text = nil
            view.icon.image = nil
            view.isHighlightedAction = false
            let symbolConfig = UIImage.SymbolConfiguration(pointSize: 17, weight: .regular)
            switch view.def.action {
            case .insert(let text):
                view.label.font = .systemFont(ofSize: fontSize, weight: .regular)
                view.label.text = uppercase ? text.uppercased() : text
            case .shift:
                let name: String
                switch shiftState {
                case .off: name = "shift"
                case .once: name = "shift.fill"
                case .locked: name = "capslock.fill"
                }
                view.icon.image = UIImage(systemName: name, withConfiguration: symbolConfig)
                view.isPressed = shiftState != .off
            case .backspace:
                view.icon.image = UIImage(systemName: "delete.left", withConfiguration: symbolConfig)
            case .nextKeyboard:
                view.icon.image = UIImage(systemName: "globe", withConfiguration: symbolConfig)
            case .space:
                view.label.font = .systemFont(ofSize: 16)
                view.label.text = "espace"
            case .returnKey:
                view.label.font = .systemFont(ofSize: 16)
                view.label.text = returnTitle
                view.isHighlightedAction = returnIsHighlighted
            case .mode(let target):
                view.label.font = .systemFont(ofSize: 16)
                switch target {
                case .letters: view.label.text = "ABC"
                case .numbers: view.label.text = "123"
                case .symbols: view.label.text = "#+="
                }
            }
        }
    }

    // MARK: Hit testing

    private func key(at point: CGPoint) -> KeyView? {
        guard !rows.isEmpty else { return nil }
        let rowIndex = min(max(Int((point.y - topPadding) / rowHeight), 0), rows.count - 1)
        var best: KeyView?
        var bestDistance = CGFloat.greatestFiniteMagnitude
        for view in keyViews where rowOfKey[ObjectIdentifier(view)] == rowIndex {
            let frame = view.frame
            let dx = point.x < frame.minX ? frame.minX - point.x : (point.x > frame.maxX ? point.x - frame.maxX : 0)
            if dx < bestDistance {
                bestDistance = dx
                best = view
            }
        }
        return best
    }

    // MARK: Touches

    override func touchesBegan(_ newTouches: Set<UITouch>, with event: UIEvent?) {
        for touch in newTouches {
            let point = touch.location(in: self)
            guard let key = key(at: point) else { continue }

            // Rolling typing: a new press commits any character still held down.
            for (other, info) in touches where info.key.def.isCharacter && !info.showingVariants {
                commit(info)
                release(info)
                touches[other] = nil
            }

            let info = TouchInfo(key: key, point: point)
            touches[touch] = info
            press(info)
        }
    }

    override func touchesMoved(_ movedTouches: Set<UITouch>, with event: UIEvent?) {
        for touch in movedTouches {
            guard let info = touches[touch] else { continue }
            let point = touch.location(in: self)

            if info.showingVariants {
                callout.select(atX: convert(point, to: callout).x)
                continue
            }

            switch info.key.def.action {
            case .space:
                if !info.cursorMode, abs(point.x - info.startPoint.x) > 14 {
                    enterCursorMode(info)
                }
                if info.cursorMode {
                    let step: CGFloat = 9
                    let delta = point.x - info.lastCursorX
                    if abs(delta) >= step {
                        let offset = Int(delta / step)
                        info.lastCursorX += CGFloat(offset) * step
                        delegate?.keyboardView(self, moveCursorBy: offset)
                    }
                }
            case .insert:
                // Sliding onto a neighbour key retargets the press, like the system keyboard.
                if let newKey = key(at: point), newKey !== info.key, newKey.def.isCharacter {
                    info.longPressTimer?.invalidate()
                    info.key.isPressed = false
                    info.key = newKey
                    press(info, playFeedback: false)
                }
            default:
                break
            }
        }
    }

    override func touchesEnded(_ endedTouches: Set<UITouch>, with event: UIEvent?) {
        for touch in endedTouches {
            guard let info = touches.removeValue(forKey: touch) else { continue }
            commit(info)
            release(info)
        }
    }

    override func touchesCancelled(_ cancelledTouches: Set<UITouch>, with event: UIEvent?) {
        for touch in cancelledTouches {
            guard let info = touches.removeValue(forKey: touch) else { continue }
            release(info)
        }
    }

    private func cancelAllTouches() {
        touches.values.forEach(release)
        touches = [:]
    }

    private func press(_ info: TouchInfo, playFeedback: Bool = true) {
        let key = info.key
        if playFeedback { UIDevice.current.playInputClick() }

        switch key.def.action {
        case .insert:
            key.isPressed = true
            showPreview(for: key)
            if !key.def.variants.isEmpty {
                info.longPressTimer = Timer.scheduledTimer(withTimeInterval: 0.38, repeats: false) { [weak self, weak info] _ in
                    guard let self, let info else { return }
                    self.showVariants(info)
                }
            }
        case .backspace:
            key.isPressed = true
            delegate?.keyboardViewDidPressBackspace(self)
            info.longPressTimer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: false) { [weak self, weak info] _ in
                guard let self, let info else { return }
                var ticks = 0
                info.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
                    guard let self else { return }
                    ticks += 1
                    // Speed up after a second of holding.
                    let count = ticks > 12 ? 2 : 1
                    for _ in 0..<count { self.delegate?.keyboardViewDidPressBackspace(self) }
                }
            }
        case .shift:
            delegate?.keyboardViewDidPressShift(self)
        case .space:
            key.isPressed = true
            info.longPressTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self, weak info] _ in
                guard let self, let info else { return }
                self.enterCursorMode(info)
            }
        default:
            key.isPressed = true
        }
    }

    private func commit(_ info: TouchInfo) {
        let key = info.key
        if info.showingVariants {
            if let variant = callout.selectedVariant {
                delegate?.keyboardView(self, didActivate: .insert(cased(variant)))
            }
            return
        }
        switch key.def.action {
        case .insert(let text):
            delegate?.keyboardView(self, didActivate: .insert(cased(text)))
        case .space:
            if !info.cursorMode { delegate?.keyboardView(self, didActivate: .space) }
        case .returnKey, .nextKeyboard, .mode:
            delegate?.keyboardView(self, didActivate: key.def.action)
        case .backspace, .shift:
            break
        }
    }

    private func release(_ info: TouchInfo) {
        info.invalidate()
        if info.key.def.action != .shift { info.key.isPressed = false }
        if info.cursorMode { info.key.label.text = "espace" }
        preview.isHidden = true
        if info.showingVariants { callout.isHidden = true }
    }

    private func cased(_ text: String) -> String {
        mode == .letters && shiftState != .off ? text.uppercased() : text
    }

    private func enterCursorMode(_ info: TouchInfo) {
        guard !info.cursorMode else { return }
        info.cursorMode = true
        info.longPressTimer?.invalidate()
        info.key.label.text = ""
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    // MARK: Popups

    private func showPreview(for key: KeyView) {
        guard case .insert(let text) = key.def.action else { return }
        let width = key.frame.width + 14
        let height = key.frame.height * 1.05
        preview.frame = CGRect(x: key.frame.midX - width / 2, y: key.frame.minY - height - 4, width: width, height: height)
        preview.configure(text: cased(text), theme: theme)
        preview.isHidden = false
        bringSubviewToFront(preview)
    }

    private func showVariants(_ info: TouchInfo) {
        let key = info.key
        guard !key.def.variants.isEmpty else { return }
        info.showingVariants = true
        preview.isHidden = true
        let cellWidth = max(unitWidth, 30)
        let variants = key.def.variants.map(cased)
        let width = cellWidth * CGFloat(variants.count) + 8
        var x = key.frame.minX - 4
        x = min(max(sideMargin, x), bounds.width - width - sideMargin)
        let height = key.frame.height + 8
        callout.frame = CGRect(x: x, y: key.frame.minY - height - 6, width: width, height: height)
        callout.configure(variants: variants, cellWidth: cellWidth, theme: theme)
        callout.isHidden = false
        bringSubviewToFront(callout)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

// MARK: - Popup views

final class KeyPreviewView: UIView {
    private let label = UILabel()

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.cornerRadius = 8
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.3
        layer.shadowRadius = 3
        layer.shadowOffset = CGSize(width: 0, height: 1)
        label.textAlignment = .center
        label.font = .systemFont(ofSize: 32)
        addSubview(label)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = bounds
    }

    func configure(text: String, theme: KeyboardTheme) {
        label.text = text
        label.textColor = theme.text
        backgroundColor = theme.popup
    }
}

final class VariantCalloutView: UIView {
    private var labels: [UILabel] = []
    private var variants: [String] = []
    private var cellWidth: CGFloat = 30
    private var theme = KeyboardTheme(isDark: false)
    private(set) var selectedIndex = 0

    var selectedVariant: String? { variants.indices.contains(selectedIndex) ? variants[selectedIndex] : nil }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        layer.cornerRadius = 8
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.3
        layer.shadowRadius = 4
        layer.shadowOffset = CGSize(width: 0, height: 1)
    }

    required init?(coder: NSCoder) { fatalError() }

    func configure(variants: [String], cellWidth: CGFloat, theme: KeyboardTheme) {
        labels.forEach { $0.removeFromSuperview() }
        self.variants = variants
        self.cellWidth = cellWidth
        self.theme = theme
        backgroundColor = theme.popup
        labels = variants.enumerated().map { index, text in
            let label = UILabel(frame: CGRect(x: 4 + CGFloat(index) * cellWidth, y: 4, width: cellWidth, height: bounds.height - 8))
            label.text = text
            label.textAlignment = .center
            label.font = .systemFont(ofSize: 24)
            label.layer.cornerRadius = 6
            label.layer.masksToBounds = true
            addSubview(label)
            return label
        }
        selectedIndex = 0
        updateSelection()
    }

    func select(atX x: CGFloat) {
        let index = min(max(Int((x - 4) / cellWidth), 0), variants.count - 1)
        guard index != selectedIndex else { return }
        selectedIndex = index
        updateSelection()
    }

    private func updateSelection() {
        for (index, label) in labels.enumerated() {
            let selected = index == selectedIndex
            label.backgroundColor = selected ? .systemBlue : .clear
            label.textColor = selected ? .white : theme.text
        }
    }
}
