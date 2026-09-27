import SwiftUI
import UIKit

/// Screenshot mode, driven by launch arguments (`-MurmureDemo home|keyboard|recording`).
/// Used by CI to capture the app and the real keyboard views in the simulator.
enum DemoMode: String {
    case home, keyboard, recording

    static var current: DemoMode? {
        UserDefaults.standard.string(forKey: "MurmureDemo").flatMap(DemoMode.init(rawValue:))
    }
}

struct DemoRootView: View {
    let mode: DemoMode

    var body: some View {
        switch mode {
        case .home:
            ContentView()
        case .keyboard:
            KeyboardDemoScreen(recording: false)
        case .recording:
            KeyboardDemoScreen(recording: true)
        }
    }
}

/// A fake notes screen with the actual keyboard views docked at the bottom.
struct KeyboardDemoScreen: View {
    let recording: Bool

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Notes", systemImage: "chevron.left").foregroundStyle(.orange)
                    Spacer()
                    Text("OK").bold().foregroundStyle(.orange)
                }
                .font(.body)
                Text("Courses & idées").font(.title.bold())
                Text(recording
                     ? "Rappel : appeler Giulia pour le resto de samedi."
                     : "Salut ! Je teste le clavier Murmure, il marche vraiment biem")
                    .font(.body)
                + Text("|").foregroundColor(.accentColor)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .frame(maxWidth: .infinity, alignment: .leading)

            KeyboardPreview(recording: recording)
                .frame(height: 46 + 6 + 54 * 4 + 4)
            Color(KeyboardTheme(isDark: recording).background)
                .frame(height: 34)
        }
        .background(Color(.systemBackground))
        .ignoresSafeArea(edges: .bottom)
    }
}

struct KeyboardPreview: UIViewRepresentable {
    let recording: Bool

    func makeUIView(context: Context) -> UIView {
        let theme = KeyboardTheme(isDark: recording)
        let container = UIView()
        container.backgroundColor = theme.background

        let topBar = TopBarView()
        let keyboard = KeyboardView()
        topBar.translatesAutoresizingMaskIntoConstraints = false
        keyboard.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(topBar)
        container.addSubview(keyboard)
        NSLayoutConstraint.activate([
            topBar.topAnchor.constraint(equalTo: container.topAnchor),
            topBar.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            topBar.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            topBar.heightAnchor.constraint(equalToConstant: 46),
            keyboard.topAnchor.constraint(equalTo: topBar.bottomAnchor),
            keyboard.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            keyboard.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            keyboard.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])

        topBar.theme = theme
        keyboard.theme = theme
        keyboard.setRows(KeyboardLayouts.rows(for: .letters, showGlobe: false), mode: .letters)
        keyboard.returnTitle = "retour"

        if recording {
            topBar.update(phase: .recording(since: Date().addingTimeInterval(-7)), level: 0.55)
        } else {
            topBar.update(phase: .idle, level: 0)
            topBar.setSuggestions([
                SpellEngine.Suggestion(text: "biem", kind: .literal),
                SpellEngine.Suggestion(text: "bien", kind: .correction, isAutocorrection: true),
                SpellEngine.Suggestion(text: "bientôt", kind: .completion),
            ])
        }
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {}
}
