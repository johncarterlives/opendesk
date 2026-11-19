import SwiftUI

/// Edit sidebar (contracts/collab.md "Edit mode"): every section in the member's order, dragged into
/// place, hidden or shown with its eye, renamed and given an emoji; sections of their own added and
/// deleted; a ticket inbox or team shown as a section; each section's rows arranged on its own page.
/// Changes show here and save together with Save.
struct SidebarEditorSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var draft = SidebarStore.shared.prefs
    @State private var original = SidebarStore.shared.prefs
    @State private var path: [String] = []
    @State private var problem: String?
    @State private var saving = false
    @State private var confirmDiscard = false
    @State private var confirmReset = false
    @State private var newSectionOffered = false
    @State private var newSectionTitle = ""
    /// The arrangement is read: until then nothing can be saved over it.
    @State private var ready = SidebarStore.shared.loaded

    var body: some View {
        let layout = SidebarLayout(env: env, prefs: draft)
        NavigationStack(path: $path) {
            List {
                if !ready {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Reading your sidebar").font(ODFont.sans(15)).foregroundStyle(Theme.fg3)
                        }
                    }
                    .moveDisabled(true)
                }
                Section {
                    ForEach(layout.allSections, id: \.self) { id in
                        sectionRow(id, layout: layout)
                    }
                    .onMove { from, to in
                        var ids = layout.allSections
                        ids.move(fromOffsets: from, toOffset: to)
                        draft.setOrder(ids)
                    }
                } header: {
                    Text("Sections").textCase(nil)
                } footer: {
                    Text("Drag to reorder. Hidden sections stay listed here, so they come back with their eye.")
                }
                Section {
                    Button {
                        Haptics.tap()
                        newSectionTitle = ""
                        newSectionOffered = true
                    } label: {
                        Label("New section", systemImage: "plus.rectangle.on.rectangle")
                    }
                    .disabled(draft.sections.count >= SidebarRules.sections)
                    let mailboxes = layout.builder.mailboxes(layout.workspace).filter { !layout.allSections.contains("mailbox:" + $0.id) }
                    if env.products.tickets, !mailboxes.isEmpty {
                        Menu {
                            ForEach(mailboxes) { mailbox in
                                Button(mailbox.name.isEmpty ? mailbox.email : mailbox.name) { addSection("mailbox:" + mailbox.id, layout: layout) }
                            }
                        } label: {
                            Label("Show a ticket inbox as a section", systemImage: "tray.2")
                        }
                    }
                    let teams = ([InboxScope.myTeams] + layout.myTeams.map(\.id)).filter { !layout.allSections.contains("team:" + $0) }
                    if env.products.tickets, !layout.myTeams.isEmpty, !teams.isEmpty {
                        Menu {
                            ForEach(teams, id: \.self) { team in
                                Button(team == InboxScope.myTeams ? "My teams" : layout.myTeams.first(where: { $0.id == team })?.name ?? "A team") { addSection("team:" + team, layout: layout) }
                            }
                        } label: {
                            Label("Show a team as a section", systemImage: "person.2")
                        }
                    }
                }
                .moveDisabled(true)
                if env.products.tickets {
                    Section {
                        Toggle(isOn: $draft.showWaitingChats) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Waiting chats row").font(ODFont.sans(15)).foregroundStyle(Theme.fg)
                                Text("A red row on top of Inbox while visitors wait in live chat with nobody on it.")
                                    .font(ODFont.footnote)
                                    .foregroundStyle(Theme.fg3)
                            }
                        }
                        .tint(Theme.inverse)
                    }
                    .moveDisabled(true)
                }
                Section {
                    Button(role: .destructive) {
                        confirmReset = true
                    } label: {
                        Label("Reset order and hidden rows", systemImage: "arrow.counterclockwise")
                    }
                } footer: {
                    if let problem {
                        Text(problem).font(ODFont.footnote).foregroundStyle(Tone.red.text)
                    } else {
                        Text("Only you see this arrangement, on every device. Your own sections and favorites stay when you reset.")
                    }
                }
                .moveDisabled(true)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.chrome.ignoresSafeArea())
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Edit sidebar")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in
                SidebarSectionEditor(id: id, draft: $draft, onGone: { path = [] })
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    SheetButton(.cancel, "Cancel") {
                        if draft == original { dismiss() } else { confirmDiscard = true }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(.confirm, "Save", busy: saving) { Task { await save() } }
                        .bold()
                        .disabled(saving || !ready)
                }
            }
        }
        .onAppear { SidebarStore.shared.start(env: env) }
        .onChange(of: SidebarStore.shared.loaded, initial: true) { _, loaded in
            guard loaded, !ready else { return }
            draft = SidebarStore.shared.prefs
            original = draft
            ready = true
        }
        .alert("New section", isPresented: $newSectionOffered) {
            TextField("Section title", text: $newSectionTitle)
            Button("Add") {
                let id = draft.newSection(title: newSectionTitle)
                draft.setOrder(SidebarLayout(env: env, prefs: draft).allSections)
                path = ["custom:" + id]
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Then add rows to it: folders, teams, views, mail, pages, anything the workspace offers.")
        }
        .confirmationDialog("Reset your sidebar?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset", role: .destructive) { withAnimation(Motion.snappy) { draft.reset() } }
        } message: {
            Text("Sections and rows go back to their usual order and every hidden one shows again.")
        }
        .confirmationDialog("Discard your changes?", isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard", role: .destructive) { dismiss() }
        } message: {
            Text("What you changed in your sidebar is not saved.")
        }
    }

    private func sectionRow(_ id: String, layout: SidebarLayout) -> some View {
        let hidden = layout.isHidden(section: id)
        let own = id.hasPrefix("custom:")
        return HStack(spacing: 12) {
            Group {
                if let icon = layout.icon(section: id) {
                    Text(icon).font(.system(size: 16))
                } else {
                    Image(systemName: layout.symbol(section: id)).font(.system(size: 15)).foregroundStyle(Theme.fg3)
                }
            }
            .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(layout.title(section: id)).font(ODFont.sans(15)).foregroundStyle(hidden ? Theme.fg3 : Theme.fg).lineLimit(1)
                Text(caption(id, layout: layout, hidden: hidden)).font(ODFont.footnote).foregroundStyle(Theme.fg3).lineLimit(1)
            }
            Spacer(minLength: 4)
            if !own {
                Button {
                    Haptics.selection()
                    withAnimation(Motion.snappy) { draft.setHidden("section:" + id, !hidden) }
                } label: {
                    Image(systemName: hidden ? "eye.slash" : "eye")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(hidden ? Theme.fg4 : Theme.fg2)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(hidden ? "Show \(layout.title(section: id))" : "Hide \(layout.title(section: id))")
            }
            Button {
                path.append(id)
            } label: {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.fg3)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Arrange \(layout.title(section: id))")
        }
        .opacity(hidden ? 0.7 : 1)
    }

    private func caption(_ id: String, layout: SidebarLayout, hidden: Bool) -> String {
        var parts: [String] = []
        if id.hasPrefix("custom:") {
            parts.append("Your own section")
        } else if id.hasPrefix("mailbox:") {
            parts.append("Ticket inbox")
        } else if id.hasPrefix("team:") {
            parts.append("Team")
        }
        let rows = layout.rows(of: id, hidden: true)
        parts.append(Format.plural(rows.count, "row"))
        if hidden { parts.append("Hidden") }
        return parts.joined(separator: " · ")
    }

    private func addSection(_ entry: String, layout: SidebarLayout) {
        Haptics.tap()
        withAnimation(Motion.snappy) { draft.setOrder(layout.allSections + [entry]) }
    }

    private func save() async {
        if let problem = SidebarRules.problem(in: draft) {
            Haptics.warning()
            withAnimation(Motion.fade) { self.problem = problem }
            return
        }
        problem = nil
        saving = true
        let failure = await SidebarStore.shared.save(draft)
        saving = false
        if let failure {
            Haptics.error()
            withAnimation(Motion.fade) { problem = failure }
            return
        }
        Haptics.success()
        dismiss()
    }
}

/// One section's page in Edit sidebar: its name and icon, and its rows to drag, hide, rename,
/// give an emoji, favorite, move to a section of the member's own or take out.
struct SidebarSectionEditor: View {
    @Environment(AppEnvironment.self) private var env
    let id: String
    @Binding var draft: SidebarPrefs
    /// The section was deleted or put back: the editor goes back to the list.
    var onGone: () -> Void

    @State private var renaming: SidebarTarget?
    @State private var renameText = ""
    @State private var iconFor: SidebarTarget?
    @State private var adding = false
    @State private var confirmDelete = false
    @State private var newSectionFor: SidebarItem?
    @State private var newSectionTitle = ""

    private var own: Bool { id.hasPrefix("custom:") }
    private var ownID: String { String(id.dropFirst(7)) }

    var body: some View {
        let layout = SidebarLayout(env: env, prefs: draft)
        let rows = layout.rows(of: id, hidden: true)
        List {
            Section {
                HStack(spacing: 12) {
                    Button {
                        iconFor = sectionTarget(layout)
                    } label: {
                        Group {
                            if let icon = layout.icon(section: id) {
                                Text(icon).font(.system(size: 22))
                            } else {
                                Image(systemName: "face.smiling").font(.system(size: 18)).foregroundStyle(Theme.fg3)
                            }
                        }
                        .frame(width: 40, height: 40)
                        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.lineSoft, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Change icon")
                    TextField("Name", text: nameBinding(layout), prompt: Text(layout.usualTitle(section: id)).foregroundStyle(Theme.fg4))
                        .font(ODFont.sans(17, weight: .medium))
                        .foregroundStyle(Theme.fg)
                        .submitLabel(.done)
                }
                .padding(.vertical, 4)
                if !own, draft.names["section:" + id] != nil || draft.icons["section:" + id] != nil {
                    Button("Use its usual name and icon") {
                        draft.setName("section:" + id, nil)
                        draft.setIcon("section:" + id, nil)
                    }
                }
            } footer: {
                Text(own ? "Only you see this section." : "Only you see this name. Everyone else keeps the usual one.")
            }
            .moveDisabled(true)
            .deleteDisabled(true)

            Section {
                if rows.isEmpty {
                    Text(own ? "Nothing here yet. Add rows below." : "Nothing to arrange here yet.")
                        .font(ODFont.sans(14.5))
                        .foregroundStyle(Theme.fg3)
                        .moveDisabled(true)
                        .deleteDisabled(true)
                }
                ForEach(rows) { row in
                    rowView(row, layout: layout)
                        .moveDisabled(!layout.canReorder(section: id))
                        .deleteDisabled(!(own || id == "favorites"))
                }
                .onMove { from, to in
                    draft.moveRows(in: id, keys: rows.map(\.key), from: from, to: to)
                }
                .onDelete { offsets in
                    for index in offsets { draft.remove(rows[index].key, from: id) }
                }
                if own || id == "favorites" {
                    Button {
                        Haptics.tap()
                        adding = true
                    } label: {
                        Label("Add rows", systemImage: "plus")
                    }
                    .moveDisabled(true)
                    .deleteDisabled(true)
                }
            } header: {
                Text("Rows").textCase(nil)
            } footer: {
                Text(rowsFooter(layout))
            }

            if own {
                Section {
                    Button(role: .destructive) { confirmDelete = true } label: { Label("Delete section", systemImage: "trash") }
                }
                .moveDisabled(true)
                .deleteDisabled(true)
            } else if SidebarLayout.mailboxID(id) != nil || SidebarLayout.teamID(id) != nil {
                Section {
                    Button {
                        draft.order.removeAll { $0 == id }
                        onGone()
                    } label: {
                        Label(SidebarLayout.mailboxID(id) != nil ? "Back into Tickets" : "Back into Teams", systemImage: "arrow.uturn.left")
                    }
                } footer: {
                    Text("It stays where it always is too; this takes away its section of its own.")
                }
                .moveDisabled(true)
                .deleteDisabled(true)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.chrome.ignoresSafeArea())
        .environment(\.editMode, .constant(.active))
        .navigationTitle(layout.title(section: id))
        .navigationBarTitleDisplayMode(.inline)
        .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField(renaming?.usual ?? "Name", text: $renameText)
            Button("Save") {
                if let target = renaming { draft.rename(target, to: renameText) }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        } message: {
            Text("Only you see this name. Leave it empty for the usual one.")
        }
        .alert("New section", isPresented: Binding(get: { newSectionFor != nil }, set: { if !$0 { newSectionFor = nil } })) {
            TextField("Section title", text: $newSectionTitle)
            Button("Add") {
                if let item = newSectionFor {
                    if own { draft.remove(item.key, from: id) }
                    draft.newSection(title: newSectionTitle, items: [item])
                }
                newSectionFor = nil
            }
            Button("Cancel", role: .cancel) { newSectionFor = nil }
        }
        .confirmationDialog("Delete this section?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                draft.deleteSection(ownID)
                onGone()
            }
        } message: {
            Text("Its rows leave your sidebar. What they open stays where it is.")
        }
        .sheet(item: $iconFor) { target in
            SidebarIconSheet(title: target.title, current: currentIcon(target)) { icon in draft.setIcon(target, icon) }
                .presentationDetents([.medium])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(isPresented: $adding) {
            addRowsSheet
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
    }

    private func sectionTarget(_ layout: SidebarLayout) -> SidebarTarget {
        SidebarTarget(kind: .section(id), title: layout.title(section: id), usual: layout.usualTitle(section: id))
    }

    private func nameBinding(_ layout: SidebarLayout) -> Binding<String> {
        Binding(
            get: { own ? draft.section(ownID)?.title ?? "" : draft.names["section:" + id] ?? "" },
            set: { value in
                if own {
                    draft.update(section: ownID) { $0.title = String(value.prefix(SpaceRules.title)) }
                } else {
                    draft.names["section:" + id] = value.isEmpty ? nil : String(value.prefix(SpaceRules.rowName))
                }
            }
        )
    }

    private func rowsFooter(_ layout: SidebarLayout) -> String {
        if own { return "Drag to reorder. A row sits in one of your sections at a time." }
        switch id {
        case "favorites": return "Drag to reorder. Folders, teams, views, mail boxes, accounts and folders can be favorites."
        case "views": return "Views keep the workspace's order. Hide the ones you don't use."
        case "pages": return "Pages keep the page tree's order, the same for everyone."
        default: return layout.canReorder(section: id) ? "Drag to reorder, and hide with the eye." : "Hide the rows you don't use with the eye."
        }
    }

    private func rowView(_ row: SidebarRow, layout: SidebarLayout) -> some View {
        let target = SidebarTarget(kind: .row(key: row.key, section: id), title: row.model.title, usual: row.usualTitle)
        let builtIn = !own && id != "favorites"
        return HStack(spacing: 10) {
            SpaceRowMarkView(mark: row.model.mark).frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.model.title).font(ODFont.sans(15)).foregroundStyle(row.hidden ? Theme.fg3 : Theme.fg).lineLimit(1)
                if row.model.title != row.usualTitle {
                    Text(row.usualTitle).font(ODFont.footnote).foregroundStyle(Theme.fg3).lineLimit(1)
                }
            }
            Spacer(minLength: 4)
            if builtIn {
                Button {
                    Haptics.selection()
                    withAnimation(Motion.snappy) { draft.setHidden(row.key, !row.hidden) }
                } label: {
                    Image(systemName: row.hidden ? "eye.slash" : "eye")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(row.hidden ? Theme.fg4 : Theme.fg2)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(row.hidden ? "Show \(row.model.title)" : "Hide \(row.model.title)")
            }
            Menu {
                Button {
                    renameText = row.model.title
                    renaming = target
                } label: { Label("Rename", systemImage: "pencil") }
                Button { iconFor = target } label: { Label("Change icon", systemImage: "face.smiling") }
                if builtIn, draft.names[row.key] != nil || draft.icons[row.key] != nil {
                    Button {
                        draft.setName(row.key, nil)
                        draft.setIcon(row.key, nil)
                    } label: { Label("Use its usual name and icon", systemImage: "arrow.uturn.backward") }
                }
                if let pin = row.pin, id != "favorites" {
                    let pinned = draft.isPinned(pin.kind, pin.id)
                    Button { draft.setPinned(pin.kind, pin.id, !pinned) } label: {
                        Label(pinned ? "Remove from Favorites" : "Add to Favorites", systemImage: pinned ? "star.slash" : "star")
                    }
                }
                if let item = row.item {
                    Menu {
                        ForEach(draft.sections.filter { "custom:" + $0.id != id }) { section in
                            Button(SpaceRules.clean(section.title).isEmpty ? "Untitled section" : section.title) {
                                withAnimation(Motion.snappy) { draft.add([row.ownSection == nil ? SidebarItem(kind: item.kind, itemID: item.itemID) : item], to: section.id) }
                            }
                        }
                        Button {
                            newSectionTitle = ""
                            newSectionFor = item
                        } label: { Label("New section", systemImage: "plus") }
                    } label: { Label(own ? "Move to a section" : "Add to a section", systemImage: "rectangle.stack.badge.plus") }
                }
                if own || id == "favorites" {
                    Divider()
                    Button(role: .destructive) {
                        withAnimation(Motion.snappy) { draft.remove(row.key, from: id) }
                    } label: { Label(id == "favorites" ? "Remove from Favorites" : "Remove from this section", systemImage: "minus.circle") }
                }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.fg3).frame(width: 32, height: 32)
            }
            .accessibilityLabel("Options for \(row.model.title)")
        }
        .opacity(row.hidden ? 0.7 : 1)
    }

    private func currentIcon(_ target: SidebarTarget) -> String? {
        switch target.kind {
        case let .section(section):
            return section.hasPrefix("custom:") ? draft.section(String(section.dropFirst(7)))?.icon : draft.icon("section:" + section)
        case let .row(key, section):
            if section.hasPrefix("custom:") { return draft.section(String(section.dropFirst(7)))?.items.first { $0.key == key }?.icon }
            return draft.icon(key)
        }
    }

    @ViewBuilder
    private var addRowsSheet: some View {
        let workspace = env.session.workspace?.id ?? ""
        if id == "favorites" {
            let space = Space(id: "favorites", name: "Favorites", sections: [SpaceSection(id: "favorites", items: draft.pinned.map { SpaceItem(workspaceID: workspace, kind: SpaceItemKind(rawValue: $0.kind), itemID: $0.id) })])
            SpaceAddRowsSheet(space: space, only: workspace, rowsOnly: true) { items in
                let pinnable: Set<SpaceItemKind> = [.ticketFolder, .team, .view, .box, .account, .folder]
                for item in items where pinnable.contains(item.kind) { draft.setPinned(item.kind.rawValue, item.itemID, true) }
            }
        } else {
            SpaceAddRowsSheet(space: draft.asSpace(workspace: workspace, section: id), only: workspace, rowsOnly: true) { items in
                let rows = items.filter { $0.kind != .section && $0.kind != .everywhere }.map { SidebarItem(kind: $0.kind, itemID: $0.itemID) }
                draft.add(rows, to: ownID)
            }
        }
    }
}
