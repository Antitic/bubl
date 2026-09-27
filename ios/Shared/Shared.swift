import Foundation

/// Everything the app and the keyboard extension need to agree on.
enum MurmureShared {
    static let urlScheme = "murmure"
    static let baseAppGroup = "group.com.tikawski.murmure"

    /// SideStore / AltStore rewrite app-group identifiers when re-signing with a free
    /// Apple ID and list the real ones under `ALTAppGroups` in Info.plist, so resolve at runtime.
    static let appGroup: String = resolveAppGroup()

    static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    static let sharedDefaults: UserDefaults = UserDefaults(suiteName: appGroup) ?? .standard

    private static func resolveAppGroup() -> String {
        var candidates: [String] = []
        for info in [Bundle.main.infoDictionary, containingAppInfo()] {
            if let groups = info?["ALTAppGroups"] as? [String] { candidates += groups }
        }
        candidates.append(baseAppGroup)

        let fm = FileManager.default
        let ours = candidates.filter { $0.hasPrefix(baseAppGroup) }
        for id in ours + candidates where fm.containerURL(forSecurityApplicationGroupIdentifier: id) != nil {
            return id
        }
        return ours.first ?? baseAppGroup
    }

    /// When running inside the keyboard (.appex), the containing app lives two levels up.
    private static func containingAppInfo() -> [String: Any]? {
        let url = Bundle.main.bundleURL
        guard url.pathExtension == "appex" else { return nil }
        let appURL = url.deletingLastPathComponent().deletingLastPathComponent()
        return Bundle(url: appURL)?.infoDictionary
    }
}

// MARK: - Settings shared between app and keyboard

enum LanguageMode: String, CaseIterable, Identifiable {
    case auto, fr, en, it
    var id: String { rawValue }

    var title: String {
        switch self {
        case .auto: return "Auto (FR · EN · IT)"
        case .fr: return "Français"
        case .en: return "English"
        case .it: return "Italiano"
        }
    }

    /// Whisper language codes the transcription is allowed to pick from.
    var whisperLanguages: [String] {
        switch self {
        case .auto: return ["fr", "en", "it"]
        case .fr: return ["fr"]
        case .en: return ["en"]
        case .it: return ["it"]
        }
    }
}

enum SettingsKey {
    static let languageMode = "languageMode"
    static let removeFillers = "removeFillers"
    static let sessionMinutes = "sessionMinutes"
    static let selectedModel = "selectedModel"
    static let autocorrect = "autocorrect"
    static let lastConsumedResultID = "lastConsumedResultID"
}

// MARK: - IPC payloads

struct DictationState: Codable {
    enum Status: String, Codable {
        case idle, recording, transcribing
    }

    var sessionActive: Bool
    var status: Status
    var modelReady: Bool
    var heartbeat: Date
    var recordingStartedAt: Date?
    var level: Float
    var message: String?

    /// The app writes a heartbeat every second while a session is alive; if it stops, the app was suspended or killed.
    var isAlive: Bool {
        sessionActive && Date().timeIntervalSince(heartbeat) < 3
    }
}

struct DictationResult: Codable {
    var id: UUID
    var text: String
    var language: String?
    var createdAt: Date
}

enum SharedStore {
    private static let stateFile = "dictation-state.json"
    private static let resultFile = "dictation-result.json"

    static func writeState(_ state: DictationState) { write(state, to: stateFile) }
    static func readState() -> DictationState? { read(DictationState.self, from: stateFile) }
    static func writeResult(_ result: DictationResult) { write(result, to: resultFile) }
    static func readResult() -> DictationResult? { read(DictationResult.self, from: resultFile) }

    private static func write<T: Encodable>(_ value: T, to name: String) {
        guard let url = MurmureShared.containerURL?.appendingPathComponent(name),
              let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: url, options: .atomic)
    }

    private static func read<T: Decodable>(_ type: T.Type, from name: String) -> T? {
        guard let url = MurmureShared.containerURL?.appendingPathComponent(name),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

// MARK: - Darwin notifications (cross-process pings, no payload)

enum MurmureSignal: String, CaseIterable {
    case start = "com.tikawski.murmure.cmd.start"
    case stop = "com.tikawski.murmure.cmd.stop"
    case cancel = "com.tikawski.murmure.cmd.cancel"
    case state = "com.tikawski.murmure.state"
    case result = "com.tikawski.murmure.result"
}

final class DarwinNotifier {
    static let shared = DarwinNotifier()

    private var handlers: [String: [UUID: () -> Void]] = [:]
    private var registered = Set<String>()
    private let lock = NSLock()

    func post(_ signal: MurmureSignal) {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterPostNotification(center, CFNotificationName(signal.rawValue as CFString), nil, nil, true)
    }

    /// Handlers are always called on the main queue. Keep the returned token to stop observing.
    @discardableResult
    func observe(_ signal: MurmureSignal, handler: @escaping () -> Void) -> UUID {
        let token = UUID()
        lock.lock()
        handlers[signal.rawValue, default: [:]][token] = handler
        let needsRegistration = registered.insert(signal.rawValue).inserted
        lock.unlock()

        if needsRegistration {
            let callback: CFNotificationCallback = { _, observer, name, _, _ in
                guard let observer, let name else { return }
                let notifier = Unmanaged<DarwinNotifier>.fromOpaque(observer).takeUnretainedValue()
                notifier.fire(name.rawValue as String)
            }
            CFNotificationCenterAddObserver(
                CFNotificationCenterGetDarwinNotifyCenter(),
                Unmanaged.passUnretained(self).toOpaque(),
                callback,
                signal.rawValue as CFString,
                nil,
                .deliverImmediately
            )
        }
        return token
    }

    func remove(_ token: UUID) {
        lock.lock()
        for key in handlers.keys { handlers[key]?[token] = nil }
        lock.unlock()
    }

    private func fire(_ name: String) {
        lock.lock()
        let callbacks = Array((handlers[name] ?? [:]).values)
        lock.unlock()
        DispatchQueue.main.async { callbacks.forEach { $0() } }
    }
}
