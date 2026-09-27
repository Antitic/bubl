import SwiftUI

@main
struct MurmureApp: App {
    @StateObject private var model = AppModel.shared

    var body: some Scene {
        WindowGroup {
            if let demo = DemoMode.current {
                DemoRootView(mode: demo)
                    .environmentObject(model)
                    .onAppear { model.applyDemoState() }
            } else {
                ContentView()
                    .environmentObject(model)
                    .onOpenURL { model.handle(url: $0) }
            }
        }
    }
}
