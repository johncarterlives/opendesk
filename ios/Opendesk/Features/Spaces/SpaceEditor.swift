import SwiftUI

/// New Space and Edit (contracts/spaces.md "The editor"): the name, icon and colour; the Space's
/// sections and rows, dragged into order, each row with its own name and number; Add section;
/// rows added from any workspace; and whether other workspaces' rows carry their badge.
struct SpaceEditorSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var space: Space
    private let isNew: Bool
    private let starterOf: String?

    @State private var adding: AddTarget?
    @State private var renaming: RowRef?
    @State private var renameText = ""
    @State private var problem: String?
    @State private var saving = false
    @State private var confirmDiscard: AccountConfirm?
    @State private var iconFor: IconTarget?
    private let original: Space

    init(draft: SpaceDraft) {
        _space = State(initialValue: draft.space)
        original = draft.space
        isNew = draft.isNew
        starterOf = draft.starterOf
    }

    private struct AddTarget: Identifiable {
        var section: String
        var id: String { section }
    }

    private struct RowRef: Identifiable, Equatable {
        var section: String
        var item: String
        var id: String { section + "/" + item }
    }

    /// A section's emoji, or a row's when `item` is set.
    private struct IconTarget: Identifiable {
        var section: String
        var item: String?
        var title: String
        var id: String { section + "/" + (item ?? "") }
    }

    var body: some View {
        NavigationStack {
            List {
                identity
                ForEach(space.sections) { section in
                    sectionView(section)
                }
                Section {
                    Button {
                        Haptics.tap()
                        withAnimation(Motion.snappy) {
                            space.sections.append(SpaceSection(id: SpaceRules.newSectionID(in: space), title: ""))
                        }
                    } label: {
                        Label("Add section", systemImage: "plus.rectangle.on.rectangle")
                            .font(ODFont.sans(15, weight: .medium))
                            .foregroundStyle(Theme.fg)
                    }
                    .disabled(space.sections.count >= SpaceRules.sections)
                }
                Section {
                    Toggle(isOn: $space.marks) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Workspace badges").font(ODFont.sans(15)).foregroundStyle(Theme.fg)
                            Text("Rows from a workspace other than the open one carry its badge.")
                                .font(ODFont.footnote)
                                .foregroundStyle(Theme.fg3)
                        }
                    }
                    .tint(Theme.inverse)
                } footer: {
                    if let problem {
                        Text(problem).font(ODFont.footnote).foregroundStyle(Tone.red.text)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.chrome.ignoresSafeArea())
            .environment(\.editMode, .constant(.active))
            .navigationTitle(starterOf != nil ? "Starter Space" : isNew ? "New Space" : "Edit Space")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    SheetButton(.cancel, "Cancel") {
                        if space == original || isNew && space.items.isEmpty { dismiss() } else {
                            confirmDiscard = AccountConfirm(title: "Discard your changes?", message: "What you changed in this Space is not saved.", confirmTitle: "Discard") { dismiss() }
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(.confirm, isNew && starterOf == nil ? "Create" : "Save", busy: saving) { Task { await save() } }
                        .bold()
                    .disabled(saving)
                }
            }
        }
        .sheet(item: $adding) { target in
            SpaceAddRowsSheet(space: space, only: starterOf) { items in
                add(items, to: target.section)
            }
            .presentationDetents([.large])
            .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(item: $renaming) { ref in
            renameSheet(ref)
                .presentationDetents([.height(250)])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(item: $iconFor) { target in
            SidebarIconSheet(title: target.title, current: icon(of: target)) { setIcon($0, for: target) }
                .presentationDetents([.medium])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .accountConfirm($confirmDiscard)
    }

    // MARK: Name, icon, colour

    private var identity: some View {
        Section {
            HStack(spacing: 12) {
                SpaceMark(space, size: 40)
                TextField("Name", text: $space.name, prompt: Text("Morning, Support, Mail").foregroundStyle(Theme.fg4))
                    .font(ODFont.sans(17, weight: .medium))
                    .foregroundStyle(Theme.fg)
                    .submitLabel(.done)
            }
            .padding(.vertical, 4)
            VStack(alignment: .leading, spacing: 10) {
                Text("Icon").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 7), spacing: 6) {
                    iconChoice("", label: "First letter") {
                        Text(String(SpaceRules.clean(space.name).prefix(1)).uppercased().isEmpty ? "A" : String(SpaceRules.clean(space.name).prefix(1)).uppercased())
                            .font(ODFont.sans(14, weight: .semibold))
                    }
                    ForEach(SpaceRules.icons, id: \.name) { icon in
                        iconChoice(icon.name, label: icon.name) {
                            Image(systemName: icon.symbol).font(.system(size: 15))
                        }
                    }
                }
            }
            .padding(.vertical, 6)
            VStack(alignment: .leading, spacing: 10) {
                Text("Colour").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                HStack(spacing: 10) {
                    ForEach(SpaceColor.allCases) { color in
                        Button {
                            Haptics.selection()
                            space.color = color
                        } label: {
                            Circle()
                                .fill(color.tone.solid)
                                .frame(width: 26, height: 26)
                                .overlay(Circle().strokeBorder(Theme.surface, lineWidth: space.color == color ? 2.5 : 0))
                                .overlay(Circle().strokeBorder(space.color == color ? color.tone.solid : .clear, lineWidth: 1.5).padding(-3))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(color.title)
                        .accessibilityAddTraits(space.color == color ? .isSelected : [])
                    }
                }
            }
            .padding(.vertical, 6)
        }
        .moveDisabled(true)
        .deleteDisabled(true)
    }

    private func iconChoice<Content: View>(_ name: String, label: String, @ViewBuilder content: () -> Content) -> some View {
        let selected = space.icon == name
        return Button {
            Haptics.selection()
            space.icon = name
        } label: {
            content()
                .foregroundStyle(selected ? space.color.tone.text : Theme.fg2)
                .frame(maxWidth: .infinity)
                .frame(height: 36)
                .background(selected ? space.color.tone.soft : Theme.sunken, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(selected ? space.color.tone.line : Theme.lineSoft, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Sections and rows

    private func sectionView(_ section: SpaceSection) -> some View {
        let builder = SpaceRowBuilder(env: env)
        let index = space.sections.firstIndex { $0.id == section.id } ?? 0
        return Section {
            ForEach(section.items) { item in
                rowView(item, in: section, builder: builder)
            }
            .onMove { from, to in
                guard let at = space.sections.firstIndex(where: { $0.id == section.id }) else { return }
                space.sections[at].items.move(fromOffsets: from, toOffset: to)
            }
            .onDelete { offsets in
                guard let at = space.sections.firstIndex(where: { $0.id == section.id }) else { return }
                space.sections[at].items.remove(atOffsets: offsets)
            }
            Button {
                Haptics.tap()
                adding = AddTarget(section: section.id)
            } label: {
                Label("Add rows", systemImage: "plus")
                    .font(ODFont.sans(14.5, weight: .medium))
                    .foregroundStyle(Theme.fg2)
            }
            .moveDisabled(true)
            .deleteDisabled(true)
        } header: {
            HStack(spacing: 8) {
                if let icon = section.icon { Text(icon).font(.system(size: 14)) }
                TextField("Section title", text: titleBinding(section.id), prompt: Text(index == 0 ? "No title" : "Section title").foregroundStyle(Theme.fg4))
                    .font(ODFont.sans(13, weight: .semibold))
                    .foregroundStyle(Theme.fg2)
                    .textCase(nil)
                Menu {
                    Button {
                        iconFor = IconTarget(section: section.id, item: nil, title: section.title.isEmpty ? "this section" : section.title)
                    } label: { Label("Change icon", systemImage: "face.smiling") }
                    if index > 0 {
                        Button { moveSection(section.id, by: -1) } label: { Label("Move up", systemImage: "arrow.up") }
                    }
                    if index < space.sections.count - 1 {
                        Button { moveSection(section.id, by: 1) } label: { Label("Move down", systemImage: "arrow.down") }
                    }
                    Button(role: .destructive) {
                        withAnimation(Motion.snappy) { space.sections.removeAll { $0.id == section.id } }
                    } label: { Label("Remove section", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis.circle").font(.system(size: 16)).foregroundStyle(Theme.fg3)
                }
                .accessibilityLabel("Section options")
            }
            .textCase(nil)
        }
    }

    private func rowView(_ item: SpaceItem, in section: SpaceSection, builder: SpaceRowBuilder) -> some View {
        let described = builder.describe(item)
        let other = item.isEverywhere ? nil : env.session.memberships.first { $0.id == item.workspaceID }?.workspace
        return HStack(spacing: 10) {
            SpaceRowMarkView(mark: described.mark).frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(described.title).font(ODFont.sans(15)).foregroundStyle(Theme.fg).lineLimit(1)
                Text(rowCaption(item, workspace: other)).font(ODFont.footnote).foregroundStyle(Theme.fg3).lineLimit(1)
            }
            Spacer(minLength: 4)
            Menu {
                Button {
                    renameText = item.name ?? ""
                    renaming = RowRef(section: section.id, item: item.id)
                } label: { Label("Rename in this Space", systemImage: "pencil") }
                Button {
                    iconFor = IconTarget(section: section.id, item: item.id, title: described.title)
                } label: { Label("Change icon", systemImage: "face.smiling") }
                Button {
                    update(item.id) { $0.badge = $0.hidesNumber ? nil : "none" }
                } label: {
                    Label(item.hidesNumber ? "Show its number" : "Hide its number", systemImage: item.hidesNumber ? "number" : "eye.slash")
                }
                if space.sections.count > 1 {
                    Menu("Move to section") {
                        ForEach(space.sections.filter { $0.id != section.id }) { target in
                            Button(target.title.isEmpty ? "Untitled section" : target.title) { moveItem(item.id, to: target.id) }
                        }
                    }
                }
                Divider()
                Button(role: .destructive) {
                    withAnimation(Motion.snappy) { removeItem(item.id) }
                } label: { Label("Remove from the Space", systemImage: "minus.circle") }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.fg3).frame(width: 32, height: 32)
            }
            .accessibilityLabel("Options for \(described.title)")
        }
    }

    private func rowCaption(_ item: SpaceItem, workspace: Workspace?) -> String {
        let kind: String = switch item.kind {
        case .section: "Whole section"
        case .ticketFolder: "Inbox folder"
        case .team: "Team"
        case .view: "View"
        case .box: "Mail box"
        case .account: "Mail account"
        case .folder: "Mail folder"
        case .page: "Page"
        case .wikiPage: "Page"
        case .wikiSpace: "Teamspace"
        case .mailbox: "Ticket inbox"
        case .everywhere: "Every workspace"
        default: "Row"
        }
        var parts = [kind]
        if let workspace { parts.append(workspace.name) }
        if item.hidesNumber { parts.append("No number") }
        return parts.joined(separator: " · ")
    }

    private func renameSheet(_ ref: RowRef) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            AccountSheetHeader(title: "Rename in this Space", subtitle: "Only this Space shows the name. Leave it empty for the usual one.") { renaming = nil }
            ODTextField(label: "Name", text: $renameText, prompt: "Its usual name", submitLabel: .done) { commitRename(ref) }
            Button("Save") { commitRename(ref) }
                .buttonStyle(InkButtonStyle())
        }
        .padding(22)
        .background(Theme.surface)
    }

    private func commitRename(_ ref: RowRef) {
        let name = SpaceRules.clean(renameText)
        update(ref.item) { $0.name = name.isEmpty ? nil : String(name.prefix(SpaceRules.rowName)) }
        renaming = nil
    }

    // MARK: Changing the draft

    private func titleBinding(_ id: String) -> Binding<String> {
        Binding(
            get: { space.sections.first { $0.id == id }?.title ?? "" },
            set: { value in
                guard let index = space.sections.firstIndex(where: { $0.id == id }) else { return }
                space.sections[index].title = String(value.prefix(SpaceRules.title))
            }
        )
    }

    private func update(_ key: String, _ change: (inout SpaceItem) -> Void) {
        for s in space.sections.indices {
            if let i = space.sections[s].items.firstIndex(where: { $0.id == key }) {
                change(&space.sections[s].items[i])
                return
            }
        }
    }

    private func icon(of target: IconTarget) -> String? {
        guard let section = space.sections.first(where: { $0.id == target.section }) else { return nil }
        guard let item = target.item else { return section.icon }
        return section.items.first { $0.id == item }?.icon
    }

    private func setIcon(_ icon: String?, for target: IconTarget) {
        if let item = target.item {
            update(item) { $0.icon = icon }
        } else if let index = space.sections.firstIndex(where: { $0.id == target.section }) {
            space.sections[index].icon = icon
        }
    }

    private func removeItem(_ key: String) {
        for s in space.sections.indices { space.sections[s].items.removeAll { $0.id == key } }
    }

    private func moveItem(_ key: String, to section: String) {
        guard let item = space.items.first(where: { $0.id == key }), let target = space.sections.firstIndex(where: { $0.id == section }) else { return }
        withAnimation(Motion.snappy) {
            removeItem(key)
            space.sections[target].items.append(item)
        }
    }

    private func moveSection(_ id: String, by step: Int) {
        guard let index = space.sections.firstIndex(where: { $0.id == id }), space.sections.indices.contains(index + step) else { return }
        withAnimation(Motion.snappy) { space.sections.swapAt(index, index + step) }
    }

    /// Rows already in the Space stay where they are.
    private func add(_ items: [SpaceItem], to section: String) {
        guard let target = space.sections.firstIndex(where: { $0.id == section }) else { return }
        let fresh = items.filter { !space.contains($0) }
        withAnimation(Motion.snappy) { space.sections[target].items.append(contentsOf: fresh) }
    }

    private func save() async {
        space.name = SpaceRules.clean(space.name)
        let members = starterOf.map { Set([$0]) } ?? Set(env.session.memberships.map(\.id))
        if let problem = SpaceRules.problem(in: space, members: members) {
            Haptics.warning()
            withAnimation(Motion.fade) { self.problem = problem }
            return
        }
        problem = nil
        saving = true
        let failure = if let starterOf {
            await SpacesStore.shared.saveStarter(space, in: starterOf)
        } else {
            await SpacesStore.shared.upsert(space)
        }
        saving = false
        if let failure {
            Haptics.error()
            withAnimation(Motion.fade) { problem = failure }
            return
        }
        Haptics.success()
        if isNew, starterOf == nil { SpacesStore.shared.pick(space.id) }
        dismiss()
    }
}

/// "Add from": a tab per workspace listing what it offers (whole sections, inbox folders, teams,
/// views, mail boxes, accounts and folders, pages). Rows already in the Space are checked.
struct SpaceAddRowsSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    let space: Space
    /// Offers only this workspace's rows (a starter Space), with no Everywhere tab.
    var only: String? = nil
    /// Offers single rows, without whole sections (a section of the member's own sidebar).
    var rowsOnly = false
    let onAdd: ([SpaceItem]) -> Void

    @State private var tab: String = ""
    @State private var chosen: [SpaceItem] = []

    private var store: SpacesStore { .shared }

    var body: some View {
        let builder = SpaceRowBuilder(env: env)
        NavigationStack {
            List {
                if !tabs.isEmpty {
                    Section {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(tabs, id: \.id) { entry in
                                    tabChip(entry.id, title: entry.title, workspace: entry.workspace)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                    .listRowBackground(Color.clear)
                }
                ForEach(catalog(builder), id: \.title) { group in
                    Section(group.title) {
                        ForEach(group.items) { item in
                            choice(item, builder: builder)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.chrome.ignoresSafeArea())
            .navigationTitle("Add rows")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(.confirm, chosen.isEmpty ? "Add" : "Add \(chosen.count)") {
                        onAdd(chosen)
                        dismiss()
                    }
                    .bold()
                    .disabled(chosen.isEmpty)
                }
            }
        }
        .onAppear {
            if tab.isEmpty { tab = only ?? env.session.workspace?.id ?? env.session.memberships.first?.id ?? "" }
        }
        .task(id: tab + "/\(OverviewStore.shared.loaded)") {
            guard !tab.isEmpty, tab != Self.everywhereTab, let collab = builder.collab(tab) else { return }
            store.loadData(for: tab, collab: collab, folders: true)
        }
    }

    private struct Tab {
        var id: String
        var title: String
        var workspace: Workspace?
    }

    /// A tab per workspace, then "Every workspace" for the Everywhere lists.
    private var tabs: [Tab] {
        if only != nil { return [] }
        return env.session.memberships.map { Tab(id: $0.id, title: $0.workspace.name, workspace: $0.workspace) }
            + [Tab(id: Self.everywhereTab, title: "Every workspace", workspace: nil)]
    }

    private static let everywhereTab = "everywhere"

    private func tabChip(_ id: String, title: String, workspace: Workspace?) -> some View {
        let selected = tab == id
        return Button {
            Haptics.selection()
            tab = id
        } label: {
            HStack(spacing: 6) {
                if let workspace { WorkspaceAvatar(workspace: workspace, size: 18) } else { Image(systemName: "globe").font(.system(size: 13)) }
                Text(title).font(ODFont.sans(13.5, weight: selected ? .semibold : .regular)).lineLimit(1)
            }
            .foregroundStyle(selected ? Theme.inverseFg : Theme.fg)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(selected ? Theme.inverse : Theme.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? .clear : Theme.line, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private struct CatalogGroup {
        var title: String
        var items: [SpaceItem]
    }

    /// What the workspace in the tab offers, in the web editor's groups.
    private func catalog(_ builder: SpaceRowBuilder) -> [CatalogGroup] {
        let w = tab
        if w == Self.everywhereTab {
            return [CatalogGroup(title: "Across every workspace", items: EverywhereList.allCases.map { SpaceItem(workspaceID: "", kind: .everywhere, itemID: $0.rawValue) })]
        }
        guard builder.membership(w) != nil else { return [] }
        let tickets = builder.ticketsOn(w)
        let collab = builder.collab(w) == true
        func item(_ kind: SpaceItemKind, _ id: String) -> SpaceItem { SpaceItem(workspaceID: w, kind: kind, itemID: id) }
        var groups: [CatalogGroup] = []
        let sections = ["inbox", "teams", "views", "mail", "pages", "workspace"].filter { id in
            switch id {
            case "inbox", "teams", "views": tickets
            case "mail": collab
            case "pages": builder.pagesOn(w)
            default: true
            }
        }
        if !rowsOnly { groups.append(CatalogGroup(title: "Whole sections, kept up to date", items: sections.map { item(.section, $0) })) }
        if tickets {
            groups.append(CatalogGroup(title: "Inbox folders", items: Folder.allCases.map { item(.ticketFolder, $0.rawValue) }))
            let teams = builder.teams(w)
            if !teams.isEmpty { groups.append(CatalogGroup(title: "Teams", items: teams.map { item(.team, $0.id) })) }
            let views = builder.views(w)
            if !views.isEmpty { groups.append(CatalogGroup(title: "Views", items: views.map { item(.view, $0.id) })) }
            let mailboxes = builder.mailboxes(w)
            if !mailboxes.isEmpty { groups.append(CatalogGroup(title: "Ticket inboxes", items: mailboxes.map { item(.mailbox, $0.id) })) }
        }
        if collab {
            let data = store.data[w]
            var mail = ["inbox", "shared", "assigned"].map { item(.box, $0) }
            mail += (data?.accounts ?? []).map { item(.account, $0.id) }
            groups.append(CatalogGroup(title: "Mail", items: mail))
            let folders = (data?.allFolders ?? []).filter { $0.role == nil }.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            if !folders.isEmpty { groups.append(CatalogGroup(title: "Mail folders and labels", items: folders.map { item(.folder, $0.id) })) }
        }
        let teamspaces = builder.teams(w).filter { builder.teamspace($0.id, in: w) != nil }
        if !teamspaces.isEmpty { groups.append(CatalogGroup(title: "Teamspaces", items: teamspaces.map { item(.wikiSpace, $0.id) })) }
        let pages = builder.pages(w)
        let inPages = pages.filter { $0.area == "pages" }
        if !inPages.isEmpty { groups.append(CatalogGroup(title: "In Pages", items: inPages.map { item(.wikiPage, $0.id) })) }
        let inWiki = pages.filter { $0.area != "pages" }
        if !inWiki.isEmpty { groups.append(CatalogGroup(title: "In the wiki", items: inWiki.map { item(.wikiPage, $0.id) })) }
        let areas = ["contacts", "knowledge", "wiki", "reports"].filter { $0 != "reports" || tickets }
        groups.append(CatalogGroup(title: "Workspace", items: areas.map { item(.page, $0) }))
        return groups
    }

    private func choice(_ item: SpaceItem, builder: SpaceRowBuilder) -> some View {
        let already = space.contains(item)
        let picked = already || chosen.contains { $0.id == item.id }
        let described = builder.describe(item)
        return Button {
            guard !already else { return }
            Haptics.selection()
            if let index = chosen.firstIndex(where: { $0.id == item.id }) { chosen.remove(at: index) } else { chosen.append(item) }
        } label: {
            HStack(spacing: 12) {
                SpaceRowMarkView(mark: described.mark).frame(width: 20)
                Text(described.title).font(ODFont.sans(15)).foregroundStyle(already ? Theme.fg3 : Theme.fg).lineLimit(1)
                Spacer()
                ZStack {
                    Circle().strokeBorder(picked ? Color.clear : Theme.lineStrong, lineWidth: 1.5)
                    if picked {
                        Circle().fill(already ? Theme.fg4 : Theme.inverse)
                        Image(systemName: "checkmark").font(.system(size: 10.5, weight: .bold)).foregroundStyle(Theme.inverseFg)
                    }
                }
                .frame(width: 22, height: 22)
                .motion(Motion.snappy, value: picked)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(picked ? .isSelected : [])
        .accessibilityHint(already ? "Already in this Space" : "")
    }
}
