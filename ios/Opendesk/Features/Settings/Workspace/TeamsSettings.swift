import SwiftUI

/// Settings › Teams: the teams tickets are routed to, with who is on each, and creating one
/// (web `Teams.tsx`). A team's own page edits it (`TeamsSettings.Detail`, web `TeamDetail.tsx`).
struct TeamsSettings: View {
    @Environment(AppEnvironment.self) private var env
    @State private var store = TeamsSettingsStore()
    @State private var creating = false

    private var admin: Bool { env.session.isAdmin }
    private var meID: String { env.session.user?.id ?? "" }

    var body: some View {
        AccountPage(title: "Teams") {
            if store.loaded {
                if !admin { SettingsReadOnlyNote(text: "Only admins can create and edit teams. You can join and leave open teams.") }
                if store.teams.isEmpty {
                    Panel {
                        EmptyState(
                            symbol: "person.3",
                            title: "No teams yet",
                            message: "Teams group people around the tickets they handle, such as Support or Billing. Each gets its own inbox, hours and assignment.",
                            actionTitle: admin ? "New team" : nil,
                            action: admin ? { creating = true } : nil
                        )
                    }
                } else {
                    if admin {
                        Button { creating = true } label: { ButtonLabel(title: "New team", symbol: "plus") }
                            .buttonStyle(InkButtonStyle())
                    }
                    list
                }
            } else if let error = store.error {
                ErrorState(message: error) { Task { await store.loadList() } }
            } else {
                WSLoading(rows: 4)
            }
        }
        .refreshable { await store.loadList() }
        .task {
            store.attach(env.session.api)
            await store.loadList()
        }
        .onChange(of: env.directory.teams) { _, _ in
            Task { await store.loadList() }
        }
        .sheet(isPresented: $creating) {
            WSNewTeamSheet { team in
                store.adopt(team)
                env.router.openSetting(.teams, id: team.id)
            }
            .presentationDetents([.large])
            .presentationCornerRadius(Theme.Radius.sheet)
        }
    }

    private var list: some View {
        let mine = store.teams.filter { $0.memberIDs.contains(meID) }
        let others = store.teams.filter { !$0.memberIDs.contains(meID) }
        return VStack(spacing: 24) {
            if !mine.isEmpty { section("Your teams", mine) }
            if !others.isEmpty { section(mine.isEmpty ? "Teams" : "Other teams", others) }
        }
    }

    private func section(_ title: String, _ teams: [WSTeam]) -> some View {
        AccountSection(title: title) {
            ForEach(Array(teams.enumerated()), id: \.element.id) { index, team in
                if index > 0 { Hairline(inset: 56) }
                SettingsDetailLink(page: .teams, id: team.id) {
                    WSTeamLine(team: team)
                }
            }
        }
    }

    struct Detail: View {
        let id: String

        var body: some View {
            WSTeamDetail(id: id)
        }
    }
}

// MARK: - Store

@MainActor
@Observable
final class TeamsSettingsStore {
    private(set) var teams: [WSTeam] = []
    private(set) var loaded = false
    private(set) var error: String?

    @ObservationIgnored private var api: APIClient?

    func attach(_ api: APIClient) { self.api = api }

    func loadList() async {
        guard let api else { return }
        do {
            let list: WSList<WSTeam> = try await api.get("v1/teams")
            teams = list.data.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            loaded = true
            error = nil
        } catch {
            if !error.isCancellation, !loaded { self.error = error.userMessage }
        }
    }

    func adopt(_ team: WSTeam) {
        teams.removeAll { $0.id == team.id }
        teams.append(team)
        teams.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}

/// One team being viewed or edited.
@MainActor
@Observable
final class TeamDetailStore {
    private(set) var team: WSTeam?
    var draft = WSTeamDraft()
    private(set) var base = WSTeamDraft()
    private(set) var mailboxes: [WSMailbox] = []
    private(set) var workspaceHours: WSHours?
    private(set) var workspaceAssign = "none"
    private(set) var missing = false
    private(set) var error: String?
    private(set) var saving = false

    @ObservationIgnored private var api: APIClient?

    func attach(_ api: APIClient) { self.api = api }

    var dirty: Bool { team != nil && draft != base }

    var problem: String? {
        if draft.name.trimmingCharacters(in: .whitespaces).isEmpty { return "Give the team a name." }
        if draft.ownHours {
            for day in WSWeekday.allCases {
                if let problem = WSHours.problem(draft.hours.ranges(day)) { return "\(day.title): \(problem)" }
            }
        }
        return nil
    }

    func load(id: String) async {
        guard let api else { return }
        do {
            let fresh: WSTeam = try await api.get("v1/teams/\(id)")
            adopt(fresh, keepEdits: dirty)
            error = nil
            missing = false
        } catch let failure as APIError where failure.status == 404 {
            missing = true
        } catch {
            if !error.isCancellation, team == nil { self.error = error.userMessage }
        }
        async let boxes: WSList<WSMailbox>? = try? api.get("v1/mailboxes")
        async let hours: WSHours? = try? api.get("v1/business-hours")
        async let assign: WSAssignMode? = try? api.get("v1/assignment")
        mailboxes = await boxes?.data ?? []
        workspaceHours = await hours
        workspaceAssign = await assign?.mode ?? "none"
    }

    private func adopt(_ fresh: WSTeam, keepEdits: Bool = false) {
        team = fresh
        base = WSTeamDraft(fresh)
        if !keepEdits { draft = base }
    }

    func discard() { draft = base }

    func save() async throws {
        guard let api, let team else { return }
        saving = true
        defer { saving = false }
        var body: [String: JSONValue] = [:]
        let d = draft
        let name = d.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name != base.name { body["name"] = .string(name) }
        if d.description != base.description { body["description"] = .string(d.description.trimmingCharacters(in: .whitespacesAndNewlines)) }
        if d.color != base.color { body["color"] = .string(d.color) }
        if d.isPrivate != base.isPrivate { body["private"] = .bool(d.isPrivate) }
        if d.members != base.members { body["members"] = (try? JSONValue.from(d.members)) ?? .array([]) }
        if d.signature != base.signature {
            body["signature_html"] = .string(d.signature.isEmpty ? "" : HTMLText.html(fromPlain: d.signature))
        }
        if d.ownHours != base.ownHours || (d.ownHours && d.hours != base.hours) {
            body["business_hours"] = d.ownHours ? ((try? JSONValue.from(d.hours)) ?? .null) : .null
        }
        if d.assignMode != base.assignMode { body["assign_mode"] = d.assignMode.isEmpty ? .null : .string(d.assignMode) }
        guard !body.isEmpty else { return }
        let saved: WSTeam = try await api.patch("v1/teams/\(team.id)", body: JSONValue.object(body))
        adopt(saved)
    }

    func join() async throws {
        guard let api, let team else { return }
        let _: EmptyBody = try await api.post("v1/teams/\(team.id)/join")
        await load(id: team.id)
    }

    func leave() async throws {
        guard let api, let team else { return }
        let _: EmptyBody = try await api.post("v1/teams/\(team.id)/leave")
        await load(id: team.id)
    }

    func delete(moveTo: String?) async throws {
        guard let api, let team else { return }
        var request = APIRequest(method: "DELETE", path: "v1/teams/\(team.id)")
        if let moveTo { request.query = [URLQueryItem(name: "move_to", value: moveTo)] }
        let _: EmptyBody = try await api.send(request)
    }
}

private struct WSAssignMode: Decodable, Sendable {
    var mode: String
}

/// The editable parts of a team.
struct WSTeamDraft: Equatable, Sendable {
    var name = ""
    var description = ""
    var color = "blue"
    var isPrivate = false
    var members: [WSTeamMembership] = []
    var signature = ""
    var ownHours = false
    var hours = WSHours.standard(timezone: "UTC")
    /// Empty follows the workspace.
    var assignMode = ""

    init() {}

    init(_ team: WSTeam) {
        name = team.name
        description = team.description
        color = team.color
        isPrivate = team.isPrivate
        members = team.members.isEmpty ? team.memberIDs.map { WSTeamMembership(userID: $0, role: .member) } : team.members
        signature = HTMLText.plain(from: team.signatureHTML)
        ownHours = team.businessHours != nil
        hours = team.businessHours ?? WSHours.standard(timezone: TimeZone.current.identifier)
        assignMode = team.assignMode ?? ""
    }
}

// MARK: - Team page

struct WSTeamDetail: View {
    let id: String

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var store = TeamDetailStore()
    @State private var adding = false
    @State private var pickingZone = false
    @State private var editingDay: WSWeekday?
    @State private var addingHoliday = false
    @State private var deleting = false
    @State private var confirm: AccountConfirm?

    private var admin: Bool { env.session.isAdmin }
    private var meID: String { env.session.user?.id ?? "" }

    var body: some View {
        AccountPage(title: store.team?.name ?? "Team") {
            if let team = store.team {
                if !admin { SettingsReadOnlyNote(text: "Only admins can edit teams.") }
                overview(team)
                general
                membersSection
                privacy
                hoursSection
                assignment
                signature
                addresses(team)
                if admin { danger(team) }
            } else if store.missing {
                EmptyState(symbol: "person.3", title: "This team is gone", message: "It was deleted, or it's a private team you're not on.")
            } else if let error = store.error {
                ErrorState(message: error) { Task { await store.load(id: id) } }
            } else {
                WSLoading(rows: 5)
            }
        }
        .refreshable { await store.load(id: id) }
        .task {
            store.attach(env.session.api)
            await store.load(id: id)
        }
        .onChange(of: env.directory.teams.first { $0.id == id }) { _, team in
            if team == nil, store.team != nil, !deleting { Task { await store.load(id: id) } }
            else if !store.dirty { Task { await store.load(id: id) } }
        }
        .settingsSaveBar(dirty: store.dirty && admin, problem: store.problem, saving: store.saving, canSave: store.problem == nil, save: save) {
            store.discard()
        }
        .sheet(isPresented: $adding) {
            WSAddTeamMembers(existing: Set(store.draft.members.map(\.userID))) { ids in
                store.draft.members += ids.map { WSTeamMembership(userID: $0, role: .member) }
            }
            .presentationDetents([.large])
            .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(isPresented: $pickingZone) {
            WSTimeZonePicker(title: "Timezone", selection: store.draft.hours.timezone) { store.draft.hours.timezone = $0 }
        }
        .sheet(item: $editingDay) { day in
            WSDayHoursSheet(day: day, ranges: Binding(
                get: { store.draft.hours.ranges(day) },
                set: { store.draft.hours.schedule[day.rawValue] = $0 }
            ))
            .presentationDetents([.medium, .large])
            .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(isPresented: $addingHoliday) {
            WSHolidaySheet { holiday in
                store.draft.hours.holidays.removeAll { $0.date == holiday.date }
                store.draft.hours.holidays.append(holiday)
                store.draft.hours.holidays.sort { $0.date < $1.date }
            }
            .presentationDetents([.medium])
            .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(isPresented: $deleting) {
            if let team = store.team {
                WSDeleteTeamSheet(team: team, others: env.directory.teams.filter { $0.id != team.id }) { moveTo in
                    try await store.delete(moveTo: moveTo)
                    env.toasts.show("Team deleted", kind: .success)
                    dismiss()
                }
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(Theme.Radius.sheet)
            }
        }
        .accountConfirm($confirm)
    }

    // MARK: Sections

    private func overview(_ team: WSTeam) -> some View {
        let isMember = team.memberIDs.contains(meID)
        return VStack(spacing: 12) {
            Panel {
                WSSummaryStrip(items: [
                    .init(label: "Members", value: "\(team.memberIDs.count)"),
                    .init(label: "Open", value: "\(team.openCount)", tone: .blue),
                    .init(label: "Unassigned", value: "\(team.unassignedCount)", tone: team.unassignedCount > 0 ? .amber : .gray),
                ])
            }
            HStack(spacing: 10) {
                Button {
                    env.inbox.setScope(.team(team.id, .unassigned))
                    env.router.show(.tickets, [])
                } label: { ButtonLabel(title: "Open inbox", symbol: "tray") }
                    .buttonStyle(OutlineButtonStyle(height: 40))
                if isMember {
                    Button { askLeave(team) } label: { ButtonLabel(title: "Leave team", symbol: "rectangle.portrait.and.arrow.right") }
                        .buttonStyle(OutlineButtonStyle(height: 40))
                        .disabled(!env.session.canWrite)
                } else if !team.isPrivate || admin {
                    Button { Task { await join() } } label: { ButtonLabel(title: "Join team", symbol: "person.badge.plus") }
                        .buttonStyle(OutlineButtonStyle(height: 40))
                        .disabled(!env.session.canWrite)
                }
            }
        }
    }

    private var general: some View {
        AccountSection(title: "General") {
            WSPanelField(label: "Name", text: $store.draft.name, prompt: "Support", disabled: !admin, counter: 60)
            AccountDivider(tiles: false)
            WSPanelField(label: "Description", text: $store.draft.description, prompt: "What this team handles", axis: .vertical, disabled: !admin, counter: 280)
            AccountDivider(tiles: false)
            VStack(alignment: .leading, spacing: 8) {
                Text("Colour").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                WSColorSwatches(value: $store.draft.color, disabled: !admin)
            }
            .padding(14)
        }
    }

    private var membersSection: some View {
        let byID = Dictionary(env.directory.members.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let list = store.draft.members.sorted { a, b in
            let rank: (WSTeamRole) -> Int = { $0 == .lead ? 0 : $0 == .member ? 1 : 2 }
            if rank(a.role) != rank(b.role) { return rank(a.role) < rank(b.role) }
            return (byID[a.userID]?.user.name ?? "").localizedCaseInsensitiveCompare(byID[b.userID]?.user.name ?? "") == .orderedAscending
        }
        return AccountSection(title: "Members", footer: "Leads manage the team's tickets. Members are assigned tickets. Observers see the team's tickets without being assigned any.") {
            if list.isEmpty {
                AccountRow(symbol: "person.3", title: "No one yet", subtitle: "Add people so the team's tickets reach someone.")
            }
            ForEach(Array(list.enumerated()), id: \.element.userID) { index, membership in
                if index > 0 { Hairline(inset: 56) }
                memberRow(membership, member: byID[membership.userID])
            }
            if admin {
                Hairline(inset: 0)
                Button { adding = true } label: {
                    AccountRow(symbol: "plus", tone: .blue, title: "Add people")
                }
                .buttonStyle(RowPressStyle())
            }
        }
    }

    private func memberRow(_ membership: WSTeamMembership, member: Member?) -> some View {
        let name = member?.user.name ?? "Former member"
        return HStack(spacing: 12) {
            Avatar(name: name, url: member?.user.avatarURL, seed: membership.userID, size: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(ODFont.sans(15.5, weight: .medium)).foregroundStyle(Theme.fg).lineLimit(1)
                Text(membership.role.hint).font(ODFont.sans(12.5)).foregroundStyle(Theme.fg3).lineLimit(1)
            }
            Spacer(minLength: 8)
            if admin {
                Menu {
                    Picker("Role", selection: Binding(get: { membership.role }, set: { role in
                        if let index = store.draft.members.firstIndex(where: { $0.userID == membership.userID }) { store.draft.members[index].role = role }
                    })) {
                        ForEach(WSTeamRole.allCases) { role in Text(role.title).tag(role) }
                    }
                    Divider()
                    Button("Remove from team", systemImage: "person.badge.minus", role: .destructive) {
                        store.draft.members.removeAll { $0.userID == membership.userID }
                    }
                } label: {
                    HStack(spacing: 4) {
                        TonePill(text: membership.role.title, tone: membership.role.tone)
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.fg4)
                    }
                }
                .accessibilityLabel("Role for \(name)")
            } else {
                TonePill(text: membership.role.title, tone: membership.role.tone)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var privacy: some View {
        AccountSection(title: "Visibility") {
            AccountToggleRow(
                symbol: "lock", tone: .violet,
                title: "Private team",
                subtitle: store.draft.isPrivate
                    ? "Only the team's members and admins see its tickets. Everyone else gets a not found."
                    : "Everyone in the workspace sees this team's tickets.",
                isOn: Binding(get: { store.draft.isPrivate }, set: { next in askPrivacy(next) }),
                disabled: !admin
            )
        }
    }

    private func askPrivacy(_ next: Bool) {
        confirm = AccountConfirm(
            title: next ? "Make this team private?" : "Open this team to everyone?",
            message: next
                ? "Its tickets disappear for everyone who isn't on the team or an admin, including from their views, search and reports. Takes effect when you save."
                : "Everyone in the workspace will see this team's tickets. Takes effect when you save.",
            confirmTitle: next ? "Make private" : "Make open",
            destructive: false
        ) {
            store.draft.isPrivate = next
        }
    }

    private var hoursSection: some View {
        AccountSection(title: "Business hours", footer: "SLA targets for this team's tickets count only these hours.") {
            VStack(alignment: .leading, spacing: 8) {
                AccountSegmented(options: [false, true], selection: $store.draft.ownHours) { $0 ? "Own hours" : "Workspace hours" }
                    .disabled(!admin)
                    .opacity(admin ? 1 : 0.6)
                if !store.draft.ownHours {
                    Text(workspaceHoursText).font(ODFont.footnote).foregroundStyle(Theme.fg3)
                }
            }
            .padding(14)
            if store.draft.ownHours {
                Hairline(inset: 14)
                Button { pickingZone = true } label: {
                    AccountRow(title: "Timezone") { AccountDisclosure(value: store.draft.hours.timezone.replacingOccurrences(of: "_", with: " ")) }
                }
                .buttonStyle(RowPressStyle())
                .disabled(!admin)
                ForEach(WSWeekday.allCases) { day in
                    Hairline(inset: 14)
                    Button { editingDay = day } label: {
                        AccountRow(title: day.title) {
                            AccountDisclosure(value: Self.rangesText(store.draft.hours.ranges(day)))
                        }
                    }
                    .buttonStyle(RowPressStyle())
                    .disabled(!admin)
                }
                Hairline(inset: 14)
                holidays
            }
        }
    }

    @ViewBuilder
    private var holidays: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Holidays").font(ODFont.sans(15.5)).foregroundStyle(Theme.fg)
                Spacer()
                if admin {
                    Button("Add") { addingHoliday = true }
                        .font(ODFont.sans(14.5, weight: .medium))
                        .foregroundStyle(Tone.blue.text)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            if store.draft.hours.holidays.isEmpty {
                Text("No holidays. On a holiday the team counts as closed all day.")
                    .font(ODFont.footnote)
                    .foregroundStyle(Theme.fg3)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 12)
            }
            ForEach(store.draft.hours.holidays, id: \.date) { holiday in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(holiday.name.isEmpty ? "Holiday" : holiday.name).font(ODFont.sans(14.5)).foregroundStyle(Theme.fg)
                        Text(Self.holidayDate(holiday.date)).font(ODFont.sans(12.5)).foregroundStyle(Theme.fg3)
                    }
                    Spacer()
                    if admin {
                        Button {
                            store.draft.hours.holidays.removeAll { $0.date == holiday.date }
                        } label: {
                            Image(systemName: "minus.circle").foregroundStyle(Tone.red.text)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(holiday.name)")
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
            }
        }
    }

    private var workspaceHoursText: String {
        guard let hours = store.workspaceHours else { return "Uses the workspace's business hours." }
        let open = WSWeekday.allCases.filter { !hours.ranges($0).isEmpty }
        if open.isEmpty { return "Uses the workspace's business hours (\(hours.timezone.replacingOccurrences(of: "_", with: " ")))." }
        let first = hours.ranges(open[0])
        return "Uses the workspace's hours: \(open.count) days a week, \(Self.rangesText(first)) on \(open[0].title), \(hours.timezone.replacingOccurrences(of: "_", with: " "))."
    }

    static func rangesText(_ ranges: [WSTimeRange]) -> String {
        ranges.isEmpty ? "Closed" : ranges.sorted { $0.start < $1.start }.map { "\($0.start) to \($0.end)" }.joined(separator: ", ")
    }

    static func holidayDate(_ raw: String) -> String {
        let parser = DateFormatter()
        parser.calendar = Calendar(identifier: .gregorian)
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(identifier: "UTC")
        parser.dateFormat = "yyyy-MM-dd"
        guard let date = parser.date(from: raw) else { return raw }
        let out = DateFormatter()
        out.timeZone = TimeZone(identifier: "UTC")
        out.dateStyle = .medium
        return out.string(from: date)
    }

    private var assignment: some View {
        let workspace = "Workspace (\(WSAssignModes.title(store.workspaceAssign).lowercased()))"
        return AccountSection(title: "Assignment", footer: WSAssignModes.hint(store.draft.assignMode.isEmpty ? store.workspaceAssign : store.draft.assignMode)) {
            WSMenuRow(
                title: "New tickets",
                options: [""] + WSAssignModes.all,
                selection: $store.draft.assignMode,
                label: { $0.isEmpty ? workspace : WSAssignModes.title($0) },
                disabled: !admin
            )
        }
    }

    private var signature: some View {
        AccountSection(title: "Signature", footer: "Added to replies from this team's addresses when the mailbox uses team signatures.") {
            WSPanelField(label: "Team signature", text: $store.draft.signature, prompt: "The \(store.draft.name.isEmpty ? "Support" : store.draft.name) team", axis: .vertical, disabled: !admin)
        }
    }

    @ViewBuilder
    private func addresses(_ team: WSTeam) -> some View {
        let boxes = store.mailboxes.filter { $0.teamID == team.id || $0.aliasTeams.values.contains(team.id) }
        if !boxes.isEmpty {
            AccountSection(title: "Addresses", footer: "Email to these addresses lands in this team's inbox.") {
                ForEach(Array(boxes.enumerated()), id: \.element.id) { index, box in
                    if index > 0 { AccountDivider() }
                    let aliases = box.aliasTeams.filter { $0.value == team.id }.map(\.key).sorted()
                    SettingsDetailLink(page: .mailboxes, id: box.id) {
                        AccountRow(
                            symbol: "envelope", tone: .indigo,
                            title: box.teamID == team.id ? box.email : (aliases.first ?? box.email),
                            subtitle: box.teamID == team.id ? (aliases.isEmpty ? nil : "Also \(aliases.joined(separator: ", "))") : "Alias of \(box.email)"
                        ) { AccountDisclosure() }
                    }
                }
            }
        }
    }

    private func danger(_ team: WSTeam) -> some View {
        AccountSection {
            Button { deleting = true } label: {
                AccountRow(symbol: "trash", tone: .red, title: "Delete team", subtitle: "Its tickets move to another team or to no team.", titleColor: Tone.red.text)
            }
            .buttonStyle(RowPressStyle())
        }
    }

    // MARK: Actions

    private func save() {
        Task {
            do {
                try await store.save()
                Haptics.success()
                env.toasts.show("Team saved", kind: .success)
            } catch {
                Haptics.error()
                env.toasts.error(error)
            }
        }
    }

    private func join() async {
        do {
            try await store.join()
            Haptics.success()
            env.toasts.show("You joined \(store.team?.name ?? "the team")", kind: .success)
        } catch {
            env.toasts.error(error)
        }
    }

    private func askLeave(_ team: WSTeam) {
        confirm = AccountConfirm(
            title: "Leave \(team.name)?",
            message: team.isPrivate && !admin
                ? "You stop getting its tickets, and as it's private you won't see them anymore."
                : "You stop getting its tickets. You can join again at any time.",
            confirmTitle: "Leave team"
        ) {
            do {
                try await store.leave()
                env.toasts.show("You left \(team.name)", kind: .success)
            } catch {
                env.toasts.error(error)
            }
        }
    }
}

// MARK: - Pieces

/// A team's colour, name, size and open tickets.
struct WSTeamLine: View {
    let team: WSTeam

    var body: some View {
        HStack(spacing: 12) {
            WSTeamTile(color: team.color)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(team.name).font(ODFont.sans(15.5, weight: .medium)).foregroundStyle(Theme.fg).lineLimit(1)
                    if team.isPrivate {
                        Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(Theme.fg4).accessibilityLabel("Private")
                    }
                }
                Text(line).font(ODFont.sans(13)).foregroundStyle(Theme.fg3).lineLimit(1)
            }
            Spacer(minLength: 8)
            if team.unassignedCount > 0 {
                TonePill(text: "\(team.unassignedCount) unassigned", tone: .amber)
            }
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.fg4)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private var line: String {
        var parts = [wsPlural(team.memberIDs.count, "1 member", "\(team.memberIDs.count) members")]
        parts.append("\(team.openCount) open")
        if !team.description.isEmpty { parts.append(team.description) }
        return parts.joined(separator: " \u{00B7} ")
    }
}

/// Creating a team: name, colour, description and whether it's private.
struct WSNewTeamSheet: View {
    let created: (WSTeam) -> Void

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var color = WSColors.all.filter { $0 != "gray" }.randomElement() ?? "blue"
    @State private var isPrivate = false
    @State private var joinIt = true
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                AccountSheetHeader(title: "New team", subtitle: "A team gets its own inbox, hours and assignment.") { dismiss() }
                ODTextField(label: "Name", text: $name, prompt: "Support", submitLabel: .done)
                AccountTextEditor(label: "Description", text: $description, prompt: "What this team handles", minHeight: 70)
                VStack(alignment: .leading, spacing: 8) {
                    Text("Colour").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                    WSColorSwatches(value: $color)
                }
                Panel {
                    VStack(spacing: 0) {
                        AccountToggleRow(title: "Add me to the team", subtitle: "As its lead.", isOn: $joinIt)
                        AccountDivider(tiles: false)
                        AccountToggleRow(title: "Private team", subtitle: "Only its members and admins see its tickets.", isOn: $isPrivate)
                    }
                }
                FormError(text: error)
                Button(action: create) { ButtonLabel(title: "Create team", busy: busy) }
                    .buttonStyle(InkButtonStyle())
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
            }
            .padding(22)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.surface)
    }

    private func create() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            var body: [String: JSONValue] = [
                "name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                "description": .string(description.trimmingCharacters(in: .whitespacesAndNewlines)),
                "color": .string(color),
                "private": .bool(isPrivate),
            ]
            if joinIt, let me = env.session.user?.id {
                body["members"] = .array([.object(["user_id": .string(me), "role": .string("lead")])])
            }
            do {
                let team: WSTeam = try await env.session.api.post("v1/teams", body: JSONValue.object(body))
                Haptics.success()
                env.toasts.show("Team created", kind: .success)
                dismiss()
                created(team)
            } catch {
                Haptics.error()
                self.error = error.userMessage
            }
        }
    }
}

/// Picking workspace members to add to a team.
struct WSAddTeamMembers: View {
    let existing: Set<String>
    let add: ([String]) -> Void

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var picked: Set<String> = []
    @State private var query = ""

    private var candidates: [Member] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        return env.directory.members
            .filter { !existing.contains($0.id) }
            .filter { needle.isEmpty || $0.user.name.lowercased().contains(needle) || ($0.user.email ?? "").lowercased().contains(needle) }
            .sorted { $0.user.name.localizedCaseInsensitiveCompare($1.user.name) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            List {
                if candidates.isEmpty {
                    Text(query.isEmpty ? "Everyone is already on this team." : "No one matches.")
                        .font(ODFont.sans(14.5))
                        .foregroundStyle(Theme.fg3)
                        .listRowBackground(Theme.surface)
                }
                ForEach(candidates) { member in
                    Button {
                        if picked.contains(member.id) { picked.remove(member.id) } else { picked.insert(member.id) }
                        Haptics.selection()
                    } label: {
                        HStack(spacing: 12) {
                            Avatar(name: member.user.name, url: member.user.avatarURL, seed: member.id, size: 30)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(member.user.name).font(ODFont.sans(15.5)).foregroundStyle(Theme.fg)
                                Text(member.role.title).font(ODFont.sans(12.5)).foregroundStyle(Theme.fg3)
                            }
                            Spacer()
                            Image(systemName: picked.contains(member.id) ? "checkmark.circle.fill" : "circle")
                                .font(.system(size: 20))
                                .foregroundStyle(picked.contains(member.id) ? Theme.fg : Theme.fg4)
                        }
                    }
                    .listRowBackground(Theme.surface)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.chrome)
            .searchable(text: $query, prompt: "Search members")
            .navigationTitle("Add people")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(.confirm, picked.isEmpty ? "Add" : "Add \(picked.count)") {
                        add(Array(picked))
                        dismiss()
                    }
                    .disabled(picked.isEmpty)
                }
            }
        }
    }
}

/// One weekday's opening ranges.
struct WSDayHoursSheet: View {
    let day: WSWeekday
    @Binding var ranges: [WSTimeRange]

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if ranges.isEmpty {
                        Text("Closed all day").font(ODFont.sans(15)).foregroundStyle(Theme.fg3)
                    }
                    ForEach(ranges.indices, id: \.self) { index in
                        HStack(spacing: 10) {
                            WSClockPicker(value: Binding(get: { ranges[index].start }, set: { ranges[index].start = $0 }))
                            Text("to").font(ODFont.sans(14)).foregroundStyle(Theme.fg3)
                            WSClockPicker(value: Binding(get: { ranges[index].end }, set: { ranges[index].end = $0 }))
                            Spacer()
                            Button {
                                ranges.remove(at: index)
                            } label: {
                                Image(systemName: "minus.circle.fill").foregroundStyle(Tone.red.solid)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove this range")
                        }
                    }
                } footer: {
                    if let problem = WSHours.problem(ranges) {
                        Text(problem).foregroundStyle(Tone.red.text)
                    } else {
                        Text("Times are in the team's timezone. Add more than one range for a break.")
                    }
                }
                .listRowBackground(Theme.surface)
                Section {
                    Button("Add a range", systemImage: "plus") {
                        let last = ranges.sorted { $0.start < $1.start }.last
                        let start = last.map { Self.later($0.end, by: 60) } ?? "09:00"
                        ranges.append(WSTimeRange(start: start, end: Self.later(start, by: 240)))
                    }
                    if !ranges.isEmpty {
                        Button("Closed all day", systemImage: "moon", role: .destructive) { ranges = [] }
                    }
                }
                .listRowBackground(Theme.surface)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.chrome)
            .navigationTitle(day.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { SheetButton(.confirm, "Done") { dismiss() } }
            }
        }
    }

    /// `HH:MM` moved on by some minutes, no later than 23:59.
    static func later(_ time: String, by minutes: Int) -> String {
        let parts = time.split(separator: ":").compactMap { Int($0) }
        let total = Swift.min(23 * 60 + 59, (parts.first ?? 9) * 60 + (parts.count > 1 ? parts[1] : 0) + minutes)
        return String(format: "%02d:%02d", total / 60, total % 60)
    }
}

/// Adding a holiday: a day and a name.
struct WSHolidaySheet: View {
    let add: (WSHoliday) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var date = Date.now
    @State private var name = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            AccountSheetHeader(title: "Add a holiday", subtitle: "The team counts as closed all day.") { dismiss() }
            ODTextField(label: "Name", text: $name, prompt: "New Year's Day", submitLabel: .done)
            DatePicker("Day", selection: $date, displayedComponents: .date)
                .font(ODFont.sans(15.5))
            Button {
                let calendar = Calendar.current
                let parts = calendar.dateComponents([.year, .month, .day], from: date)
                let raw = String(format: "%04d-%02d-%02d", parts.year ?? 2026, parts.month ?? 1, parts.day ?? 1)
                add(WSHoliday(date: raw, name: name.trimmingCharacters(in: .whitespaces)))
                dismiss()
            } label: { ButtonLabel(title: "Add holiday") }
                .buttonStyle(InkButtonStyle())
            Spacer(minLength: 0)
        }
        .padding(22)
        .background(Theme.surface)
    }
}

/// Deleting a team: where its tickets go, then its name typed out.
struct WSDeleteTeamSheet: View {
    let team: WSTeam
    let others: [Team]
    let delete: (String?) async throws -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var moveTo = ""
    @State private var typed = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                AccountSheetHeader(title: "Delete \(team.name)?", subtitle: "Members stay in the workspace. Rules and views that use this team stop matching it.") { dismiss() }
                Panel {
                    WSMenuRow(
                        title: "Move its tickets to",
                        subtitle: team.openCount > 0 ? wsPlural(team.openCount, "1 open ticket", "\(team.openCount) open tickets") : nil,
                        options: [""] + others.map(\.id),
                        selection: $moveTo,
                        label: { id in id.isEmpty ? "No team" : (others.first { $0.id == id }?.name ?? "Team") }
                    )
                }
                ODTextField(label: "Type \(team.name) to confirm", text: $typed, prompt: team.name, submitLabel: .done)
                FormError(text: error)
                Button(action: run) { ButtonLabel(title: "Delete team", busy: busy) }
                    .buttonStyle(AccountDangerButtonStyle())
                    .disabled(typed.trimmingCharacters(in: .whitespaces) != team.name || busy)
            }
            .padding(22)
        }
        .background(Theme.surface)
    }

    private func run() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await delete(moveTo.isEmpty ? nil : moveTo)
                Haptics.success()
                dismiss()
            } catch {
                Haptics.error()
                self.error = error.userMessage
            }
        }
    }
}
