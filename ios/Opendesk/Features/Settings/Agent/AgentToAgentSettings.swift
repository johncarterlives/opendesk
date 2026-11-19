import SwiftUI

/// Your settings > Agent-to-agent: whether teammates' assistants may ask yours about your own mail,
/// who may, which of your accounts it draws on and how, and the rules it follows. Every change is
/// saved at once (PUT /v1/me/assistant-peer), shown first and put back if the server refuses it.
struct AgentToAgentSettings: View {
    @Environment(AppEnvironment.self) private var env
    @State private var settings: PeerSettings?
    @State private var loaded = false
    @State private var failed = false
    @State private var saves = 0
    @State private var asks: [PeerAsk] = []
    @State private var asksCursor: String?
    @State private var asksLoaded = false
    @State private var loadingMore = false
    @State private var rules = ""
    @State private var picking = false
    @FocusState private var rulesFocused: Bool

    /// The page lists nothing of its own to open; a link to one lands on the page.
    struct Detail: View {
        let id: String

        var body: some View { AgentToAgentSettings() }
    }

    private var name: String { env.directory.ai.assistantName.flatMap { $0.isEmpty ? nil : $0 } ?? "Ollie" }

    var body: some View {
        AccountPage(title: "Agent-to-agent", spacing: 22) {
            AgentIntro(text: "Let teammates' \(name) ask yours about your mail when they need something only you can see.")
            if !loaded {
                Panel { SkeletonRows(count: 3) }
            } else if let settings {
                if !settings.available {
                    off
                } else {
                    main(settings)
                    people(settings)
                    accounts(settings)
                    rulesSection(settings)
                    asksSection
                }
            } else {
                Panel {
                    EmptyState(symbol: "person.2.slash", title: "Agent-to-agent is not available", message: failed ? nil : "An admin can allow it in Settings, AI.")
                }
            }
        }
        .sheet(isPresented: $picking) {
            if let settings {
                PeerAudiencePicker(settings: settings) { users, teams in
                    var next = settings
                    next.users = users
                    next.teams = teams
                    Task { await save(next) }
                }
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(Theme.Radius.sheet)
            }
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private var off: some View {
        Panel {
            EmptyState(
                title: "Your workspace has not turned this on",
                message: env.session.isAdmin ? "Allow it in Settings, AI, with \"Let teammates' \(name) ask each other\". Each member then chooses for their own mail." : "An admin can allow it in Settings, AI.",
                actionTitle: env.session.isAdmin ? "Open AI settings" : nil,
                action: env.session.isAdmin ? { env.router.accountPath.append(.setting(.ai)) } : nil
            ) {
                OllieMark(size: 28, state: .muted)
            }
        }
    }

    private func main(_ settings: PeerSettings) -> some View {
        Panel {
            HStack(alignment: .top, spacing: 12) {
                OllieMark(size: 22, state: settings.enabled ? .idle : .muted)
                    .frame(width: 32, height: 32)
                    .background(settings.enabled ? Tone.violet.soft : Theme.active, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                VStack(alignment: .leading, spacing: 3) {
                    Text("Let teammates' \(name) ask mine").font(ODFont.sans(15.5, weight: .medium)).foregroundStyle(Theme.fg)
                    Text("Your \(name) answers from your own mail accounts, following your rules. They get an answer, never your mail.")
                        .font(ODFont.footnote).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Toggle("Let teammates' \(name) ask mine", isOn: Binding(get: { settings.enabled }, set: { on in
                    var next = settings
                    next.enabled = on
                    Task { await save(next) }
                }))
                .labelsHidden()
                .tint(Tone.green.solid)
            }
            .padding(14)
            .sensoryFeedback(.selection, trigger: settings.enabled)
        }
    }

    private func people(_ settings: PeerSettings) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            AgentGroupTitle(title: "People", hint: "Who may ask your \(name). Changes apply to the next question.")
            Panel {
                AccountChoiceRow(symbol: "globe", tone: .teal, title: "Everyone", subtitle: "Every member of this workspace.", chosen: settings.shareWith != "chosen") {
                    var next = settings
                    next.shareWith = "everyone"
                    Task { await save(next) }
                }
                AccountDivider()
                AccountChoiceRow(symbol: "person.2", tone: .violet, title: "Chosen people and teams", subtitle: "Only the people and teams you pick.", chosen: settings.shareWith == "chosen") {
                    var next = settings
                    next.shareWith = "chosen"
                    Task { await save(next) }
                }
                if settings.shareWith == "chosen" {
                    AccountDivider()
                    VStack(alignment: .leading, spacing: 10) {
                        if settings.users.isEmpty && settings.teams.isEmpty {
                            Text("No one yet. Only you can ask.").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                        } else {
                            AgentFlow(spacing: 6) {
                                ForEach(settings.teams) { team in chip(team.name.isEmpty ? "Team" : team.name, symbol: "person.3") { remove(team: team.id, settings) } }
                                ForEach(settings.users) { user in chip(user.name.isEmpty ? user.email : user.name, symbol: "person") { remove(user: user.id, settings) } }
                            }
                        }
                        Button { picking = true } label: { Label("Choose people and teams", systemImage: "plus") }
                            .buttonStyle(ChipButtonStyle())
                    }
                    .padding(14)
                }
            }
            .motion(Motion.snappy, value: settings.shareWith)
        }
    }

    private func chip(_ text: String, symbol: String, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 10)).foregroundStyle(Theme.fg3)
            Text(text).font(ODFont.sans(13)).foregroundStyle(Theme.fg).lineLimit(1)
            Button(action: remove) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.fg3).frame(width: 18, height: 18)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(text)")
        }
        .padding(.leading, 9)
        .padding(.trailing, 4)
        .frame(height: 28)
        .background(Theme.sunken, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1))
    }

    private func remove(user id: String, _ settings: PeerSettings) {
        var next = settings
        next.users.removeAll { $0.id == id }
        Task { await save(next) }
    }

    private func remove(team id: String, _ settings: PeerSettings) {
        var next = settings
        next.teams.removeAll { $0.id == id }
        Task { await save(next) }
    }

    private func accounts(_ settings: PeerSettings) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            AgentGroupTitle(title: "Accounts", hint: "Which of your own mail accounts your \(name) may draw on. Mail others share with you is never used.")
            if settings.accounts.isEmpty {
                Panel {
                    EmptyState(symbol: "tray", title: "No mail accounts of your own", message: "Connect one in Mail accounts, then choose here what it may share.", actionTitle: "Connect an account") {
                        env.router.accountPath.append(.setting(.mailAccounts))
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Use information from").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2).padding(.horizontal, 4)
                    AccountSegmented(options: [true, false], selection: Binding(get: { settings.allAccounts }, set: { all in
                        var next = settings
                        next.allAccounts = all
                        next.remode()
                        Task { await save(next) }
                    }), label: { $0 ? "All accounts" : "Chosen accounts" })
                    Panel {
                        ForEach(Array(settings.accounts.enumerated()), id: \.element.id) { index, account in
                            if index > 0 { AccountDivider() }
                            AccountRow(symbol: account.provider == "gmail" || account.provider == "google" ? "envelope" : account.provider == "microsoft" ? "envelope.badge" : "tray", tone: .blue, title: account.name.isEmpty ? account.email : account.name, subtitle: account.name.isEmpty || account.name == account.email ? nil : account.email) {
                                modeMenu(account.mode, label: "What \(account.email) may share") { mode in
                                    var next = settings
                                    if let at = next.accounts.firstIndex(where: { $0.id == account.id }) {
                                        next.accounts[at].mode = mode
                                        next.accounts[at].chosen = true
                                    }
                                    Task { await save(next) }
                                }
                            }
                        }
                        if settings.allAccounts {
                            AccountDivider()
                            AccountRow(symbol: "plus.circle", tone: .gray, title: "New accounts", subtitle: "Accounts you connect later start with this.") {
                                modeMenu(settings.defaultMode, label: "New accounts") { mode in
                                    var next = settings
                                    next.defaultMode = mode
                                    next.remode()
                                    Task { await save(next) }
                                }
                            }
                        }
                    }
                    Text("Verbatim may quote your mail. Summaries only answers in its own words. Nothing leaves an account out.")
                        .font(ODFont.footnote).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 4)
                }
            }
        }
    }

    private func modeMenu(_ mode: String, label: String, pick: @escaping (String) -> Void) -> some View {
        Menu {
            ForEach(PeerSettings.modes, id: \.self) { option in
                Button {
                    guard option != mode else { return }
                    Haptics.selection()
                    pick(option)
                } label: {
                    if option == mode { Label(PeerSettings.modeTitle(option), systemImage: "checkmark") } else { Text(PeerSettings.modeTitle(option)) }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(PeerSettings.modeTitle(mode)).font(ODFont.sans(13.5, weight: .medium)).foregroundStyle(mode == "none" ? Theme.fg3 : Theme.fg)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.fg3)
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        }
        .accessibilityLabel(label)
    }

    private func rulesSection(_ settings: PeerSettings) -> some View {
        let suggestion = "Share dates, decisions and next steps. Never share prices, contracts, personal matters or anything marked confidential."
        return VStack(alignment: .leading, spacing: 8) {
            AgentGroupTitle(title: "Sharing rules", hint: "Your \(name) follows these when it answers. It also uses common sense and keeps private matters private.")
            VStack(alignment: .leading, spacing: 6) {
                TextField(text: $rules, axis: .vertical) { Text(suggestion).foregroundStyle(Theme.fg4) }
                    .font(ODFont.sans(15))
                    .lineLimit(3 ... 12)
                    .focused($rulesFocused)
                    .padding(13)
                    .frame(minHeight: 100, alignment: .topLeading)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(rules.count > PeerSettings.rulesMax ? Tone.red.solid.opacity(0.6) : rulesFocused ? Theme.lineStrong : Theme.line, lineWidth: rulesFocused ? 1.5 : 1))
                    .onChange(of: rulesFocused) { _, focused in
                        if !focused { commitRules(rules, settings) }
                    }
                HStack {
                    if AgentText.trimmed(rules) != suggestion {
                        Button("Use a suggestion") {
                            rules = suggestion
                            commitRules(suggestion, settings)
                        }
                        .buttonStyle(ChipButtonStyle(tone: .violet))
                    }
                    Spacer()
                    if rules.count > PeerSettings.rulesMax * 3 / 4 { AgentCounter(count: rules.count, max: PeerSettings.rulesMax) }
                }
            }
        }
        .toolbar {
            if rulesFocused {
                ToolbarItem(placement: .keyboard) {
                    HStack { Spacer(); Button("Done") { rulesFocused = false }.fontWeight(.semibold) }
                }
            }
        }
    }

    private func commitRules(_ text: String, _ settings: PeerSettings) {
        let value = AgentText.trimmed(text)
        guard value != AgentText.trimmed(settings.rules), text.count <= PeerSettings.rulesMax else { return }
        var next = settings
        next.rules = value
        Task { await save(next) }
    }

    private var asksSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            AgentGroupTitle(title: "Recent asks", hint: "Questions teammates asked your \(name), and what it answered. Kept for 90 days.")
            Panel {
                if !asksLoaded {
                    SkeletonRows(count: 2)
                } else if asks.isEmpty {
                    EmptyState(symbol: "bubble.left.and.text.bubble.right", title: "No one has asked yet", message: "When a teammate's \(name) asks yours, the question and the answer show up here.")
                } else {
                    ForEach(Array(asks.enumerated()), id: \.element.id) { index, ask in
                        if index > 0 { Hairline(inset: 14) }
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 8) {
                                Avatar(name: ask.asker.name.isEmpty ? ask.asker.email : ask.asker.name, url: ask.asker.avatarURL, seed: ask.asker.id, size: 22)
                                Text(ask.asker.name.isEmpty ? ask.asker.email : ask.asker.name).font(ODFont.sans(13.5, weight: .medium)).foregroundStyle(Theme.fg).lineLimit(1)
                                Spacer()
                                Text(Format.relShort(ask.createdAt)).font(ODFont.sans(12)).foregroundStyle(Theme.fg4)
                            }
                            Text(ask.question).font(ODFont.sans(14.5)).foregroundStyle(Theme.fg).fixedSize(horizontal: false, vertical: true)
                            if !ask.answer.isEmpty {
                                Text(ask.answer).font(ODFont.footnote).foregroundStyle(Theme.fg2).lineLimit(4)
                            }
                            TonePill(text: ask.resultTitle, tone: ask.resultTone, height: 18)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                    }
                    if asksCursor != nil {
                        Hairline()
                        Button { Task { await loadAsks(more: true) } } label: {
                            ButtonLabel(title: "Show more", busy: loadingMore)
                                .font(ODFont.sans(14, weight: .medium))
                                .foregroundStyle(Theme.fg2)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: Data

    private func load() async {
        guard let api = env.agent.api else { return }
        do {
            let fresh: PeerSettings = try await api.get("v1/me/assistant-peer")
            settings = fresh
            if !rulesFocused { rules = fresh.rules }
            failed = false
        } catch {
            if !error.isCancellation, settings == nil { failed = true }
        }
        loaded = true
        if settings?.available == true { await loadAsks(more: false) }
    }

    private func loadAsks(more: Bool) async {
        guard let api = env.agent.api else { return }
        if more && (asksCursor == nil || loadingMore) { return }
        loadingMore = more
        defer { loadingMore = false }
        var query = [URLQueryItem(name: "limit", value: "20")]
        if more, let asksCursor { query.append(URLQueryItem(name: "cursor", value: asksCursor)) }
        if let page: Page<PeerAsk> = try? await api.get("v1/me/assistant-peer/asks", query: query) {
            asks = more ? asks + page.data : page.data
            asksCursor = page.nextCursor.flatMap { $0.isEmpty ? nil : $0 }
        }
        asksLoaded = true
    }

    /// Shows `next` at once and PUTs it; a later change still in flight wins.
    private func save(_ next: PeerSettings) async {
        guard let api = env.agent.api, let before = settings else { return }
        withAnimation(Motion.snappy) { settings = next }
        saves += 1
        let mine = saves
        do {
            let answer: PeerSettings = try await api.send(APIRequest(method: "PUT", path: "v1/me/assistant-peer", body: try APICoding.encoder.encode(next.input)))
            if mine == saves {
                settings = answer
                if !rulesFocused { rules = answer.rules }
            }
        } catch {
            if mine == saves {
                settings = before
                rules = before.rules
            }
            env.toasts.show("Could not save your agent-to-agent settings.", kind: .error)
            Haptics.error()
        }
    }
}

/// Picks the people and teams who may ask.
private struct PeerAudiencePicker: View {
    let settings: PeerSettings
    let done: (_ users: [PeerPerson], _ teams: [PeerSettings.TeamRef]) -> Void

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var users: Set<String> = []
    @State private var teams: Set<String> = []
    @State private var query = ""
    @State private var started = false

    var body: some View {
        let me = env.session.user?.id
        let text = query.lowercased()
        let members = env.directory.members.filter { $0.id != me && (text.isEmpty || $0.user.name.lowercased().contains(text) || ($0.user.email ?? "").lowercased().contains(text)) }
        let allTeams = env.directory.teams.filter { text.isEmpty || $0.name.lowercased().contains(text) }
        NavigationStack {
            List {
                if !allTeams.isEmpty {
                    Section("Teams") {
                        ForEach(allTeams) { team in
                            row(title: team.name, subtitle: nil, chosen: teams.contains(team.id)) {
                                if teams.contains(team.id) { teams.remove(team.id) } else { teams.insert(team.id) }
                            } leading: {
                                AccountIconTile(symbol: "person.3", tone: .violet, size: 28)
                            }
                        }
                    }
                }
                Section("People") {
                    ForEach(members) { member in
                        row(title: member.user.name, subtitle: member.user.email, chosen: users.contains(member.id)) {
                            if users.contains(member.id) { users.remove(member.id) } else { users.insert(member.id) }
                        } leading: {
                            Avatar(name: member.user.name, url: member.user.avatarURL, seed: member.id, size: 28)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.chrome)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search people and teams")
            .accountTitle("Who may ask")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(.confirm, "Done") {
                        let known = Dictionary(uniqueKeysWithValues: settings.users.map { ($0.id, $0) })
                        let pickedUsers = users.sorted().map { id -> PeerPerson in
                            if let member = env.directory.member(id) {
                                return PeerPerson(id: id, name: member.user.name, email: member.user.email ?? "", avatarURL: member.user.avatarURL)
                            }
                            return known[id] ?? PeerPerson(id: id, name: "", email: "")
                        }
                        let teamNames = Dictionary(uniqueKeysWithValues: settings.teams.map { ($0.id, $0.name) })
                        let pickedTeams = teams.sorted().map { id in PeerSettings.TeamRef(id: id, name: env.directory.team(id)?.name ?? teamNames[id] ?? "") }
                        done(pickedUsers, pickedTeams)
                        dismiss()
                    }
                    .fontWeight(.semibold)
                }
            }
        }
        .onAppear {
            guard !started else { return }
            started = true
            users = Set(settings.users.map(\.id))
            teams = Set(settings.teams.map(\.id))
        }
    }

    private func row<Leading: View>(title: String, subtitle: String?, chosen: Bool, toggle: @escaping () -> Void, @ViewBuilder leading: () -> Leading) -> some View {
        Button {
            Haptics.selection()
            toggle()
        } label: {
            HStack(spacing: 12) {
                leading()
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(ODFont.sans(15)).foregroundStyle(Theme.fg)
                    if let subtitle { Text(subtitle).font(ODFont.footnote).foregroundStyle(Theme.fg3) }
                }
                Spacer()
                Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 19))
                    .foregroundStyle(chosen ? Theme.fg : Theme.fg4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(Theme.surface)
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}
