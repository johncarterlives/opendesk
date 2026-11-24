import SwiftUI

/// Settings › Inbox categories (contracts/collab.md "Categories"): admins set the workspace's
/// default and teams' own sets; everyone else sees what applies to them and opens their accounts.
struct MailCategoriesSettings: View {
    @Environment(AppEnvironment.self) private var env
    @State private var store = MailCategoriesStore()

    var body: some View {
        AccountPage(title: "Inbox categories") {
            Text("Split inboxes into tabs like Primary, Updates and Newsletters. New mail is sorted as it arrives, and nothing leaves the inbox.")
                .font(ODFont.callout)
                .foregroundStyle(Theme.fg3)
                .padding(.horizontal, 4)
            ChannelLoading(loaded: store.loaded, error: store.settings == nil ? store.error : nil, retry: reload) {
                if let settings = store.settings {
                    if env.session.isAdmin {
                        MailCategoriesWorkspaceCard(store: store, settings: settings)
                        MailCategoriesTeamsCard(store: store, settings: settings)
                        privacy
                    } else {
                        MailCategoriesMemberView(store: store, settings: settings)
                    }
                }
            }
        }
        .refreshable { await store.load(accounts: !env.session.isAdmin) }
        .onAppear {
            store.attach(env.session.api)
            reload()
        }
    }

    private var privacy: some View {
        Notice(text: "Admins choose the categories, never see anyone's mail or how it was sorted. Everyone can turn off Ollie's sorting for their own accounts.", symbol: "checkmark.shield")
    }

    private func reload() { Task { await store.load(accounts: !env.session.isAdmin) } }

    struct Detail: View {
        let id: String
        var body: some View { MailCategoriesSettings() }
    }
}

// MARK: - Workspace default

private struct MailCategoriesWorkspaceCard: View {
    let store: MailCategoriesStore
    let settings: MailCategorySettings

    @Environment(AppEnvironment.self) private var env
    @State private var draft: Draft?
    @State private var base: Draft?
    @State private var saving = false
    @State private var confirm: AccountConfirm?

    struct Draft: Equatable {
        var enabled: Bool
        var categories: [MailCategory]
        var locked: Bool
    }

    var body: some View {
        Group {
            if let draft {
                AccountSection(title: "Workspace default", footer: "Everyone's accounts follow these, unless their team has its own or they choose their own.") {
                    AccountToggleRow(title: "Split inboxes into categories", subtitle: draft.enabled ? "New mail is sorted into these tabs as it arrives." : "Inboxes stay one list. Members who may choose their own can still split theirs.", isOn: binding(\.enabled))
                    if draft.enabled {
                        AccountDivider(tiles: false)
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Categories").font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg)
                            ChannelHint("Primary always comes first. Each description tells Ollie what belongs there.")
                            MailCategoryEditor(categories: binding(\.categories), presets: settings.presets, suggest: settings.suggest, api: store.api)
                        }
                        .padding(14)
                    }
                    AccountDivider(tiles: false)
                    AccountToggleRow(title: "Members choose their own", subtitle: draft.locked ? "Everyone follows the workspace or their team. Members can still turn off Ollie's sorting for their accounts." : "Members can pick their own categories, or none, for the accounts they manage.", isOn: Binding(get: { !draft.locked }, set: { self.draft?.locked = !$0 }))
                    AccountDivider(tiles: false)
                    MailCategoriesSortingRow(sorting: settings.sorting)
                    AccountDivider(tiles: false)
                    footer(draft)
                }
            } else {
                AccountSection(title: "Workspace default") {
                    VStack(spacing: 14) {
                        EmptyState(
                            symbol: "tray.2",
                            title: "Split everyone's inbox",
                            message: "Set categories once for the whole workspace, like Gmail's tabs: mail from people stays in Primary, and updates, newsletters and promotions get tabs of their own.",
                            actionTitle: "Turn on categories",
                            action: { self.draft = Draft(enabled: true, categories: MailCategoryKit.defaults(settings.presets), locked: false) }
                        )
                        MailCategoryPills(categories: MailCategoryKit.defaults(settings.presets))
                        HStack(spacing: 14) {
                            Label("Teams can have their own", systemImage: "person.2")
                            Label("Admins never see anyone's mail", systemImage: "lock")
                        }
                        .font(ODFont.sans(12))
                        .foregroundStyle(Theme.fg3)
                    }
                    .padding(.vertical, 18)
                    .padding(.horizontal, 12)
                }
            }
        }
        .accountConfirm($confirm)
        .onAppear(perform: sync)
        .onChange(of: settings) { sync() }
    }

    /// The saved set replaces the form while it is not being edited.
    private func sync() {
        let next = settings.workspace.map { Draft(enabled: $0.enabled, categories: $0.enabled ? $0.categories : MailCategoryKit.defaults(settings.presets), locked: $0.locked) }
        if draft == base { draft = next }
        base = next
    }

    private func binding<T>(_ path: WritableKeyPath<Draft, T>) -> Binding<T> {
        Binding(get: { draft![keyPath: path] }, set: { draft?[keyPath: path] = $0 })
    }

    @ViewBuilder
    private func footer(_ draft: Draft) -> some View {
        let dirty = draft != base
        let problem = draft.enabled ? MailCategoryKit.problem(draft.categories) : nil
        VStack(alignment: .leading, spacing: 10) {
            if dirty, let problem {
                FormError(text: problem)
            } else if !dirty, let ws = settings.workspace, let at = ws.updatedAt {
                Text(MailCategoryKit.updated(at, by: ws.updatedBy)).font(ODFont.sans(12)).foregroundStyle(Theme.fg4)
            }
            HStack(spacing: 8) {
                if settings.workspace != nil, !dirty {
                    Button("Remove default") {
                        confirm = AccountConfirm(title: "Remove the workspace default?", message: "Accounts that follow the workspace go back to one inbox. Whoever manages one is offered a guided set-up instead.", confirmTitle: "Remove default") {
                            do {
                                try await store.removeWorkspace()
                                self.draft = nil
                                base = nil
                                env.toasts.show("Workspace default removed", kind: .success)
                            } catch { env.toasts.error(error) }
                        }
                    }
                    .buttonStyle(ChipButtonStyle())
                }
                Spacer()
                if dirty {
                    Button("Discard") { self.draft = base }.buttonStyle(ChipButtonStyle())
                }
                Button { save(draft) } label: { ButtonLabel(title: "Save", busy: saving) }
                    .buttonStyle(InkButtonStyle())
                    .frame(width: 96)
                    .disabled(!dirty || problem != nil || saving)
            }
        }
        .padding(14)
    }

    private func save(_ draft: Draft) {
        saving = true
        Task {
            do {
                try await store.setWorkspace(enabled: draft.enabled, categories: draft.categories, locked: draft.locked)
                let next = store.settings?.workspace.map { Draft(enabled: $0.enabled, categories: $0.enabled ? $0.categories : MailCategoryKit.defaults(settings.presets), locked: $0.locked) }
                self.draft = next
                base = next
                Haptics.success()
                env.toasts.show("Categories saved. Mail is being sorted again.", kind: .success)
            } catch {
                Haptics.error()
                env.toasts.show("Could not save the categories. \(error.userMessage)", kind: .error)
            }
            saving = false
        }
    }
}

private struct MailCategoriesSortingRow: View {
    let sorting: String

    var body: some View {
        AccountRow(title: "How mail is sorted", subtitle: sorting == "ai" ? "Ollie sorts new mail as it arrives, by each category's description. Mail Ollie is unsure of stays in Primary." : "Sorted by sender rules and mail headers. Turn on AI to let Ollie sort.") {
            TonePill(text: sorting == "ai" ? "Ollie" : "Rules and headers", tone: sorting == "ai" ? .violet : .gray)
        }
    }
}

// MARK: - Teams

private struct MailCategoriesTeamsCard: View {
    let store: MailCategoriesStore
    let settings: MailCategorySettings

    @Environment(AppEnvironment.self) private var env
    @State private var editing: MailTeamCategoriesEditor.Target?

    var body: some View {
        let free = env.directory.teams.filter { team in !settings.teams.contains { $0.teamID == team.id } }
        AccountSection(title: "Teams", footer: settings.teams.count > 1 ? "Someone in several teams gets the first team's categories. Use Move up and Move down to change the order." : "A team can have its own categories, which its members' accounts follow instead of the workspace's.") {
            if settings.teams.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("No team has its own categories").font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg)
                    Text("Every team follows the workspace default.").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
            } else {
                ForEach(Array(settings.teams.enumerated()), id: \.element.teamID) { index, set in
                    if index > 0 { AccountDivider(tiles: false) }
                    Button { editing = .init(teamSet: set, isNew: false) } label: { row(set) }
                        .buttonStyle(RowPressStyle())
                        .contextMenu {
                            if index > 0 { Button("Move up", systemImage: "arrow.up") { move(set, by: -1) } }
                            if index < settings.teams.count - 1 { Button("Move down", systemImage: "arrow.down") { move(set, by: 1) } }
                        }
                }
            }
            AccountDivider(tiles: false)
            Menu {
                ForEach(free) { team in
                    Button(team.name) { add(team) }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus").font(.system(size: 13, weight: .semibold))
                    Text(free.isEmpty ? "Every team has its own" : "Add a team").font(ODFont.sans(15, weight: .medium))
                    Spacer()
                }
                .foregroundStyle(free.isEmpty ? Theme.fg4 : Theme.fg)
                .padding(14)
                .contentShape(Rectangle())
            }
            .disabled(free.isEmpty)
        }
        .sheet(item: $editing) { target in
            MailTeamCategoriesEditor(store: store, settings: settings, target: target)
        }
    }

    private func row(_ set: MailCategorySet) -> some View {
        let name = env.directory.team(set.teamID ?? "")?.name ?? set.teamName
        return HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 6) {
                Text(name).font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg)
                if set.enabled {
                    MailCategoryPills(categories: set.categories)
                } else {
                    Text("Off: inboxes stay one list").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                }
            }
            Spacer(minLength: 6)
            Chevron().padding(.top, 4)
        }
        .padding(14)
        .contentShape(Rectangle())
    }

    private func add(_ team: Team) {
        let start = settings.workspace.flatMap { $0.enabled && !$0.categories.isEmpty ? $0.categories : nil } ?? MailCategoryKit.defaults(settings.presets)
        editing = .init(teamSet: MailCategorySet(teamID: team.id, teamName: team.name, categories: start), isNew: true)
    }

    private func move(_ set: MailCategorySet, by offset: Int) {
        var ids = settings.teams.compactMap(\.teamID)
        guard let id = set.teamID, let from = ids.firstIndex(of: id) else { return }
        let to = from + offset
        guard ids.indices.contains(to) else { return }
        ids.swapAt(from, to)
        Haptics.selection()
        Task {
            do { try await store.orderTeams(ids) } catch { env.toasts.show("Could not change the order", kind: .error) }
        }
    }
}

/// One team's own set, in a sheet: on or off, its categories, or back to following the workspace.
private struct MailTeamCategoriesEditor: View {
    struct Target: Identifiable {
        var teamSet: MailCategorySet
        var isNew: Bool
        var id: String { teamSet.teamID ?? "" }
    }

    let store: MailCategoriesStore
    let settings: MailCategorySettings
    let target: Target

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var enabled = true
    @State private var categories: [MailCategory] = []
    @State private var saving = false
    @State private var confirm: AccountConfirm?

    private var name: String { env.directory.team(target.id)?.name ?? target.teamSet.teamName }

    var body: some View {
        let problem = enabled ? MailCategoryKit.problem(categories) : nil
        ChannelSheet(title: name, subtitle: target.isNew ? "New team categories" : nil) {
            AccountToggleRow(title: "Split \(name)'s inboxes", subtitle: enabled ? "New mail is sorted into these tabs as it arrives." : "This team's inboxes stay one list, whatever the workspace sets.", isOn: $enabled)
            if enabled {
                MailCategoryEditor(categories: $categories, presets: settings.presets, suggest: settings.suggest, api: store.api)
            }
            if let problem { FormError(text: problem) }
            Button(action: save) { ButtonLabel(title: "Save", busy: saving) }
                .buttonStyle(InkButtonStyle())
                .disabled(saving || problem != nil || (!target.isNew && enabled == target.teamSet.enabled && categories == target.teamSet.categories))
            Button(target.isNew ? "Cancel" : "Follow the workspace") {
                if target.isNew { dismiss() } else {
                    confirm = AccountConfirm(title: "Should \(name) follow the workspace?", message: "Its members' accounts follow the workspace default again.", confirmTitle: "Follow the workspace", destructive: false) {
                        do {
                            try await store.removeTeam(target.id)
                            env.toasts.show("\(name) follows the workspace", kind: .success)
                            dismiss()
                        } catch { env.toasts.error(error) }
                    }
                }
            }
            .buttonStyle(OutlineButtonStyle())
        }
        .accountConfirm($confirm)
        .onAppear {
            enabled = target.teamSet.enabled
            categories = target.teamSet.enabled || !target.teamSet.categories.isEmpty ? target.teamSet.categories : MailCategoryKit.defaults(settings.presets)
        }
    }

    private func save() {
        saving = true
        Task {
            do {
                try await store.setTeam(target.id, enabled: enabled, categories: categories)
                Haptics.success()
                env.toasts.show("\(name)'s categories saved", kind: .success)
                dismiss()
            } catch {
                Haptics.error()
                env.toasts.show("Could not save the categories. \(error.userMessage)", kind: .error)
            }
            saving = false
        }
    }
}

// MARK: - Members

private struct MailCategoriesMemberView: View {
    let store: MailCategoriesStore
    let settings: MailCategorySettings

    var body: some View {
        let ws = settings.workspace
        if ws == nil, settings.teams.isEmpty {
            EmptyState(symbol: "tray.2", title: "No categories yet", message: "Your workspace has not set inbox categories. You can split your own inbox from each account's settings.")
                .padding(.top, 20)
        } else {
            AccountSection(title: "What your workspace set", footer: ws?.locked == true ? "Your admins set categories for everyone. You can still turn off Ollie's sorting for your accounts." : "You can choose your own for each account you manage.") {
                setRow("Workspace default", ws.flatMap { set -> [MailCategory]? in set.enabled ? set.categories : nil }, none: ws == nil ? "No default" : "Off")
                ForEach(settings.teams, id: \.teamID) { set in
                    AccountDivider(tiles: false)
                    setRow(set.teamName, set.enabled ? set.categories : nil, none: "Off")
                }
            }
        }
        if !store.accounts.isEmpty {
            AccountSection(title: "Your mail accounts", footer: "Change an account's categories and sender rules in its settings.") {
                ForEach(Array(store.accounts.enumerated()), id: \.element.id) { index, account in
                    if index > 0 { AccountDivider(tiles: false) }
                    SettingsDetailLink(page: .mailAccounts, id: account.id) {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Circle().fill(account.tone.solid).frame(width: 7, height: 7)
                                Text(account.label).font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg).lineLimit(1)
                                Spacer()
                                Chevron()
                            }
                            if account.inboxCategories.isEmpty {
                                Text("Not split").font(ODFont.footnote).foregroundStyle(Theme.fg4)
                            } else {
                                MailCategoryPills(categories: account.inboxCategories)
                            }
                        }
                        .padding(14)
                        .contentShape(Rectangle())
                    }
                }
            }
        }
        Notice(text: "Admins choose the categories, never see anyone's mail or how it was sorted. Everyone can turn off Ollie's sorting for their own accounts.", symbol: "checkmark.shield")
    }

    private func setRow(_ title: String, _ categories: [MailCategory]?, none: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg)
            if let categories { MailCategoryPills(categories: categories) } else { Text(none).font(ODFont.footnote).foregroundStyle(Theme.fg3) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
    }
}

// MARK: - Editor

/// Categories as soft pills: a dot and a name each.
struct MailCategoryPills: View {
    let categories: [MailCategory]

    var body: some View {
        FlowLayout(spacing: 5) {
            ForEach(categories) { category in
                TonePill(text: category.name, tone: category.tone, height: 21) {
                    Circle().fill(category.tone.solid).frame(width: 6, height: 6)
                }
            }
        }
    }
}

/// A set of 2 to 10 categories, Primary first: names, descriptions for Ollie, colours and order.
struct MailCategoryEditor: View {
    @Binding var categories: [MailCategory]
    var presets: [MailCategory] = []
    var suggest = false
    var accountID: String?
    var disabled = false
    let api: APIClient?

    @Environment(AppEnvironment.self) private var env
    @State private var asking = false
    @State private var about = ""
    @State private var thinking = false
    @State private var undo: [MailCategory]?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(categories.enumerated()), id: \.element.key) { index, category in
                row(index, category)
            }
            if !disabled { controls }
        }
        .disabled(disabled)
    }

    private func row(_ index: Int, _ category: MailCategory) -> some View {
        let key = category.key
        let primary = index == 0
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Menu {
                    ForEach(MailCategoryKit.tones, id: \.self) { tone in
                        Button(tone.capitalized) { update(key) { $0.color = tone } }
                    }
                } label: {
                    Circle().fill(category.tone.solid).frame(width: 14, height: 14)
                        .frame(width: 30, height: 30)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Colour of \(category.name.isEmpty ? "Untitled" : category.name)")
                TextField(text: Binding(get: { category.name }, set: { value in update(key) { $0.name = String(value.prefix(40)) } })) {
                    Text(primary ? "Primary" : "Category name").foregroundStyle(Theme.fg4)
                }
                .font(ODFont.sans(15, weight: .medium))
                .foregroundStyle(Theme.fg)
                if primary {
                    Image(systemName: "pin.fill").font(.system(size: 10)).foregroundStyle(Theme.fg4)
                } else {
                    Menu {
                        if index > 1 { Button("Move up", systemImage: "arrow.up") { move(index, by: -1) } }
                        if index < categories.count - 1 { Button("Move down", systemImage: "arrow.down") { move(index, by: 1) } }
                        Button("Remove \(category.name.isEmpty ? "Untitled" : category.name)", systemImage: "trash", role: .destructive) {
                            categories.removeAll { $0.key == key }
                            Haptics.tap()
                        }
                    } label: {
                        Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.fg3).frame(width: 30, height: 30).contentShape(Rectangle())
                    }
                }
            }
            TextField(text: Binding(get: { category.description }, set: { value in update(key) { $0.description = String(value.prefix(300)) } }), axis: .vertical) {
                Text(primary ? "Mail from people, and anything that fits nowhere else" : "What belongs here, for Ollie").foregroundStyle(Theme.fg4)
            }
            .font(ODFont.sans(13.5))
            .foregroundStyle(Theme.fg2)
            .lineLimit(1 ... 3)
            .padding(.leading, 38)
            if primary {
                Text("Primary is always first: mail from people, and anything Ollie is unsure of")
                    .font(ODFont.sans(11.5)).foregroundStyle(Theme.fg4).padding(.leading, 38)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 8)
        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
    }

    @ViewBuilder
    private var controls: some View {
        let used = Set(categories.map(\.key))
        let names = Set(categories.map { $0.name.lowercased() })
        let offered = presets.filter { !$0.isPrimary && !used.contains($0.key) && !names.contains($0.name.lowercased()) }
        let full = categories.count >= MailCategoryKit.maximum
        HStack {
            Button {
                let colours = Set(categories.map(\.color))
                let color = MailCategoryKit.newTones.first { !colours.contains($0) } ?? "gray"
                categories.append(MailCategory(key: MailCategoryKit.draftKey(), name: "", description: "", color: color))
                Haptics.tap()
            } label: {
                Label("Add category", systemImage: "plus").font(ODFont.sans(14, weight: .medium))
            }
            .disabled(full)
            Spacer()
            Text("\(categories.count) of \(MailCategoryKit.maximum)").font(ODFont.mono(12)).foregroundStyle(Theme.fg3)
        }
        .foregroundStyle(Theme.fg)
        if !offered.isEmpty, !full {
            FlowLayout(spacing: 6) {
                ForEach(offered) { preset in
                    Button {
                        categories.append(preset)
                        Haptics.tap()
                    } label: {
                        Label(preset.name, systemImage: "plus")
                    }
                    .buttonStyle(ChipButtonStyle())
                }
            }
        }
        if suggest, env.directory.ai.enabled {
            if asking {
                VStack(alignment: .leading, spacing: 8) {
                    ODTextField(label: "What is this inbox for?", text: $about, prompt: "For example: sales for a design studio, with clients, leads and invoices")
                    ChannelHint(accountID == nil ? "Optional. Ollie proposes a set you can change before saving." : "Optional. Ollie also looks at the senders and subjects of this inbox's latest mail.")
                    HStack {
                        Button("Cancel") { asking = false }.buttonStyle(ChipButtonStyle())
                        Spacer()
                        Button(action: runSuggest) { ButtonLabel(title: "Suggest", busy: thinking) }
                            .buttonStyle(InkButtonStyle())
                            .frame(width: 110)
                            .disabled(thinking)
                    }
                }
                .padding(10)
                .background(Tone.violet.soft, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            } else {
                HStack {
                    Button { asking = true } label: {
                        Label("Suggest with Ollie", systemImage: "sparkles").font(ODFont.sans(14, weight: .medium))
                    }
                    .foregroundStyle(Tone.violet.text)
                    Spacer()
                    if let undo {
                        Button("Undo") {
                            categories = undo
                            self.undo = nil
                        }
                        .buttonStyle(ChipButtonStyle())
                    }
                }
            }
        }
    }

    private func update(_ key: String, _ change: (inout MailCategory) -> Void) {
        guard let index = categories.firstIndex(where: { $0.key == key }) else { return }
        change(&categories[index])
    }

    private func move(_ index: Int, by offset: Int) {
        let to = index + offset
        guard to >= 1, categories.indices.contains(to) else { return }
        categories.swapAt(index, to)
        Haptics.selection()
    }

    private func runSuggest() {
        guard let api else { return }
        thinking = true
        Task {
            var body: ChannelBody = [:]
            if let accountID { body["account_id"] = .string(accountID) }
            let text = about.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { body["about"] = .string(text) }
            do {
                let answer: JSONValue = try await api.post("v1/collab/categories/suggest", body: body)
                let found = (try? answer["categories"]?.decode([MailCategory].self)) ?? []
                if found.isEmpty {
                    env.toasts.show("Ollie had nothing to suggest. Try a few words about the inbox.", kind: .info)
                } else {
                    undo = categories
                    categories = MailCategoryKit.unique(found)
                    asking = false
                    env.toasts.show(found.count == 1 ? "Ollie suggested 1 category." : "Ollie suggested \(found.count) categories.", kind: .success)
                }
            } catch {
                env.toasts.show("Ollie could not suggest categories", kind: .error)
            }
            thinking = false
        }
    }
}

/// The editor's rules, as the web's (`lib/collab/categories`).
enum MailCategoryKit {
    static let minimum = 2
    static let maximum = 10
    static let tones = ["gray", "red", "orange", "amber", "green", "teal", "blue", "indigo", "violet", "pink"]
    static let newTones = ["blue", "green", "amber", "pink", "teal", "indigo", "orange", "red"]
    private static let draftPrefix = "~"

    /// Primary, Updates, Newsletters and Promotions from the presets.
    static func defaults(_ presets: [MailCategory]) -> [MailCategory] {
        ["primary", "updates", "newsletters", "promotions"].compactMap { key in presets.first { $0.key == key } }
    }

    /// A key a category added here holds until it is saved; no server key starts with "~".
    static func draftKey() -> String { draftPrefix + UUID().uuidString.prefix(8) }

    static func problem(_ list: [MailCategory]) -> String? {
        if list.count < minimum || list.count > maximum { return "Use between \(minimum) and \(maximum) categories." }
        var names = Set<String>()
        for category in list {
            let name = category.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if name.isEmpty || name.count > 40 { return "Every category needs a name of up to 40 characters." }
            if names.contains(name) { return "Two categories have the same name." }
            names.insert(name)
        }
        return nil
    }

    static func slug(_ name: String) -> String {
        let lowered = name.lowercased()
        var out = ""
        var dash = false
        for scalar in lowered.unicodeScalars {
            if ("a" ... "z").contains(scalar) || ("0" ... "9").contains(scalar) {
                out.unicodeScalars.append(scalar)
                dash = false
            } else if !dash, !out.isEmpty {
                out.append("-")
                dash = true
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return String(out.prefix(36))
    }

    /// Keys for every category: Primary first, new ones from their names, none twice.
    static func withKeys(_ list: [MailCategory]) -> [MailCategory] {
        var seen = Set<String>()
        return list.enumerated().map { index, category in
            var key: String
            if index == 0 {
                key = MailCategory.primary
            } else {
                key = category.key.isEmpty || category.key.hasPrefix(draftPrefix) ? slug(category.name) : category.key
                if key.isEmpty || key == MailCategory.primary { key = "category" }
            }
            let base = key
            var n = 2
            while seen.contains(key) {
                key = "\(base)-\(n)"
                n += 1
            }
            seen.insert(key)
            var out = category
            out.key = key
            out.name = out.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return out
        }
    }

    /// A list from elsewhere (Ollie) with keys the editor can tell apart.
    static func unique(_ list: [MailCategory]) -> [MailCategory] {
        var seen = Set<String>()
        return list.map { category in
            var out = category
            if out.key.isEmpty || seen.contains(out.key) { out.key = draftKey() }
            seen.insert(out.key)
            return out
        }
    }

    static func json(_ list: [MailCategory]) -> JSONValue { .array(withKeys(list).map(\.json)) }

    static func updated(_ at: Date, by: String?) -> String {
        by.map { "Updated \(Format.relLong(at)) by \($0)" } ?? "Updated \(Format.relLong(at))"
    }
}

// MARK: - Store

@MainActor
@Observable
final class MailCategoriesStore {
    private(set) var settings: MailCategorySettings?
    private(set) var accounts: [MailAccount] = []
    private(set) var loaded = false
    private(set) var error: String?

    @ObservationIgnored private(set) var api: APIClient?

    func attach(_ api: APIClient) { self.api = api }

    func load(accounts withAccounts: Bool) async {
        guard let api else { return }
        do {
            settings = try await api.get("v1/collab/categories")
            if withAccounts {
                let list: ChannelList<MailAccount>? = try? await api.get("v1/collab/accounts")
                accounts = (list?.data ?? []).filter(\.canManage)
            }
            error = nil
        } catch {
            if !error.isCancellation { self.error = error.userMessage }
        }
        loaded = true
    }

    private func put(_ path: String, _ body: ChannelBody) async throws {
        guard let api else { return }
        settings = try await api.send(APIRequest(method: "PUT", path: path, body: try APICoding.encoder.encode(body)))
    }

    private func remove(_ path: String) async throws {
        guard let api else { return }
        settings = try await api.send(APIRequest(method: "DELETE", path: path))
    }

    func setWorkspace(enabled: Bool, categories: [MailCategory], locked: Bool) async throws {
        var body: ChannelBody = ["enabled": .bool(enabled), "locked": .bool(locked)]
        if enabled { body["categories"] = MailCategoryKit.json(categories) }
        try await put("v1/collab/categories/workspace", body)
    }

    func removeWorkspace() async throws { try await remove("v1/collab/categories/workspace") }

    func setTeam(_ id: String, enabled: Bool, categories: [MailCategory]) async throws {
        var body: ChannelBody = ["enabled": .bool(enabled)]
        if enabled { body["categories"] = MailCategoryKit.json(categories) }
        try await put("v1/collab/categories/teams/\(id)", body)
    }

    func removeTeam(_ id: String) async throws { try await remove("v1/collab/categories/teams/\(id)") }

    func orderTeams(_ ids: [String]) async throws {
        let before = settings
        if var next = settings {
            next.teams = ids.compactMap { id in next.teams.first { $0.teamID == id } }
            settings = next
        }
        do {
            try await put("v1/collab/categories/team-order", ["team_ids": .chStrings(ids)])
        } catch {
            settings = before
            throw error
        }
    }
}
