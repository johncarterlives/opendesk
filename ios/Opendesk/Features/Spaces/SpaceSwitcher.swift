import SwiftUI

/// The menu sheet's header: what is picked, a Space or the open workspace, with the live dot.
/// Tapping it opens the switcher.
struct SpaceSwitcherButton: View {
    @Environment(AppEnvironment.self) private var env
    let action: () -> Void

    var body: some View {
        let picked = SpacesStore.shared.picked
        Button {
            Haptics.selection()
            action()
        } label: {
            HStack(spacing: 10) {
                if let picked {
                    SpaceMark(picked)
                    Text(picked.name).font(ODFont.sans(16, weight: .semibold)).foregroundStyle(Theme.fg).lineLimit(1)
                } else if let workspace = env.session.workspace?.workspace {
                    WorkspaceAvatar(workspace: workspace, size: 28)
                    Text(workspace.name).font(ODFont.sans(16, weight: .semibold)).foregroundStyle(Theme.fg).lineLimit(1)
                }
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.fg3)
                Spacer()
                RealtimeDot(status: env.realtime.status)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(TapScaleStyle(scale: 0.98))
        .accessibilityLabel(picked.map { "Space \($0.name)" } ?? env.session.workspace?.workspace.name ?? "Workspace")
        .accessibilityHint("Switch Space or workspace")
    }
}

/// Spaces above workspaces (contracts/spaces.md "The switcher"): picking a Space makes it the
/// menu and never switches the workspace; picking a workspace leaves the Space. Each Space has
/// its own menu, and New Space starts one blank, from a workspace's sidebar or from its admins'.
struct SpaceSwitcherSheet: View {
    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    /// Something was picked: the menu sheet behind may close too.
    var onPicked: () -> Void = {}
    /// An Everywhere list opened: the menu sheet behind closes.
    var onLeave: () -> Void = {}

    @State private var editing: SpaceDraft?
    @State private var confirm: AccountConfirm?

    private var store: SpacesStore { .shared }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if env.session.memberships.count > 1 {
                        EverywhereEntries {
                            dismiss()
                            onLeave()
                        }
                    }
                    spacesSection
                    VStack(alignment: .leading, spacing: 8) {
                        SectionLabel(env.session.memberships.count == 1 ? "Workspace" : "Workspaces").padding(.horizontal, 4)
                        workspaces
                    }
                    Text("Spaces are yours alone, the same on every device. Picking one never switches the workspace you work in.")
                        .font(ODFont.footnote)
                        .foregroundStyle(Theme.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 4)
                }
                .padding(20)
            }
            .background(Theme.chrome.ignoresSafeArea())
            .navigationTitle("Switch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { SheetButton(.confirm, "Done") { dismiss() } }
            }
            .refreshable {
                await store.load()
                await OverviewStore.shared.refresh()
            }
        }
        .onAppear {
            store.start(env: env)
            store.loadStarters(env.session.memberships)
        }
        .sheet(item: $editing) { draft in
            SpaceEditorSheet(draft: draft)
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
                .interactiveDismissDisabled()
        }
        .accountConfirm($confirm)
    }

    // MARK: Spaces

    private var spacesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionLabel("Spaces")
                newSpaceMenu
            }
            .padding(.horizontal, 4)
            if !store.loaded {
                Panel { ProgressView().frame(maxWidth: .infinity).padding(.vertical, 16) }
            } else if store.spaces.isEmpty {
                Panel {
                    EmptyState(
                        symbol: "square.stack.3d.up",
                        title: "Make a Space",
                        message: store.error ?? "Gather folders, teams, views and mail from any of your workspaces into one menu of your own.",
                        actionTitle: "New Space"
                    ) { editing = SpaceDraft(space: blank(), isNew: true) }
                }
            } else {
                Panel {
                    ForEach(Array(store.spaces.enumerated()), id: \.element.id) { index, space in
                        if index > 0 { Hairline(inset: 54) }
                        spaceRow(space, index: index)
                    }
                }
            }
        }
    }

    private func spaceRow(_ space: Space, index: Int) -> some View {
        let picked = store.pickedID == space.id
        return HStack(spacing: 0) {
            Button {
                Haptics.selection()
                store.pick(space.id)
                onPicked()
                dismiss()
            } label: {
                HStack(spacing: 12) {
                    SpaceMark(space)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(space.name).font(ODFont.sans(15.5, weight: .medium)).foregroundStyle(Theme.fg).lineLimit(1)
                        Text(summary(space)).font(ODFont.footnote).foregroundStyle(Theme.fg3).lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    if picked {
                        Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.fg)
                    }
                }
                .padding(.leading, 14)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowPressStyle())
            Menu {
                spaceMenu(space, index: index)
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.fg3)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("More for \(space.name)")
        }
        .contextMenu { spaceMenu(space, index: index) }
        .accessibilityAddTraits(picked ? .isSelected : [])
    }

    @ViewBuilder
    private func spaceMenu(_ space: Space, index: Int) -> some View {
        Button { editing = SpaceDraft(space: space, isNew: false) } label: { Label("Edit", systemImage: "pencil") }
        Button { run { await store.duplicate(space.id) } } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
        if index > 0 {
            Button { run { await store.move(space.id, by: -1) } } label: { Label("Move up", systemImage: "arrow.up") }
        }
        if index < store.spaces.count - 1 {
            Button { run { await store.move(space.id, by: 1) } } label: { Label("Move down", systemImage: "arrow.down") }
        }
        Divider()
        Button(role: .destructive) {
            confirm = AccountConfirm(
                title: "Delete \(space.name)?",
                message: "The Space goes away on every device. Its rows stay where they are in each workspace.",
                confirmTitle: "Delete Space"
            ) {
                Haptics.tap()
                if let failure = await store.delete(space.id) { env.toasts.show(failure, kind: .error) }
            }
        } label: { Label("Delete", systemImage: "trash") }
    }

    private var newSpaceMenu: some View {
        Menu {
            Button { editing = SpaceDraft(space: blank(), isNew: true) } label: { Label("Blank Space", systemImage: "square.dashed") }
            Section("Copy a workspace's sidebar") {
                ForEach(env.session.memberships) { membership in
                    Button("Copy of \(membership.workspace.name)'s sidebar") {
                        editing = SpaceDraft(space: sidebarCopy(membership), isNew: true)
                    }
                }
            }
            let starters = env.session.memberships.compactMap { membership in store.starter(of: membership.id).map { (membership, $0) } }
            if !starters.isEmpty {
                Section("From workspace admins") {
                    ForEach(starters, id: \.0.id) { membership, starter in
                        Button("\(starter.name) from \(membership.workspace.name)") {
                            editing = SpaceDraft(space: copy(starter), isNew: true)
                        }
                    }
                }
            }
        } label: {
            Label("New Space", systemImage: "plus")
                .font(ODFont.sans(13, weight: .semibold))
                .foregroundStyle(Theme.fg)
        }
        .disabled(store.spaces.count >= SpaceRules.spaces)
    }

    // MARK: Workspaces

    private var workspaces: some View {
        Panel {
            ForEach(Array(env.session.memberships.enumerated()), id: \.element.id) { index, membership in
                if index > 0 { Hairline(inset: 58) }
                Button {
                    Haptics.selection()
                    store.pick(nil)
                    env.switchWorkspace(to: membership)
                    onPicked()
                    dismiss()
                } label: {
                    HStack(spacing: 12) {
                        WorkspaceAvatar(workspace: membership.workspace, size: 32)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(membership.workspace.name).font(ODFont.sans(15.5, weight: .medium)).foregroundStyle(Theme.fg)
                            Text(workspaceSummary(membership)).font(ODFont.footnote).foregroundStyle(Theme.fg3)
                        }
                        Spacer()
                        if store.picked == nil, membership.id == env.session.workspace?.id {
                            Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.fg)
                        } else if membership.id == env.session.workspace?.id {
                            Text("Open").font(ODFont.caption).foregroundStyle(Theme.fg3)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RowPressStyle())
            }
        }
    }

    private func workspaceSummary(_ membership: Membership) -> String {
        var parts = [membership.role.title]
        if let counts = OverviewStore.shared.overview(membership.id)?.ticketCounts, membership.workspace.ticketsOn, counts.mine > 0 {
            parts.append("\(counts.mine) assigned to you")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: Helpers

    private func summary(_ space: Space) -> String {
        let builder = SpaceRowBuilder(env: env)
        let names = builder.workspaces(in: space).compactMap { id in env.session.memberships.first { $0.id == id }?.workspace.name }
        let rows = space.items.count
        let count = rows == 1 ? "1 row" : "\(rows) rows"
        return names.isEmpty ? count : ([count] + names).joined(separator: " · ")
    }

    private func run(_ change: @escaping @MainActor () async -> String?) {
        Haptics.tap()
        Task {
            if let failure = await change() { env.toasts.show(failure, kind: .error) }
        }
    }

    private func blank() -> Space {
        Space(
            name: SpaceRules.uniqueName("New Space", in: store.spaces),
            color: SpaceRules.nextColor(store.spaces),
            sections: [SpaceSection(id: SpaceRules.newSectionID(in: nil))]
        )
    }

    /// A workspace's own sidebar as a Space: its built-in sections, kept up to date, in its order.
    private func sidebarCopy(_ membership: Membership) -> Space {
        let builder = SpaceRowBuilder(env: env)
        let collab = builder.collab(membership.id) ?? membership.workspace.mailOn
        var ids = SidebarPrefs.builtIn
        if membership.id == env.session.workspace?.id {
            // The open workspace's sections in the member's order, without the hidden ones.
            let prefs = SidebarStore.shared.prefs
            ids = prefs.resolvedOrder { _ in false }.filter { SidebarPrefs.builtIn.contains($0) && !prefs.isHidden("section:" + $0) }
        }
        ids = ids.filter { id in
            switch id {
            case "mail": collab
            case "pages": builder.pagesOn(membership.id)
            default: true
            }
        }
        return Space(
            name: SpaceRules.uniqueName(membership.workspace.name, in: store.spaces),
            color: SpaceRules.nextColor(store.spaces),
            sections: [SpaceSection(id: "main", items: ids.map { SpaceItem(workspaceID: membership.id, kind: .section, itemID: $0) })]
        )
    }

    /// A copy of a starter Space is the person's own: later changes to the starter leave it be.
    private func copy(_ starter: Space) -> Space {
        var space = starter
        space.id = UUID().uuidString.lowercased()
        space.name = SpaceRules.uniqueName(starter.name, in: store.spaces)
        return space
    }
}

/// A Space in the editor, and whether saving adds it.
struct SpaceDraft: Identifiable {
    var space: Space
    var isNew: Bool
    /// The workspace whose starter Space this is (Settings › General), or nil for one of your own.
    var starterOf: String?
    var id: String { space.id }
}
