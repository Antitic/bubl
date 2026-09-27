import AVFoundation

/// Keeps the microphone open for the whole dictation session (so the app keeps running in the
/// background) and only accumulates 16 kHz mono samples between `beginCapture` and `endCapture`.
final class AudioRecorder {
    enum RecorderError: LocalizedError {
        case noInput
        var errorDescription: String? { "Aucun micro disponible." }
    }

    /// Called on the main queue with the RMS level (0...1) of the latest buffer while capturing.
    var onLevel: ((Float) -> Void)?
    /// Called on the main queue when the engine stopped on its own (interruption, route change that could not recover).
    var onEngineStopped: (() -> Void)?

    private let engine = AVAudioEngine()
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?

    private let lock = NSLock()
    private var capturing = false
    private var samples: [Float] = []
    private var lastLevelEmit = Date.distantPast

    private var observers: [NSObjectProtocol] = []

    var isRunning: Bool { engine.isRunning }

    init() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.restartAfterConfigurationChange()
        })
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    func startEngine() throws {
        guard !engine.isRunning else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .allowBluetooth, .defaultToSpeaker])
        try session.setActive(true)
        try installTapAndStart()
    }

    func stopEngine() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.lock()
        capturing = false
        samples = []
        lock.unlock()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func beginCapture() {
        lock.lock()
        samples.removeAll(keepingCapacity: true)
        capturing = true
        lock.unlock()
    }

    /// Returns the captured 16 kHz samples and stops accumulating.
    func endCapture() -> [Float] {
        lock.lock()
        capturing = false
        let captured = samples
        samples = []
        lock.unlock()
        return captured
    }

    var capturedDuration: TimeInterval {
        lock.lock()
        defer { lock.unlock() }
        return Double(samples.count) / targetFormat.sampleRate
    }

    // MARK: - Private

    private func installTapAndStart() throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { throw RecorderError.noInput }
        converter = AVAudioConverter(from: inputFormat, to: targetFormat)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            self?.handle(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    private func restartAfterConfigurationChange() {
        // Route changes (AirPods connected, etc.) stop the engine; try to resume with the new input format.
        guard !engine.isRunning else { return }
        do {
            try installTapAndStart()
        } catch {
            onEngineStopped?()
        }
    }

    private func handle(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        let isCapturing = capturing
        lock.unlock()
        guard isCapturing, let converter else { return }

        let ratio = targetFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return }

        var consumed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = output.floatChannelData?[0] else { return }
        let frames = Int(output.frameLength)
        let chunk = Array(UnsafeBufferPointer(start: channel, count: frames))

        lock.lock()
        if capturing { samples.append(contentsOf: chunk) }
        lock.unlock()

        let now = Date()
        if now.timeIntervalSince(lastLevelEmit) > 0.1, let onLevel {
            lastLevelEmit = now
            let level = Self.rms(chunk)
            DispatchQueue.main.async { onLevel(level) }
        }
    }

    static func rms(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sum: Float = 0
        for s in samples { sum += s * s }
        return min(1, sqrt(sum / Float(samples.count)) * 4)
    }

    /// Peak short-window loudness, used to skip Whisper on silent recordings (avoids hallucinations).
    static func peakLoudness(_ samples: [Float], window: Int = 800) -> Float {
        var peak: Float = 0
        var index = 0
        while index < samples.count {
            let end = min(index + window, samples.count)
            var sum: Float = 0
            for i in index..<end { sum += samples[i] * samples[i] }
            peak = max(peak, sqrt(sum / Float(end - index)))
            index = end
        }
        return peak
    }
}
