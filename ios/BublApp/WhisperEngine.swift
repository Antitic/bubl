import CoreML
import Foundation
import WhisperKit

enum WhisperModelOption: String, CaseIterable, Identifiable {
    /// large-v3-turbo (2024-09-30), quantized to fit the A15 Neural Engine.
    case turbo = "openai_whisper-large-v3-v20240930_626MB"
    case small = "openai_whisper-small"
    case base = "openai_whisper-base"

    var id: String { rawValue }

    var title: String {
        switch self {
        case .turbo: return "Large v3 Turbo"
        case .small: return "Small"
        case .base: return "Base"
        }
    }

    var subtitle: String {
        switch self {
        case .turbo: return "≈ 630 Mo · meilleure qualité (recommandé)"
        case .small: return "≈ 480 Mo · bon compromis"
        case .base: return "≈ 145 Mo · ultra rapide, moins précis"
        }
    }
}

enum WhisperEngineError: LocalizedError {
    case notDownloaded
    case notLoaded

    var errorDescription: String? {
        switch self {
        case .notDownloaded: return "Le modèle n'est pas téléchargé."
        case .notLoaded: return "Le modèle n'est pas chargé."
        }
    }
}

/// Thin wrapper around WhisperKit: download, load (Neural Engine only, so it also works in the
/// background where the GPU is off-limits) and transcribe with a restricted language set.
final class WhisperEngine {
    private var kit: WhisperKit?
    private(set) var loadedModel: WhisperModelOption?

    private let downloadBase: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("WhisperModels", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableBase = base
        try? mutableBase.setResourceValues(values)
        return base
    }()

    private func pathKey(_ model: WhisperModelOption) -> String { "modelPath.\(model.rawValue)" }

    /// Folder paths are stored relative to `downloadBase`: the app container path changes between installs.
    func localFolder(for model: WhisperModelOption) -> URL? {
        guard let relative = UserDefaults.standard.string(forKey: pathKey(model)) else { return nil }
        let url = downloadBase.appendingPathComponent(relative, isDirectory: true)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func isDownloaded(_ model: WhisperModelOption) -> Bool { localFolder(for: model) != nil }

    func download(_ model: WhisperModelOption, progress: @escaping @Sendable (Double) -> Void) async throws {
        let folder = try await WhisperKit.download(
            variant: model.rawValue,
            downloadBase: downloadBase,
            progressCallback: { p in progress(p.fractionCompleted) }
        )
        let basePath = downloadBase.standardizedFileURL.path
        var relative = folder.standardizedFileURL.path
        if relative.hasPrefix(basePath) { relative.removeFirst(basePath.count) }
        while relative.hasPrefix("/") { relative.removeFirst() }
        UserDefaults.standard.set(relative, forKey: pathKey(model))
    }

    func delete(_ model: WhisperModelOption) async {
        if loadedModel == model { await unload() }
        if let folder = localFolder(for: model) { try? FileManager.default.removeItem(at: folder) }
        UserDefaults.standard.removeObject(forKey: pathKey(model))
    }

    func load(_ model: WhisperModelOption) async throws {
        if loadedModel == model, kit != nil { return }
        guard let folder = localFolder(for: model) else { throw WhisperEngineError.notDownloaded }
        await unload()

        let compute = ModelComputeOptions(
            melCompute: .cpuOnly,
            audioEncoderCompute: .cpuAndNeuralEngine,
            textDecoderCompute: .cpuAndNeuralEngine
        )
        let config = WhisperKitConfig(
            modelFolder: folder.path,
            computeOptions: compute,
            verbose: false,
            logLevel: .error,
            prewarm: false,
            load: true,
            download: false
        )
        kit = try await WhisperKit(config)
        loadedModel = model
    }

    func unload() async {
        await kit?.unloadModels()
        kit = nil
        loadedModel = nil
    }

    /// - Returns: The transcribed text and the language used.
    func transcribe(_ samples: [Float], languages: [String]) async throws -> (text: String, language: String?) {
        guard let kit else { throw WhisperEngineError.notLoaded }

        var language: String? = languages.count == 1 ? languages.first : nil
        if language == nil, kit.textDecoder.isModelMultilingual {
            // Whisper can pick any of ~100 languages; restrict the choice to the ones we speak.
            if let detection = try? await kit.detectLangauge(audioArray: samples) {
                language = languages.max { (detection.langProbs[$0] ?? -.infinity) < (detection.langProbs[$1] ?? -.infinity) }
            }
        }

        let options = DecodingOptions(
            task: .transcribe,
            language: language,
            temperature: 0,
            temperatureFallbackCount: 3,
            usePrefillPrompt: true,
            detectLanguage: language == nil,
            skipSpecialTokens: true,
            withoutTimestamps: true,
            chunkingStrategy: .vad
        )
        let results = try await kit.transcribe(audioArray: samples, decodeOptions: options)
        let text = results.map(\.text).joined(separator: " ")
        return (text, language ?? results.first?.language)
    }
}
