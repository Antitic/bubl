import AVFoundation
import SwiftUI
import UIKit

@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    enum ModelStatus: Equatable {
        case notDownloaded
        case downloading(Double)
        case downloaded
        case loading
        case ready
        case failed(String)
    }

    enum RecorderStatus: Equatable {
        case idle, recording, transcribing
    }

    // MARK: Published state

    @Published private(set) var modelStatus: ModelStatus = .notDownloaded
    @Published private(set) var recorderStatus: RecorderStatus = .idle
    @Published private(set) var sessionActive = false
    @Published private(set) var sessionEndsAt: Date?
    @Published private(set) var level: Float = 0
    @Published private(set) var lastTranscript = ""
    @Published private(set) var lastTiming: String?
    @Published var errorMessage: String?
    @Published var launchedFromKeyboard = false
    @Published private(set) var micAllowed = AVAudioApplication.shared.recordPermission == .granted

    // MARK: Settings (stored in the shared app group so the keyboard can read them)

    @Published var selectedModel: WhisperModelOption {
        didSet {
            guard selectedModel != oldValue else { return }
            defaults.set(selectedModel.rawValue, forKey: SettingsKey.selectedModel)
            loadTask = nil
            refreshModelStatus()
            if sessionActive, whisper.isDownloaded(selectedModel) { Task { try? await loadModel() } }
        }
    }

    @Published var languageMode: LanguageMode {
        didSet { defaults.set(languageMode.rawValue, forKey: SettingsKey.languageMode) }
    }

    @Published var removeFillers: Bool {
        didSet { defaults.set(removeFillers, forKey: SettingsKey.removeFillers) }
    }

    @Published var sessionMinutes: Int {
        didSet {
            defaults.set(sessionMinutes, forKey: SettingsKey.sessionMinutes)
            extendSession()
        }
    }

    @Published var autocorrect: Bool {
        didSet { defaults.set(autocorrect, forKey: SettingsKey.autocorrect) }
    }

    // MARK: Private

    private let defaults = MurmureShared.sharedDefaults
    private let recorder = AudioRecorder()
    private let whisper = WhisperEngine()
    private var heartbeat: Timer?
    private var recordingStartedAt: Date?
    private var loadTask: Task<Void, Error>?
    private var lastStatePublish = Date.distantPast
    private let maxRecordingSeconds: TimeInterval = 10 * 60

    private init() {
        let defaults = MurmureShared.sharedDefaults
        defaults.register(defaults: [
            SettingsKey.languageMode: LanguageMode.auto.rawValue,
            SettingsKey.removeFillers: true,
            SettingsKey.sessionMinutes: 15,
            SettingsKey.selectedModel: WhisperModelOption.turbo.rawValue,
            SettingsKey.autocorrect: true,
        ])
        selectedModel = WhisperModelOption(rawValue: defaults.string(forKey: SettingsKey.selectedModel) ?? "") ?? .turbo
        languageMode = LanguageMode(rawValue: defaults.string(forKey: SettingsKey.languageMode) ?? "") ?? .auto
        removeFillers = defaults.bool(forKey: SettingsKey.removeFillers)
        sessionMinutes = defaults.integer(forKey: SettingsKey.sessionMinutes)
        autocorrect = defaults.bool(forKey: SettingsKey.autocorrect)

        refreshModelStatus()

        recorder.onLevel = { [weak self] level in
            guard let self else { return }
            self.level = level
            self.publishState(throttled: true)
        }
        recorder.onEngineStopped = { [weak self] in
            self?.handleEngineLoss()
        }

        let notifier = DarwinNotifier.shared
        notifier.observe(.start) { [weak self] in self?.startRecording() }
        notifier.observe(.stop) { [weak self] in self?.stopRecording() }
        notifier.observe(.cancel) { [weak self] in self?.cancelRecording() }

        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
            Task { @MainActor in self?.handleEngineLoss() }
        }

        // A previous run may have left a "session active" state behind.
        publishState()
    }

    /// Sample state for screenshots (see DemoMode). Never touches the mic or the model.
    func applyDemoState() {
        modelStatus = .ready
        sessionActive = true
        sessionEndsAt = Date().addingTimeInterval(15 * 60)
        lastTranscript = "Rappel : appeler Giulia pour le resto de samedi, et acheter du pain en rentrant."
        lastTiming = "6.8 s d'audio → 1.12 s de calcul (fr)"
    }

    // MARK: - URL entry point (keyboard opens murmure://start)

    func handle(url: URL) {
        guard url.scheme == MurmureShared.urlScheme else { return }
        switch url.host {
        case "start":
            launchedFromKeyboard = true
            Task {
                await startSession()
                startRecording()
            }
        case "session":
            launchedFromKeyboard = true
            Task { await startSession() }
        default:
            break
        }
    }

    // MARK: - Session

    func setSession(active: Bool) {
        if active {
            Task { await startSession() }
        } else {
            endSession()
        }
    }

    func startSession() async {
        guard await requestMicPermission() else {
            errorMessage = "Autorise le micro dans Réglages › Murmure."
            return
        }
        do {
            try recorder.startEngine()
        } catch {
            errorMessage = "Impossible de démarrer le micro : \(error.localizedDescription)"
            return
        }
        if !sessionActive {
            sessionActive = true
            heartbeat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
        }
        extendSession()
        publishState()
        if whisper.isDownloaded(selectedModel) {
            loadTask = loadTask ?? Task { try await loadModel() }
        }
    }

    func endSession() {
        if recorderStatus == .recording { _ = recorder.endCapture() }
        recorder.stopEngine()
        heartbeat?.invalidate()
        heartbeat = nil
        sessionActive = false
        sessionEndsAt = nil
        if recorderStatus == .recording { recorderStatus = .idle }
        level = 0
        publishState()
    }

    private func extendSession() {
        guard sessionActive else { return }
        sessionEndsAt = Date().addingTimeInterval(TimeInterval(max(1, sessionMinutes) * 60))
    }

    private func tick() {
        guard sessionActive else { return }
        if recorderStatus == .recording, let started = recordingStartedAt,
           Date().timeIntervalSince(started) > maxRecordingSeconds {
            stopRecording()
        }
        if recorderStatus == .idle, let ends = sessionEndsAt, Date() > ends {
            endSession()
            return
        }
        publishState()
    }

    private func handleEngineLoss() {
        if recorderStatus == .recording { stopRecording() }
        guard sessionActive, !recorder.isRunning else { return }
        // In the background we are not allowed to restart the mic: end the session cleanly.
        endSession()
    }

    // MARK: - Recording

    /// In-app record button (the keyboard uses the Darwin signals instead).
    func toggleRecording() {
        launchedFromKeyboard = false
        switch recorderStatus {
        case .idle:
            Task {
                if !sessionActive { await startSession() }
                startRecording()
            }
        case .recording:
            stopRecording()
        case .transcribing:
            break
        }
    }

    func startRecording() {
        guard sessionActive, recorder.isRunning else {
            // The keyboard can only reach us while a session is alive; from inside the app, start one.
            if UIApplication.shared.applicationState == .active {
                Task {
                    await startSession()
                    if sessionActive { startRecording() }
                }
            }
            return
        }
        guard recorderStatus == .idle else { return }
        recorder.beginCapture()
        recordingStartedAt = Date()
        recorderStatus = .recording
        extendSession()
        publishState()
    }

    func cancelRecording() {
        guard recorderStatus == .recording else { return }
        _ = recorder.endCapture()
        recorderStatus = .idle
        recordingStartedAt = nil
        level = 0
        publishState()
    }

    func stopRecording() {
        guard recorderStatus == .recording else { return }
        let samples = recorder.endCapture()
        let started = recordingStartedAt ?? Date()
        recordingStartedAt = nil
        recorderStatus = .transcribing
        level = 0
        publishState()

        let backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "transcription")
        Task {
            defer { UIApplication.shared.endBackgroundTask(backgroundTask) }
            await transcribe(samples, recordedFor: Date().timeIntervalSince(started))
        }
    }

    private func transcribe(_ samples: [Float], recordedFor duration: TimeInterval) async {
        defer {
            recorderStatus = .idle
            extendSession()
            publishState()
        }

        let audioSeconds = Double(samples.count) / 16_000
        guard audioSeconds > 0.3, AudioRecorder.peakLoudness(samples) > 0.004 else {
            lastTiming = "Rien entendu (silence)."
            deliver("", language: nil)
            return
        }

        do {
            try await ensureModelLoaded()
            let start = Date()
            let output = try await whisper.transcribe(samples, languages: languageMode.whisperLanguages)
            let elapsed = Date().timeIntervalSince(start)
            let text = TextCleaner.clean(output.text, removeFillers: removeFillers)
            lastTiming = String(format: "%.1f s d'audio → %.2f s de calcul (%@)", audioSeconds, elapsed, output.language ?? "?")
            deliver(text, language: output.language)
        } catch {
            errorMessage = error.localizedDescription
            deliver("", language: nil)
        }
    }

    private func deliver(_ text: String, language: String?) {
        lastTranscript = text
        guard !text.isEmpty else { return }
        SharedStore.writeResult(DictationResult(id: UUID(), text: text, language: language, createdAt: Date()))
        DarwinNotifier.shared.post(.result)
        if UIApplication.shared.applicationState == .active, !launchedFromKeyboard {
            UIPasteboard.general.string = text
        }
    }

    // MARK: - Model management

    func refreshModelStatus() {
        if whisper.loadedModel == selectedModel {
            modelStatus = .ready
        } else if whisper.isDownloaded(selectedModel) {
            modelStatus = .downloaded
        } else {
            modelStatus = .notDownloaded
        }
    }

    func isDownloaded(_ model: WhisperModelOption) -> Bool { whisper.isDownloaded(model) }

    func downloadSelectedModel() {
        let model = selectedModel
        modelStatus = .downloading(0)
        Task {
            do {
                try await whisper.download(model) { fraction in
                    Task { @MainActor in
                        if case .downloading = AppModel.shared.modelStatus {
                            AppModel.shared.modelStatus = .downloading(fraction)
                        }
                    }
                }
                try await loadModel()
            } catch {
                modelStatus = .failed("Téléchargement impossible : \(error.localizedDescription)")
            }
        }
    }

    func deleteModel(_ model: WhisperModelOption) {
        Task {
            await whisper.delete(model)
            loadTask = nil
            refreshModelStatus()
            publishState()
        }
    }

    func loadModel() async throws {
        let model = selectedModel
        modelStatus = .loading
        publishState()
        do {
            try await whisper.load(model)
            modelStatus = .ready
        } catch {
            modelStatus = .failed("Chargement impossible : \(error.localizedDescription)")
            loadTask = nil
            throw error
        }
        publishState()
    }

    private func ensureModelLoaded() async throws {
        if whisper.loadedModel == selectedModel { return }
        if let loadTask {
            try await loadTask.value
            if whisper.loadedModel == selectedModel { return }
        }
        let task = Task { try await loadModel() }
        loadTask = task
        try await task.value
    }

    // MARK: - Permissions

    private func requestMicPermission() async -> Bool {
        let granted: Bool
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            granted = true
        case .denied:
            granted = false
        default:
            granted = await AVAudioApplication.requestRecordPermission()
        }
        micAllowed = granted
        return granted
    }

    // MARK: - IPC

    private func publishState(throttled: Bool = false) {
        let now = Date()
        if throttled, now.timeIntervalSince(lastStatePublish) < 0.12 { return }
        lastStatePublish = now

        let status: DictationState.Status
        switch recorderStatus {
        case .idle: status = .idle
        case .recording: status = .recording
        case .transcribing: status = .transcribing
        }
        let message: String?
        switch modelStatus {
        case .loading: message = "Chargement du modèle…"
        case .notDownloaded: message = "Modèle non téléchargé"
        case .failed(let reason): message = reason
        default: message = nil
        }
        let state = DictationState(
            sessionActive: sessionActive,
            status: status,
            modelReady: modelStatus == .ready,
            heartbeat: now,
            recordingStartedAt: recordingStartedAt,
            level: level,
            message: message
        )
        SharedStore.writeState(state)
        DarwinNotifier.shared.post(.state)
    }
}
