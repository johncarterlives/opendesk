import SwiftUI

// A picked Space in the app's menu sheet (`ScopeSheet`): its sections and rows from every
// workspace in it, numbered by the open workspace's live counts and the others' overview
// (contracts/spaces.md "Rows").

/// A Space's mark: its icon, or its name's first letter, on its colour.
struct SpaceMark: View {
    let name: String
    let icon: String
    let color: SpaceColor
    var size: CGFloat = 28

    var body: some View {
        let tone = color.tone
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.26, style: .continuous).fill(tone.soft)
            if let symbol = SpaceRules.symbol(for: icon) {
                Image(systemName: symbol)
                    .font(.system(size: size * 0.46, weight: .medium))
                    .foregroundStyle(tone.text)
            } else {
                Text(String(SpaceRules.clean(name).prefix(1)).uppercased())
                    .font(ODFont.sans(size * 0.42, weight: .semibold))
                    .foregroundStyle(tone.text)
            }
        }
        .frame(width: size, height: size)
        .overlay(RoundedRectangle(cornerRadius: size * 0.26, style: .continuous).strokeBorder(tone.line, lineWidth: 1))
        .accessibilityHidden(true)
    }
}

extension SpaceMark {
    init(_ space: Space, size: CGFloat = 28) {
        self.init(name: space.name, icon: space.icon, color: space.color, size: size)
    }
}

/// One row a Space shows: what it is called, its mark and number, and where it goes.
struct SpaceRowModel: Identifiable {
    enum Mark {
        case symbol(String)
        case team(id: String, name: String)
        case view(ViewIcon?)
        case account(String)
        /// The member's own emoji, or a page's.
        case emoji(String)
    }

    var id: String
    var title: String
    var mark: Mark
    var count: Int?
    var workspaceID: String
    var destination: SpaceDestination
    var selected = false
}

/// Rows shown together: the plain rows of a section, or a whole built-in section under its title.
struct SpaceRowGroup: Identifiable {
    var id: String
    var title: String?
    var workspaceID: String?
    var rows: [SpaceRowModel]
}

/// Turns Space items into rows with what each workspace says about them. An item naming
/// something gone, hidden, or of a product the workspace has off is skipped, never removed.
@MainActor
struct SpaceRowBuilder {
    let env: AppEnvironment
    private var spaces: SpacesStore { .shared }
    private var overview: OverviewStore { .shared }

    init(env: AppEnvironment) { self.env = env }

    func membership(_ workspace: String) -> Membership? { env.session.memberships.first { $0.id == workspace } }
    func isOpen(_ workspace: String) -> Bool { workspace == env.session.workspace?.id }

    /// Whether the workspace has Mail; nil while that is not known yet (its rows wait).
    func collab(_ workspace: String) -> Bool? {
        if isOpen(workspace) {
            guard env.directory.loaded else { return nil }
            return env.directory.collab.enabled && env.products.mail
        }
        guard overview.loaded else { return nil }
        guard let entry = overview.overview(workspace) else { return false }
        return entry.mailCounts != nil
    }

    func ticketsOn(_ workspace: String) -> Bool {
        isOpen(workspace) ? env.products.tickets : membership(workspace)?.workspace.ticketsOn ?? false
    }

    private func ticketCounts(_ workspace: String) -> TicketCounts? {
        isOpen(workspace) ? env.directory.counts : overview.overview(workspace)?.ticketCounts
    }

    private func mailCounts(_ workspace: String) -> MailCounts? { overview.overview(workspace)?.mailCounts }

    func teams(_ workspace: String) -> [Team] {
        isOpen(workspace) ? env.directory.teams : spaces.data[workspace]?.teams ?? []
    }

    func views(_ workspace: String) -> [SavedView] {
        isOpen(workspace) ? env.directory.views : spaces.data[workspace]?.views ?? []
    }

    func accounts(_ workspace: String) -> [MailAccount] { spaces.data[workspace]?.accounts ?? [] }

    func mailboxes(_ workspace: String) -> [InboxMailbox] {
        if isOpen(workspace), env.directory.loaded { return env.directory.mailboxes }
        return spaces.data[workspace]?.mailboxes ?? []
    }

    func pages(_ workspace: String) -> [SpacePage] { spaces.data[workspace]?.pages ?? [] }

    func pagesOn(_ workspace: String) -> Bool {
        isOpen(workspace) ? env.products.pages : spaces.data[workspace]?.pagesOn ?? false
    }

    /// A team whose pages the person sees, as a teamspace.
    func teamspace(_ id: String, in workspace: String) -> Team? {
        guard pages(workspace).contains(where: { $0.teamID == id }) else { return nil }
        return teams(workspace).first { $0.id == id }
    }

    func myTeams(_ workspace: String) -> [Team] {
        guard let me = env.session.user?.id else { return [] }
        return teams(workspace).filter { $0.memberIDs?.contains(me) == true }
    }

    // MARK: Showing

    func usable(_ item: SpaceItem) -> Bool {
        if item.isEverywhere { return EverywhereList(rawValue: item.itemID) != nil }
        guard membership(item.workspaceID) != nil else { return false }
        if item.needsTickets, !ticketsOn(item.workspaceID) { return false }
        if item.needsCollab, collab(item.workspaceID) != true { return false }
        return true
    }

    /// The sections that show, each with its groups of rows; empty ones are left out.
    func sections(of space: Space) -> [(section: SpaceSection, groups: [SpaceRowGroup])] {
        var out: [(SpaceSection, [SpaceRowGroup])] = []
        for section in space.sections {
            var groups: [SpaceRowGroup] = []
            var loose: [SpaceRowModel] = []
            func closeLoose() {
                guard !loose.isEmpty else { return }
                groups.append(SpaceRowGroup(id: "\(section.id):\(groups.count)", title: nil, workspaceID: nil, rows: loose))
                loose = []
            }
            for item in section.items where usable(item) {
                if item.kind == .section || item.kind == .wikiSpace {
                    let rows = sectionRows(item)
                    guard !rows.isEmpty else { continue }
                    closeLoose()
                    let title: String? = item.kind == .wikiSpace ? (item.name ?? teamspace(item.itemID, in: item.workspaceID)?.name) : sectionTitle(item.itemID, workspace: item.workspaceID)
                    groups.append(SpaceRowGroup(id: item.id, title: title, workspaceID: item.workspaceID, rows: rows))
                } else if let row = row(item) {
                    loose.append(row)
                }
            }
            closeLoose()
            if !groups.isEmpty { out.append((section, groups)) }
        }
        return out
    }

    /// The workspaces with rows in the Space, to read their teams, views and accounts.
    func workspaces(in space: Space) -> [String] {
        // Everywhere rows belong to no workspace: their numbers come from the overview.
        var out: [String] = []
        for item in space.items where !item.isEverywhere && !out.contains(item.workspaceID) && membership(item.workspaceID) != nil {
            out.append(item.workspaceID)
        }
        return out
    }

    func sectionTitle(_ id: String, workspace: String) -> String {
        switch id {
        case "inbox": collab(workspace) == true ? "Tickets" : "Inbox"
        case "mail": "Mail"
        case "teams": "Teams"
        case "views": "Views"
        case "favorites": "Favorites"
        case "pages": "Pages"
        default: "Workspace"
        }
    }

    /// A row's own name, or what its workspace calls it.
    func row(_ item: SpaceItem) -> SpaceRowModel? {
        guard var model = base(item.kind, item.itemID, in: item.workspaceID) else { return nil }
        if let name = item.name { model.title = name }
        if let icon = item.icon { model.mark = .emoji(icon) }
        if item.hidesNumber { model.count = nil }
        model.id = item.id
        return model
    }

    /// A whole built-in section, kept up to date: the rows its workspace's own sidebar has.
    func sectionRows(_ item: SpaceItem) -> [SpaceRowModel] {
        let workspace = item.workspaceID
        if item.kind == .wikiSpace {
            // A teamspace is its tree's top pages.
            guard teamspace(item.itemID, in: workspace) != nil else { return [] }
            let all = pages(workspace).filter { $0.teamID == item.itemID }
            let tops = all.filter { page in !all.contains { $0.id == page.parentID } }
            return tops.compactMap { page in
                guard var model = base(.wikiPage, page.id, in: workspace) else { return nil }
                model.id = "\(item.id)/wiki_page:\(page.id)"
                return model
            }
        }
        let entries: [(SpaceItemKind, String)]
        switch item.itemID {
        case "inbox":
            entries = Folder.allCases.map { (.ticketFolder, $0.rawValue) }
        case "teams":
            let mine = myTeams(workspace)
            entries = mine.isEmpty ? [] : [(.team, InboxScope.myTeams)] + mine.map { (.team, $0.id) }
        case "views":
            entries = views(workspace).map { (.view, $0.id) }
        case "mail":
            entries = [(.box, "inbox"), (.box, "shared"), (.box, "assigned")] + accounts(workspace).map { (.account, $0.id) }
        case "workspace":
            entries = ["contacts", "knowledge", "wiki", "reports"].filter { $0 != "reports" || ticketsOn(workspace) }.map { (.page, $0) }
        case "favorites":
            // The open workspace's favorites, as the member pinned them, after the Space's own.
            let pinnable: [SpaceItemKind] = [.ticketFolder, .team, .view, .box, .account, .folder]
            entries = !isOpen(workspace) ? [] : SidebarStore.shared.prefs.pinned.compactMap { pin -> (SpaceItemKind, String)? in
                let kind = SpaceItemKind(rawValue: pin.kind)
                return pinnable.contains(kind) ? (kind, pin.id) : nil
            }
        case "pages":
            // The pages at the top of Pages' tree, outside teamspaces.
            entries = pages(workspace).filter { $0.area == "pages" && $0.parentID == nil && $0.teamID == nil }.map { (.wikiPage, $0.id) }
        default:
            entries = []
        }
        return item.arranged(entries).compactMap { kind, id in
            guard var model = base(kind, id, in: workspace) else { return nil }
            model.id = "\(item.id)/\(kind.rawValue):\(id)"
            if item.hidesNumber { model.count = nil }
            return model
        }
    }

    /// What `kind` and `id` name in `workspace`, or nil when it is gone or unknown.
    func base(_ kind: SpaceItemKind, _ id: String, in workspace: String) -> SpaceRowModel? {
        let open = isOpen(workspace)
        let counts = ticketCounts(workspace)
        let mail = mailCounts(workspace)
        let area = env.router.shownArea
        func model(_ title: String, _ mark: SpaceRowModel.Mark, _ count: Int?, _ destination: SpaceDestination, _ selected: Bool) -> SpaceRowModel {
            SpaceRowModel(id: "\(workspace):\(kind.rawValue):\(id)", title: title, mark: mark, count: count, workspaceID: workspace, destination: destination, selected: open && selected)
        }
        switch kind {
        case .ticketFolder:
            guard let folder = Folder(rawValue: id) else { return nil }
            return model(folder.title, .symbol(folder.symbol), folder.count(in: counts), .folder(folder), area == .tickets && env.inbox.scope == .folder(folder))
        case .team:
            if id == InboxScope.myTeams {
                return model("My teams", .symbol("person.3"), counts?.myTeams?.unassigned, .team(id), area == .tickets && env.inbox.scope.teamID == id)
            }
            guard let team = teams(workspace).first(where: { $0.id == id }) else { return nil }
            return model(team.name, .team(id: team.id, name: team.name), counts?.teams[id]?.unassigned, .team(id), area == .tickets && env.inbox.scope.teamID == id)
        case .view:
            guard let view = views(workspace).first(where: { $0.id == id }) else { return nil }
            return model(view.displayName, .view(view.icon), counts?.views[id], .view(id), area == .tickets && env.inbox.scope == .view(id))
        case .box:
            guard ["inbox", "shared", "assigned"].contains(id), let box = MailBox(rawValue: id) else { return nil }
            let scope = MailStore.shared.scope
            return model(box == .inbox ? "All inboxes" : box.title, .symbol(box.symbol), mail?.boxes[id], .mailBox(box),
                         area == .mail && scope.box == box && scope.accountID == nil && scope.folderID == nil)
        case .account:
            guard let account = accounts(workspace).first(where: { $0.id == id }) else { return nil }
            let scope = MailStore.shared.scope
            return model(account.label, .account(account.color), mail?.accounts[id], .mailAccount(id), area == .mail && scope.accountID == id && scope.folderID == nil)
        case .folder:
            guard let folder = spaces.data[workspace]?.allFolders.first(where: { $0.id == id }) else { return nil }
            return model(folder.name, .symbol(folder.kind == "label" ? "tag" : "folder"), mail?.folders[id], .mailFolder(id: id, account: folder.accountID),
                         area == .mail && MailStore.shared.scope.folderID == id)
        case .page:
            let page: AppArea? = switch id {
            case "contacts": .contacts
            case "knowledge": .kb
            case "wiki": .wiki
            case "reports": .reports
            default: nil
            }
            guard let page else { return nil }
            return model(page.title, .symbol(page.symbol), nil, .area(page), area == page)
        case .wikiPage:
            guard let page = pages(workspace).first(where: { $0.id == id }) else { return nil }
            let mark: SpaceRowModel.Mark = page.icon.map { .emoji($0) } ?? .symbol(page.symbol)
            return model(page.displayTitle, mark, nil, .path(page.path), env.router.inboxPath.last == .wikiPage(id))
        case .wikiSpace:
            guard let team = teamspace(id, in: workspace) else { return nil }
            let inPages = pages(workspace).contains { $0.teamID == id && $0.area == "pages" }
            return model(team.name, .team(id: team.id, name: team.name), nil, .path((inPages ? "/pages?space=" : "/wiki?space=") + id), false)
        case .mailbox:
            guard let mailbox = mailboxes(workspace).first(where: { $0.id == id }) else { return nil }
            let title = open ? SidebarStore.shared.inboxTitle(mailbox) : mailbox.title
            return model(title, .symbol("tray.2"), Folder.unassigned.count(in: counts, mailbox: id), .path("/inbox/unassigned?mailbox=" + id),
                         area == .tickets && env.inbox.scope.mailboxID == id)
        case .everywhere:
            guard workspace.isEmpty, let list = EverywhereList(rawValue: id) else { return nil }
            return SpaceRowModel(id: "everywhere:\(id)", title: list.title, mark: .symbol(list.symbol), count: EverywhereStore.shared.count(list),
                                 workspaceID: "", destination: .everywhere(list), selected: env.router.tab == .inbox && area == .everywhere && env.router.everywhere == list)
        default:
            return nil
        }
    }

    // MARK: Describing (the editor)

    /// How the editor names an item, even before its workspace's data has loaded.
    func describe(_ item: SpaceItem) -> (title: String, mark: SpaceRowModel.Mark) {
        if item.kind == .section {
            return (item.name ?? sectionTitle(item.itemID, workspace: item.workspaceID), item.icon.map { .emoji($0) } ?? .symbol("rectangle.stack"))
        }
        if let model = base(item.kind, item.itemID, in: item.workspaceID) {
            return (item.name ?? model.title, item.icon.map { .emoji($0) } ?? model.mark)
        }
        let fallback: (String, String) = switch item.kind {
        case .team: ("A team", "person.3")
        case .view: ("A view", "square.stack")
        case .account: ("A mail account", "envelope")
        case .folder: ("A mail folder", "folder")
        case .wikiPage: ("A page", "doc.text")
        case .wikiSpace: ("A teamspace", "person.3")
        case .mailbox: ("A ticket inbox", "tray.2")
        default: ("Something no longer here", "questionmark.circle")
        }
        return (item.name ?? fallback.0, .symbol(fallback.1))
    }
}

// MARK: - Views

/// A row's mark, as the app's own rows draw it.
struct SpaceRowMarkView: View {
    let mark: SpaceRowModel.Mark
    var selected = false

    var body: some View {
        switch mark {
        case let .symbol(name):
            Image(systemName: name).font(.system(size: 15)).foregroundStyle(selected ? Theme.fg : Theme.fg3)
        case let .team(id, name):
            InboxTeamDot(id: id, name: name, size: 9)
        case let .view(icon):
            ViewIconMark(icon: icon, size: 15, tint: selected ? Theme.fg : Theme.fg3)
        case let .account(color):
            MailAccountDot(color: color, size: 8)
        case let .emoji(emoji):
            Text(emoji).font(.system(size: 15))
        }
    }
}

/// One Space row: the app's menu row, with its workspace's badge when it is another's.
struct SpaceRowView: View {
    let row: SpaceRowModel
    var mark: Workspace?

    var body: some View {
        HStack(spacing: 12) {
            SpaceRowMarkView(mark: row.mark, selected: row.selected).frame(width: 20)
            Text(row.title)
                .font(ODFont.sans(15, weight: row.selected ? .semibold : .regular))
                .foregroundStyle(Theme.fg)
                .lineLimit(1)
            if let mark {
                WorkspaceAvatar(workspace: mark, size: 16)
                    .accessibilityLabel("In \(mark.name)")
            }
            Spacer()
            if let count = row.count, count > 0 {
                Text("\(count)")
                    .font(ODFont.mono(12.5))
                    .monospacedDigit()
                    .foregroundStyle(Theme.fg3)
                    .contentTransition(.numericText())
            }
            if row.selected {
                Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.fg)
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 46)
        .background(row.selected ? Theme.hover : .clear)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(row.selected ? .isSelected : [])
    }
}

/// The picked Space as the menu: its sections, folding as the Space keeps them, and its rows.
struct SpaceSidebar: View {
    @Environment(AppEnvironment.self) private var env
    let space: Space
    /// A row was opened: the sheet closes.
    var onOpen: () -> Void
    var onEdit: () -> Void

    private var store: SpacesStore { .shared }

    var body: some View {
        let builder = SpaceRowBuilder(env: env)
        let shown = builder.sections(of: space)
        VStack(alignment: .leading, spacing: 18) {
            if shown.isEmpty {
                if !OverviewStore.shared.loaded || !env.directory.loaded {
                    Panel { ProgressView().frame(maxWidth: .infinity).padding(.vertical, 20) }
                } else {
                    Panel {
                        EmptyState(
                            symbol: "square.stack.3d.up",
                            title: "Nothing to show here yet",
                            message: "Add folders, teams, views, mail and pages from any of your workspaces.",
                            actionTitle: "Edit Space",
                            action: onEdit
                        )
                    }
                }
            }
            ForEach(shown, id: \.section.id) { entry in
                VStack(alignment: .leading, spacing: 8) {
                    if !entry.section.title.isEmpty { header(entry.section) }
                    if entry.section.title.isEmpty || !entry.section.collapsed {
                        ForEach(entry.groups) { group in groupView(group, builder: builder) }
                    }
                }
            }
        }
        .motion(Motion.snappy, value: space.sections.map(\.collapsed))
        .task(id: builder.workspaces(in: space).joined(separator: ",") + "/\(OverviewStore.shared.loaded)/\(env.directory.loaded)") {
            let needsFolders = Set(space.items.filter { $0.kind == .folder }.map(\.workspaceID))
            for workspace in builder.workspaces(in: space) {
                guard let collab = builder.collab(workspace) else { continue }
                store.loadData(for: workspace, collab: collab, folders: needsFolders.contains(workspace))
            }
        }
    }

    private func header(_ section: SpaceSection) -> some View {
        Button {
            Haptics.selection()
            store.setCollapsed(!section.collapsed, section: section.id, in: space.id)
        } label: {
            HStack(spacing: 6) {
                if let icon = section.icon { Text(icon).font(.system(size: 12.5)) }
                Text(section.title)
                    .font(ODFont.sans(12.5, weight: .medium))
                    .foregroundStyle(Theme.fg3)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(Theme.fg4)
                    .rotationEffect(.degrees(section.collapsed ? 0 : 90))
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(section.title)
        .accessibilityValue(section.collapsed ? "Folded" : "Open")
    }

    @ViewBuilder
    private func groupView(_ group: SpaceRowGroup, builder: SpaceRowBuilder) -> some View {
        if let title = group.title {
            HStack(spacing: 6) {
                Text(title).font(ODFont.sans(12, weight: .medium)).foregroundStyle(Theme.fg4)
                if let mark = otherWorkspace(group.workspaceID) {
                    WorkspaceAvatar(workspace: mark, size: 14)
                    Text(mark.name).font(ODFont.sans(12)).foregroundStyle(Theme.fg4).lineLimit(1)
                }
            }
            .padding(.horizontal, 4)
            .accessibilityElement(children: .combine)
        }
        Panel {
            ForEach(Array(group.rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 { Hairline(inset: 46) }
                Button {
                    Haptics.selection()
                    store.open(row.destination, in: row.workspaceID, env: env)
                    onOpen()
                } label: {
                    SpaceRowView(row: row, mark: group.title == nil ? otherWorkspace(row.workspaceID) : nil)
                }
                .buttonStyle(RowPressStyle())
            }
        }
    }

    /// Another workspace's badge, when the Space shows marks.
    private func otherWorkspace(_ id: String?) -> Workspace? {
        guard space.marks, let id, id != env.session.workspace?.id else { return nil }
        return env.session.memberships.first { $0.id == id }?.workspace
    }
}

/// Keeps every workspace's numbers live while this view is on screen (`OverviewStore`).
private struct FollowsOverview: ViewModifier {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .onAppear {
                SpacesStore.shared.start(env: env)
                SpacesStore.shared.refresh()
                OverviewStore.shared.start(env: env)
                EverywhereStore.shared.start(env: env)
                OverviewStore.shared.follow()
            }
            .onDisappear { OverviewStore.shared.unfollow() }
            .onChange(of: env.session.workspace?.id) { _, _ in OverviewStore.shared.start(env: env) }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { OverviewStore.shared.resume() }
            }
    }
}

extension View {
    func followsOverview() -> some View { modifier(FollowsOverview()) }
}
