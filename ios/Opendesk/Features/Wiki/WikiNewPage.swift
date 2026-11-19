import SwiftUI

// Adding to the wiki or Pages (contracts/wiki.md "In the main sidebar", contracts/pages.md
// "Adding"): the new page popup (where it goes, then a page, a database or a canvas, or a
// template), the ways to start an empty area, the templates and one teamspace's pages.

/// Where the new page popup adds: an area, and the page it goes under (nil: the top level,
/// in the space picked in the popup).
struct WikiNewPagePlace: Identifiable, Hashable {
    var area: WikiArea
    var parentID: String?
    /// Opens with the templates in view.
    var templates = false

    var id: String { "\(area.rawValue):\(parentID ?? "top"):\(templates)" }
}

/// What a way to start makes.
enum WikiStart {
    /// `page`, `database` or `canvas`.
    case kind(String)
    case template
}

/// A kind of page and what it is for.
struct WikiKindChoice: Identifiable {
    let kind: String
    let symbol: String
    let title: String
    let hint: String
    var id: String { kind }

    static let all: [WikiKindChoice] = [
        WikiKindChoice(kind: "page", symbol: "doc.text", title: "Page", hint: "Write with headings, lists, to-dos and more."),
        WikiKindChoice(kind: "database", symbol: "tablecells", title: "Database", hint: "Rows with properties, in a table, a board or a list."),
        WikiKindChoice(kind: "canvas", symbol: "rectangle.on.rectangle.angled", title: "Canvas", hint: "Cards and the links between them on an endless board."),
    ]
}

/// One way to start: its mark, name and what it is for.
private struct WikiChoiceLabel: View {
    let symbol: String
    let title: String
    let hint: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Theme.fg2)
                .frame(width: 32, height: 32)
                .background(Theme.hover, in: RoundedRectangle(cornerRadius: Theme.Radius.control - 2, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg)
                Text(hint).font(ODFont.sans(12.5)).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 4)
            Chevron()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }
}

/// The ways to start an empty area: a page, a database, a canvas or a template.
struct WikiStartPanel: View {
    let area: WikiArea
    var busy = false
    let onPick: (WikiStart) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Start with")
            Panel {
                ForEach(Array(WikiKindChoice.all.enumerated()), id: \.element.id) { index, choice in
                    if index > 0 { Hairline(inset: 58) }
                    Button { onPick(.kind(choice.kind)) } label: {
                        WikiChoiceLabel(symbol: choice.symbol, title: choice.title, hint: choice.hint)
                    }
                    .buttonStyle(RowPressStyle())
                    .disabled(busy)
                }
                Hairline(inset: 58)
                Button { onPick(.template) } label: {
                    WikiChoiceLabel(symbol: "square.on.square", title: "From a template", hint: "A page with its outline filled in.")
                }
                .buttonStyle(RowPressStyle())
                .disabled(busy)
            }
        }
    }
}

/// The new page popup: where a top-level page goes (the workspace, private, or a teamspace
/// the person is on), then what to make: a page, a database, a canvas, or a copy of a
/// template (the workspace's own, then the starter outlines).
struct WikiNewPageSheet: View {
    let place: WikiNewPagePlace

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var space: WikiSection = .workspace
    @State private var templates: [WikiNode] = []
    @State private var templatesLoaded = false

    private var store: WikiStore { WikiStore.shared }

    /// The teamspaces a page can go in: the teams the person is on.
    private var teams: [Team] {
        let me = env.session.user?.id
        return env.directory.teams.filter { team in
            guard let members = team.memberIDs, let me else { return true }
            return members.contains(me)
        }
    }

    private var title: String {
        if let parent = place.parentID.flatMap({ store.node($0) }) { return "New page in \u{201C}\(parent.displayTitle)\u{201D}" }
        return place.area == .pages ? "New in Pages" : "New in the wiki"
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    if place.parentID == nil {
                        Section {
                            spaceRow(.workspace, title: "Workspace", symbol: "building.2")
                            spaceRow(.personal, title: "Private", symbol: "lock")
                            ForEach(teams) { team in
                                spaceRow(.team(team.id), title: team.name, symbol: "person.3")
                            }
                        } header: {
                            SectionLabel("Where it goes")
                        }
                    }
                    Section {
                        ForEach(WikiKindChoice.all) { choice in
                            Button { make(kind: choice.kind) } label: {
                                WikiChoiceLabel(symbol: choice.symbol, title: choice.title, hint: choice.hint)
                            }
                            .buttonStyle(RowPressStyle())
                            .listRowInsets(EdgeInsets())
                        }
                    } header: {
                        SectionLabel("Add")
                    }
                    Section {
                        if !templatesLoaded {
                            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 12)
                        }
                        ForEach(templates) { template in
                            Button { use(template) } label: { templateRow(icon: template.icon, title: template.displayTitle, hint: nil, database: template.isDatabase) }
                                .buttonStyle(RowPressStyle())
                                .listRowInsets(EdgeInsets())
                        }
                        ForEach(WikiTemplate.all) { starter in
                            Button { start(starter) } label: { templateRow(icon: starter.icon, title: starter.title, hint: starter.hint, database: false) }
                                .buttonStyle(RowPressStyle())
                                .listRowInsets(EdgeInsets())
                        }
                    } header: {
                        SectionLabel("From a template").id("templates")
                    }
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
                .background(Theme.chrome)
                .task {
                    templates = (try? await store.templates()) ?? []
                    templatesLoaded = true
                    if place.templates { withAnimation(Motion.snappy) { proxy.scrollTo("templates", anchor: .top) } }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Cancel") { dismiss() } }
            }
        }
    }

    private func spaceRow(_ section: WikiSection, title: String, symbol: String) -> some View {
        Button {
            Haptics.selection()
            space = section
        } label: {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.fg3).frame(width: 24)
                Text(title).font(ODFont.sans(15)).foregroundStyle(Theme.fg).lineLimit(1)
                Spacer(minLength: 4)
                if space == section {
                    Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.fg)
                }
            }
            .frame(minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(space == section ? .isSelected : [])
    }

    private func templateRow(icon: String, title: String, hint: String?, database: Bool) -> some View {
        HStack(spacing: 12) {
            WikiPageIcon(icon: icon, size: 18, database: database).frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg).lineLimit(1)
                if let hint { Text(hint).font(ODFont.sans(12.5)).foregroundStyle(Theme.fg3) }
            }
            Spacer(minLength: 4)
            Chevron()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    /// The space fields of a top-level page.
    private var spaceFields: (space: String?, teamID: String?) {
        guard place.parentID == nil else { return (nil, nil) }
        switch space {
        case .workspace: return (nil, nil)
        case .personal: return ("private", nil)
        case let .team(id): return ("team", id)
        }
    }

    private func make(kind: String) {
        let fields = spaceFields
        let body = WikiPageCreate(parentID: place.parentID, space: fields.space, teamID: fields.teamID,
                                  area: place.parentID == nil ? place.area : nil, kind: kind == "page" ? nil : kind)
        dismiss()
        Task { await WikiCreate.page(body, env: env) }
    }

    private func start(_ starter: WikiTemplate) {
        let fields = spaceFields
        let body = WikiPageCreate(parentID: place.parentID, title: starter.title, icon: starter.icon, bodyHTML: starter.bodyHTML,
                                  space: fields.space, teamID: fields.teamID, area: place.parentID == nil ? place.area : nil)
        dismiss()
        Task { await WikiCreate.page(body, env: env) }
    }

    private func use(_ template: WikiNode) {
        let fields = spaceFields
        dismiss()
        Task { await WikiCreate.fromTemplate(template, in: place.area, parentID: place.parentID, space: fields.space, teamID: fields.teamID, env: env) }
    }
}

/// The templates (contracts/wiki.md "Templates"), shared by both areas: one makes a page at
/// the top of this area, and opens to be edited like any page.
struct WikiTemplatesView: View {
    let area: WikiArea

    @Environment(AppEnvironment.self) private var env
    @State private var templates: [WikiNode] = []
    @State private var loaded = false
    @State private var error: String?

    private var store: WikiStore { WikiStore.shared }

    var body: some View {
        content
            .background(Theme.surface.ignoresSafeArea())
            .navigationTitle("Templates")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarVisibility(.visible, for: .navigationBar)
            .task {
                store.attach(env)
                await load()
            }
    }

    @ViewBuilder
    private var content: some View {
        if !loaded {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error, templates.isEmpty {
            ErrorState(title: "Couldn't load the templates", message: error) { Task { await load() } }
                .frame(maxHeight: .infinity)
        } else {
            List {
                Text("A template makes a new page with its outline and subpages, in \(area == .pages ? "Pages" : "the wiki").")
                    .font(ODFont.sans(13))
                    .foregroundStyle(Theme.fg3)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Theme.surface)
                if !templates.isEmpty {
                    header("Your workspace\u{2019}s")
                    ForEach(templates) { template in
                        Button { use(template) } label: { row(icon: template.icon, title: template.displayTitle, hint: nil, database: template.isDatabase) }
                            .buttonStyle(RowPressStyle())
                            .disabled(!env.session.canWrite)
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                            .listRowBackground(Theme.surface)
                            .contextMenu {
                                if env.session.canWrite {
                                    Button { use(template) } label: { Label("Use this template", systemImage: "plus") }
                                }
                                Button { env.router.push(.wikiPage(template.id)) } label: { Label("Open the template", systemImage: "doc.text") }
                            }
                    }
                }
                if env.session.canWrite {
                    header("Starters")
                    ForEach(WikiTemplate.all) { starter in
                        Button {
                            Task { await WikiCreate.page(WikiPageCreate(title: starter.title, icon: starter.icon, bodyHTML: starter.bodyHTML, area: area), env: env) }
                        } label: { row(icon: starter.icon, title: starter.title, hint: starter.hint, database: false) }
                            .buttonStyle(RowPressStyle())
                            .listRowInsets(EdgeInsets())
                            .listRowSeparator(.hidden)
                            .listRowBackground(Theme.surface)
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .refreshable { await load() }
        }
    }

    private func header(_ text: String) -> some View {
        SectionLabel(text)
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 4)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Theme.surface)
    }

    private func row(icon: String, title: String, hint: String?, database: Bool) -> some View {
        HStack(spacing: 12) {
            WikiPageIcon(icon: icon, size: 18, database: database).frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg).lineLimit(1)
                if let hint { Text(hint).font(ODFont.sans(12.5)).foregroundStyle(Theme.fg3) }
            }
            Spacer(minLength: 4)
            Chevron()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func use(_ template: WikiNode) {
        Task { await WikiCreate.fromTemplate(template, in: area, env: env) }
    }

    private func load() async {
        do {
            templates = try await store.templates()
            error = nil
        } catch {
            guard !error.isCancellation else { return }
            self.error = error.userMessage
        }
        loaded = true
    }
}

/// One teamspace's pages in an area, each with its subpages folded under it.
struct WikiTeamspaceView: View {
    let area: WikiArea
    let teamID: String

    @Environment(AppEnvironment.self) private var env
    @State private var moving: WikiNode?
    @State private var creating = false

    private var store: WikiStore { WikiStore.shared }
    private var name: String { env.directory.teams.first { $0.id == teamID }?.name ?? "Teamspace" }

    var body: some View {
        let outline = store.outline(in: .team(teamID), area: area)
        Group {
            if !store.loadedOnce && store.loading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if outline.isEmpty {
                ScrollView {
                    EmptyState(
                        symbol: "person.3",
                        title: "No pages in \(name) yet",
                        message: "Pages in a teamspace are for the people on its team.",
                        actionTitle: env.session.canWrite ? "Add a page" : nil
                    ) { create(WikiPageCreate(space: "team", teamID: teamID, area: area)) }
                        .padding(.top, 60)
                }
            } else {
                List {
                    ForEach(outline) { item in
                        let subpages = store.treeChildren(of: item.node.id).count
                        WikiTreeRow(node: item.node, level: item.level, subpages: subpages, expanded: store.expanded.contains(item.node.id), onToggle: {
                            Haptics.selection()
                            withAnimation(Motion.snappy) { store.toggle(item.node.id) }
                        }, onOpen: { env.router.push(.wikiPage(item.node.id)) })
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(Theme.surface)
                        .contextMenu {
                            WikiPageMenu(
                                node: item.node,
                                onAddSubpage: { create(WikiPageCreate(parentID: item.node.id)) },
                                onMove: { moving = item.node },
                                onDelete: { WikiTrash.move(item.node, env: env) }
                            )
                        }
                    }
                    if env.session.canWrite {
                        Button { create(WikiPageCreate(space: "team", teamID: teamID, area: area)) } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "plus").font(.system(size: 13, weight: .semibold)).frame(width: 28)
                                Text("New page").font(ODFont.sans(15))
                                Spacer()
                            }
                            .foregroundStyle(Theme.fg3)
                            .padding(.leading, 8)
                            .frame(height: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(RowPressStyle())
                        .disabled(creating)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(Theme.surface)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .motion(Motion.snappy, value: store.expanded)
                .refreshable { await store.refresh() }
            }
        }
        .background(Theme.surface.ignoresSafeArea())
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.visible, for: .navigationBar)
        .sheet(item: $moving) { node in
            WikiMoveSheet(node: node)
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .task { store.attach(env) }
    }

    private func create(_ body: WikiPageCreate) {
        guard !creating else { return }
        creating = true
        Task {
            await WikiCreate.page(body, env: env)
            creating = false
        }
    }
}
