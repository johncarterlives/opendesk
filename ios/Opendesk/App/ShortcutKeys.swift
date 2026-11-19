import SwiftUI

/// The app's keyboard shortcuts with a hardware keyboard (`ShortcutRegistry`), on the person's own
/// keys: a key with a modifier answers anywhere, a key alone only while nothing is being typed, and
/// two keys pressed one after the other ("G then P") wait a moment for the second.
private struct ShortcutKeys: ViewModifier {
    @Environment(AppEnvironment.self) private var env
    @State private var pending: KeyStep?
    @State private var pendingEnds: Task<Void, Never>?
    @State private var textEditing = false
    @State private var keyboardShown = false
    @State private var showMenu = false
    @State private var showEditor = false
    @State private var showNewTicket = false
    @State private var showHelp = false
    @State private var helpSearch = ""

    private var store: ShortcutsStore { .shared }

    private enum Action: Hashable {
        case run(String)
        case prefix(KeyStep)
        case cancel
    }

    private struct Entry: Identifiable {
        var step: KeyStep
        var key: KeyEquivalent
        var title: String
        var action: Action
        var id: String { step.raw }
    }

    func body(content: Content) -> some View {
        content
            .background { keys }
            .onAppear { start() }
            .onChange(of: env.session.workspace?.id) { _, _ in start() }
            .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidBeginEditingNotification)) { _ in textEditing = true }
            .onReceive(NotificationCenter.default.publisher(for: UITextField.textDidEndEditingNotification)) { _ in textEditing = false }
            .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidBeginEditingNotification)) { _ in textEditing = true }
            .onReceive(NotificationCenter.default.publisher(for: UITextView.textDidEndEditingNotification)) { _ in textEditing = false }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboardShown = true }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboardShown = false }
            .sheet(isPresented: $showMenu) {
                ScopeSheet()
                    .presentationDetents([.medium, .large])
                    .presentationCornerRadius(Theme.Radius.sheet)
            }
            .sheet(isPresented: $showEditor) {
                SidebarEditorSheet()
                    .presentationDetents([.large])
                    .presentationCornerRadius(Theme.Radius.sheet)
                    .interactiveDismissDisabled()
            }
            .sheet(isPresented: $showNewTicket) {
                NewTicketSheet { ticket in
                    Task {
                        try? await Task.sleep(for: .milliseconds(350))
                        env.router.show(.tickets, [])
                        env.router.pick(.ticket(ticket))
                    }
                }
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
            }
            .sheet(isPresented: $showHelp) {
                NavigationStack {
                    ScrollView {
                        ShortcutsList(search: $helpSearch, commands: helpCommands)
                            .padding(16)
                    }
                    .background(Theme.chrome.ignoresSafeArea())
                    .navigationTitle("Keyboard shortcuts")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) { SheetButton(.confirm, "Done") { showHelp = false } }
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Change") {
                                showHelp = false
                                env.router.tab = .account
                                env.router.accountPath = [.shortcuts]
                            }
                        }
                    }
                }
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(Theme.Radius.sheet)
            }
    }

    private func start() {
        store.start(env: env)
        SidebarStore.shared.start(env: env)
    }

    private var helpCommands: [ShortcutCommand] {
        let text = helpSearch.trimmingCharacters(in: .whitespaces).lowercased()
        guard !text.isEmpty else { return ShortcutRegistry.commands }
        return ShortcutRegistry.commands.filter { $0.title.lowercased().contains(text) || $0.group.title.lowercased().contains(text) }
    }

    // MARK: Keys

    /// Invisible buttons that carry the keys: the system answers them like a menu's.
    private var keys: some View {
        ZStack {
            if !store.recording {
                ForEach(entries) { entry in
                    Button(entry.title) { fire(entry.action) }
                        .keyboardShortcut(entry.key, modifiers: entry.step.modifiers)
                }
            }
        }
        .frame(width: 0, height: 0)
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    /// The keys that answer now: first keys, or the second keys after a first one.
    private var entries: [Entry] {
        let typing = textEditing || keyboardShown
        var out: [Entry] = []
        var taken: Set<String> = []
        func add(_ step: KeyStep, _ title: String, _ action: Action) {
            guard !taken.contains(step.raw), let key = step.equivalent else { return }
            // A key alone would land in the text being typed.
            if typing, step.mods.isEmpty || step.mods == ["shift"] { return }
            taken.insert(step.raw)
            out.append(Entry(step: step, key: key, title: title, action: action))
        }
        for command in ShortcutRegistry.commands where available(command) {
            guard let binding = store.binding(command), let steps = ShortcutBinding.steps(binding) else { continue }
            if let pending {
                if steps.count == 2, steps[0] == pending { add(steps[1], command.title, .run(command.id)) }
            } else if steps.count == 1 {
                add(steps[0], command.title, .run(command.id))
            } else {
                add(steps[0], "Then", .prefix(steps[0]))
            }
        }
        if pending != nil, let escape = KeyStep("escape") { add(escape, "Cancel", .cancel) }
        return out
    }

    private func available(_ command: ShortcutCommand) -> Bool {
        // A page's own keys answer on the page alone (`WikiPageShortcutKeys`).
        if command.group == .page { return false }
        let products = env.products
        switch command.id {
        case "global.new", "go.mine", "go.team", "go.reports": return products.tickets
        case "go.mail": return products.mail && env.directory.collab.enabled
        case "global.ollie": return env.directory.ai.assistantOn
        case "go.pages", "go.graph": return products.pages
        default: return true
        }
    }

    private func fire(_ action: Action) {
        switch action {
        case let .prefix(step):
            pending = step
            pendingEnds?.cancel()
            pendingEnds = Task {
                try? await Task.sleep(for: .seconds(1.5))
                guard !Task.isCancelled else { return }
                pending = nil
            }
        case .cancel:
            clearPending()
        case let .run(id):
            clearPending()
            perform(id)
        }
    }

    private func clearPending() {
        pendingEnds?.cancel()
        pendingEnds = nil
        pending = nil
    }

    private func perform(_ id: String) {
        let router = env.router
        router.showOllie = false
        switch id {
        case "global.palette", "tickets.search":
            router.show(router.shownArea, [.search])
        case "global.help":
            helpSearch = ""
            showHelp = true
        case "global.ollie":
            router.showOllie = true
        case "global.new":
            showNewTicket = true
        case "global.back":
            switch router.tab {
            case .notifications: if !router.notificationsPath.isEmpty { router.notificationsPath.removeLast() }
            case .account: if !router.accountPath.isEmpty { router.accountPath.removeLast() }
            default: if !router.inboxPath.isEmpty { router.inboxPath.removeLast() }
            }
        case "go.inbox":
            env.inbox.setScope(.folder(.unassigned))
            router.show(.tickets, [])
        case "go.mine":
            env.inbox.setScope(.folder(.mine))
            router.show(.tickets, [])
        case "go.team":
            env.inbox.setScope(.team(InboxScope.myTeams, .unassigned))
            router.show(.tickets, [])
        case "go.mail":
            SpacesStore.shared.startMail(env: env)
            router.show(.mail, [])
        case "go.pages":
            router.show(.pages, [])
        case "go.graph":
            open("/pages/graph")
        case "go.wiki":
            router.show(.wiki, [])
        case "go.contacts":
            router.show(.contacts, [])
        case "go.kb":
            router.show(.kb, [])
        case "go.reports":
            router.show(.reports, [])
        case "go.settings":
            router.tab = .account
            router.accountPath = []
        case "go.shortcuts":
            router.tab = .account
            router.accountPath = [.shortcuts]
        case "sidebar.toggle":
            showMenu = true
        case "sidebar.edit":
            showEditor = true
        default:
            break
        }
    }

    private func open(_ path: String) {
        guard let link = DeepLink.parse(path: path) else { return }
        env.router.open(DeepLink.Target(link: link, server: nil, workspaceID: nil))
    }
}

extension View {
    /// The app's keyboard shortcuts, on the person's own keys.
    func shortcutKeys() -> some View { modifier(ShortcutKeys()) }
}
