import UIKit

enum KeyboardMode {
    case letters, numbers, symbols
}

enum ShiftState {
    case off, once, locked
}

enum KeyAction: Equatable {
    case insert(String)
    case shift
    case backspace
    case space
    case returnKey
    case nextKeyboard
    case mode(KeyboardMode)
}

enum KeyWidth {
    /// Multiple of a letter key width.
    case units(CGFloat)
    /// Shares the remaining row width with the other flexible keys.
    case flex
}

struct KeyDef {
    let action: KeyAction
    let width: KeyWidth
    let variants: [String]

    init(_ action: KeyAction, width: KeyWidth = .units(1), variants: [String] = []) {
        self.action = action
        self.width = width
        self.variants = variants
    }

    var isCharacter: Bool {
        if case .insert = action { return true }
        return false
    }

    /// Grey "function" keys, as opposed to white character keys and the space bar.
    var isFunctional: Bool {
        switch action {
        case .insert, .space: return false
        default: return true
        }
    }
}

enum KeyboardLayouts {
    /// Long-press alternatives, most frequent first (French and Italian accents come first).
    static let variants: [String: [String]] = [
        "e": ["é", "è", "ê", "ë", "ē", "ę"],
        "a": ["à", "â", "æ", "á", "ä", "ã", "å"],
        "c": ["ç", "ć", "č"],
        "u": ["ù", "û", "ü", "ú", "ū"],
        "i": ["î", "ï", "ì", "í"],
        "o": ["ô", "œ", "ò", "ó", "ö", "õ", "ø"],
        "y": ["ÿ", "ý"],
        "n": ["ñ", "ń"],
        "s": ["ß", "ś", "š"],
        "z": ["ž", "ź", "ż"],
        "'": ["’", "\"", "«", "»"],
        "0": ["°"],
        "-": ["–", "—", "•"],
        "/": ["\\"],
        "€": ["$", "£", "¥", "₩", "₽"],
        "&": ["§"],
        ".": ["…"],
        "?": ["¿"],
        "!": ["¡"],
        "\"": ["«", "»", "“", "”", "„"],
        "%": ["‰"],
    ]

    static func rows(for mode: KeyboardMode, showGlobe: Bool) -> [[KeyDef]] {
        switch mode {
        case .letters:
            return [
                chars("azertyuiop"),
                chars("qsdfghjklm"),
                [KeyDef(.shift, width: .flex)] + chars("wxcvbn'") + [KeyDef(.backspace, width: .flex)],
                bottomRow(modeKey: .numbers, showGlobe: showGlobe),
            ]
        case .numbers:
            return [
                chars("1234567890"),
                strings(["-", "/", ":", ";", "(", ")", "€", "&", "@", "\""]),
                [KeyDef(.mode(.symbols), width: .flex)] + strings([".", ",", "?", "!", "'"], width: 1.4) + [KeyDef(.backspace, width: .flex)],
                bottomRow(modeKey: .letters, showGlobe: showGlobe),
            ]
        case .symbols:
            return [
                strings(["[", "]", "{", "}", "#", "%", "^", "*", "+", "="]),
                strings(["_", "\\", "|", "~", "<", ">", "$", "£", "¥", "•"]),
                [KeyDef(.mode(.numbers), width: .flex)] + strings([".", ",", "?", "!", "'"], width: 1.4) + [KeyDef(.backspace, width: .flex)],
                bottomRow(modeKey: .letters, showGlobe: showGlobe),
            ]
        }
    }

    private static func chars(_ string: String) -> [KeyDef] {
        strings(string.map(String.init))
    }

    private static func strings(_ values: [String], width: CGFloat = 1) -> [KeyDef] {
        values.map { KeyDef(.insert($0), width: .units(width), variants: variants[$0] ?? []) }
    }

    private static func bottomRow(modeKey: KeyboardMode, showGlobe: Bool) -> [KeyDef] {
        var row = [KeyDef(.mode(modeKey), width: .units(showGlobe ? 1.25 : 2.5))]
        if showGlobe { row.append(KeyDef(.nextKeyboard, width: .units(1.25))) }
        row.append(KeyDef(.space, width: .flex))
        row.append(KeyDef(.returnKey, width: .units(2.5)))
        return row
    }
}
