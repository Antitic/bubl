import Foundation

/// Keyboard-side view of the dictation session running in the Murmure app.
final class DictationClient {
    enum Phase: Equatable {
        /// "Allow Full Access" is off: no shared container, no IPC.
        case noFullAccess
        /// The app is not running a mic session: the mic key has to open the app.
        case sessionOff
        case idle
        case recording(since: Date)
        case transcribing(message: String?)
    }

    private(set) var phase: Phase = .sessionOff
    private(set) var level: Float = 0

    var onChange: (() -> Void)?
    var onResult: ((String) -> Void)?

    private let hasFullAccess: () -> Bool
    private var tokens: [UUID] = []
    private var timer: Timer?
    /// Optimistic phase set right after sending a command, until the app confirms.
    private var pending: (phase: Phase, until: Date)?

    init(hasFullAccess: @escaping () -> Bool) {
        self.hasFullAccess = hasFullAccess
    }

    func activate() {
        guard tokens.isEmpty else { return }
        let notifier = DarwinNotifier.shared
        tokens.append(notifier.observe(.state) { [weak self] in self?.refresh() })
        tokens.append(notifier.observe(.result) { [weak self] in self?.consumeResult() })
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.refresh() }
        refresh()
        consumeResult()
    }

    func deactivate() {
        tokens.forEach(DarwinNotifier.shared.remove)
        tokens = []
        timer?.invalidate()
        timer = nil
    }

    func start() {
        DarwinNotifier.shared.post(.start)
        setPending(.recording(since: Date()))
    }

    func stop() {
        DarwinNotifier.shared.post(.stop)
        setPending(.transcribing(message: nil))
    }

    func cancel() {
        DarwinNotifier.shared.post(.cancel)
        setPending(.idle)
    }

    func refresh() {
        let newPhase: Phase
        var newLevel: Float = 0
        if !hasFullAccess() {
            newPhase = .noFullAccess
        } else if let state = SharedStore.readState(), state.isAlive {
            switch state.status {
            case .idle:
                newPhase = .idle
            case .recording:
                newPhase = .recording(since: state.recordingStartedAt ?? Date())
                newLevel = state.level
            case .transcribing:
                newPhase = .transcribing(message: state.modelReady ? nil : state.message)
            }
        } else {
            newPhase = .sessionOff
        }

        if let pending, Date() < pending.until, !confirms(newPhase, pending.phase) {
            // Keep the optimistic phase until the app answers (or the grace period ends).
        } else {
            pending = nil
            if newPhase != phase || newLevel != level {
                phase = newPhase
                level = newLevel
                onChange?()
            }
        }
    }

    // MARK: - Private

    private func setPending(_ phase: Phase) {
        pending = (phase, Date().addingTimeInterval(1.5))
        self.phase = phase
        level = 0
        onChange?()
    }

    private func confirms(_ actual: Phase, _ expected: Phase) -> Bool {
        switch (actual, expected) {
        case (.recording, .recording), (.transcribing, .transcribing), (.idle, .idle): return true
        // Stop on a very short/silent clip can go straight back to idle.
        case (.idle, .transcribing): return true
        default: return false
        }
    }

    private func consumeResult() {
        guard hasFullAccess(), let result = SharedStore.readResult() else { return }
        let defaults = MurmureShared.sharedDefaults
        guard defaults.string(forKey: SettingsKey.lastConsumedResultID) != result.id.uuidString,
              Date().timeIntervalSince(result.createdAt) < 30 else { return }
        defaults.set(result.id.uuidString, forKey: SettingsKey.lastConsumedResultID)
        onResult?(result.text)
    }
}
