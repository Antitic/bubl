import SwiftUI
import UIKit

struct ContentView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            Form {
                if model.launchedFromKeyboard, model.sessionActive {
                    returnBanner
                }
                dictationSection
                sessionSection
                modelSection
                languageSection
                keyboardSetupSection
            }
            .navigationTitle("Bubl")
            .alert("Oups", isPresented: Binding(
                get: { model.errorMessage != nil },
                set: { if !$0 { model.errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.errorMessage ?? "")
            }
        }
    }

    // MARK: - Sections

    private var returnBanner: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: model.recorderStatus == .recording ? "waveform" : "checkmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(model.recorderStatus == .recording ? .red : .green)
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.recorderStatus == .recording ? "Ça enregistre !" : "Session active")
                        .font(.headline)
                    Text("Reviens dans ton app avec « ◀︎ » en haut à gauche. Touche 🎤 sur le clavier pour arrêter.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private var dictationSection: some View {
        Section {
            VStack(spacing: 16) {
                Button(action: model.toggleRecording) {
                    ZStack {
                        Circle()
                            .fill(recordColor.gradient)
                            .frame(width: 88, height: 88)
                            .scaleEffect(model.recorderStatus == .recording ? 1 + CGFloat(model.level) * 0.35 : 1)
                            .animation(.easeOut(duration: 0.1), value: model.level)
                        if model.recorderStatus == .transcribing {
                            ProgressView().tint(.white).scaleEffect(1.4)
                        } else {
                            Image(systemName: model.recorderStatus == .recording ? "stop.fill" : "mic.fill")
                                .font(.system(size: 34, weight: .semibold))
                                .foregroundStyle(.white)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(model.recorderStatus == .transcribing)
                .frame(maxWidth: .infinity)

                Text(recordHint)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                if !model.lastTranscript.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(model.lastTranscript)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        HStack {
                            if let timing = model.lastTiming {
                                Text(timing).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button {
                                UIPasteboard.general.string = model.lastTranscript
                            } label: {
                                Label("Copier", systemImage: "doc.on.doc")
                            }
                            .font(.caption)
                        }
                    }
                    .padding(12)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                } else if let timing = model.lastTiming {
                    Text(timing).font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 8)
        } header: {
            Text("Tester la dictée")
        }
    }

    private var sessionSection: some View {
        Section {
            Toggle(isOn: Binding(get: { model.sessionActive }, set: { model.setSession(active: $0) })) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Session micro")
                    if let ends = model.sessionEndsAt {
                        Text("Active jusqu'à \(ends.formatted(date: .omitted, time: .shortened)) si inutilisée")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Picker("Durée d'inactivité", selection: $model.sessionMinutes) {
                ForEach([5, 15, 30, 60, 120], id: \.self) { minutes in
                    Text(minutes < 60 ? "\(minutes) min" : "\(minutes / 60) h").tag(minutes)
                }
            }
        } header: {
            Text("Session")
        } footer: {
            Text("Tant que la session est active, le bouton 🎤 du clavier démarre et arrête la dictée sans quitter ton app. iOS affiche alors le point orange du micro : rien n'est enregistré en dehors des dictées.")
        }
    }

    private var modelSection: some View {
        Section {
            Picker("Modèle", selection: $model.selectedModel) {
                ForEach(WhisperModelOption.allCases) { option in
                    VStack(alignment: .leading) {
                        Text(option.title + (model.isDownloaded(option) ? " ✓" : ""))
                        Text(option.subtitle).font(.caption).foregroundStyle(.secondary)
                    }
                    .tag(option)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()

            modelStatusRow
        } header: {
            Text("Modèle Whisper (100 % local)")
        } footer: {
            Text("Le premier chargement compile le modèle pour le Neural Engine : ça peut prendre 1 à 3 minutes, une seule fois.")
        }
    }

    @ViewBuilder
    private var modelStatusRow: some View {
        switch model.modelStatus {
        case .notDownloaded:
            Button {
                model.downloadSelectedModel()
            } label: {
                Label("Télécharger \(model.selectedModel.title)", systemImage: "arrow.down.circle")
            }
        case .downloading(let fraction):
            VStack(alignment: .leading) {
                Text("Téléchargement… \(Int(fraction * 100)) %")
                ProgressView(value: fraction)
            }
        case .downloaded:
            HStack {
                Button("Charger le modèle") { Task { try? await model.loadModel() } }
                Spacer()
                deleteButton
            }
        case .loading:
            HStack {
                ProgressView()
                Text("Préparation du modèle…").foregroundStyle(.secondary)
            }
        case .ready:
            HStack {
                Label("Prêt", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                Spacer()
                deleteButton
            }
        case .failed(let reason):
            VStack(alignment: .leading, spacing: 8) {
                Text(reason).font(.footnote).foregroundStyle(.red)
                Button("Réessayer") {
                    if model.isDownloaded(model.selectedModel) {
                        Task { try? await model.loadModel() }
                    } else {
                        model.downloadSelectedModel()
                    }
                }
            }
        }
    }

    private var deleteButton: some View {
        Button(role: .destructive) {
            model.deleteModel(model.selectedModel)
        } label: {
            Image(systemName: "trash")
        }
        .buttonStyle(.borderless)
    }

    private var languageSection: some View {
        Section {
            Picker("Langue de dictée", selection: $model.languageMode) {
                ForEach(LanguageMode.allCases) { Text($0.title).tag($0) }
            }
            Toggle("Retirer les « euh », « hum »…", isOn: $model.removeFillers)
            Toggle("Correction automatique (FR · EN · IT)", isOn: $model.autocorrect)
        } header: {
            Text("Langues")
        } footer: {
            Text("En mode Auto, Whisper choisit entre français, anglais et italien à chaque dictée. Choisir une langue fixe est un peu plus rapide.")
        }
    }

    private var keyboardSetupSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                step(1, "Réglages › Général › Clavier › Claviers › Ajouter un clavier… › Bubl")
                step(2, "Touche « Bubl » puis active « Autoriser l'accès complet » (nécessaire pour parler à l'app ; rien ne sort de ton iPhone).")
                step(3, "Dans n'importe quelle app, maintiens 🌐 et choisis Bubl.")
                step(4, "Touche 🎤 : la première fois, Bubl s'ouvre et démarre la session. Reviens avec « ◀︎ » et parle.")
            }
            .font(.subheadline)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Label("Ouvrir les Réglages", systemImage: "gear")
            }
        } header: {
            Text("Installer le clavier")
        }
    }

    // MARK: - Helpers

    private func step(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("\(number).").bold()
            Text(text)
        }
    }

    private var recordColor: Color {
        switch model.recorderStatus {
        case .idle: return .accentColor
        case .recording: return .red
        case .transcribing: return .orange
        }
    }

    private var recordHint: String {
        switch model.recorderStatus {
        case .idle: return "Touche pour parler, touche encore pour transcrire.\nLe texte est copié dans le presse-papiers."
        case .recording: return "J'écoute… touche pour arrêter."
        case .transcribing: return "Transcription en cours…"
        }
    }
}
