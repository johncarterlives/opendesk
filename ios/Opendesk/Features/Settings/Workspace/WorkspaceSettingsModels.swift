import Foundation

// Shapes of the Workspace settings pages (General, Members, Teams, Plan and billing, AI,
// Integrations), from contracts/api.md, teams.md, billing.md, ai.md and integrations.md.
// Decoded leniently, as Core/Models does: a field the server adds or drops never fails a page.

// MARK: - General (`GET /v1/workspace`)

struct WSSnoozePreset: Codable, Hashable, Sendable {
    enum Kind: String, Codable, Sendable, CaseIterable { case hours, days, week }

    var kind: Kind
    var hours: Int?
    var days: Int?
    var time: String?

    static let defaults: [WSSnoozePreset] = [
        WSSnoozePreset(kind: .hours, hours: 1),
        WSSnoozePreset(kind: .hours, hours: 4),
        WSSnoozePreset(kind: .days, days: 1, time: "09:00"),
        WSSnoozePreset(kind: .week, time: "09:00"),
    ]
    static let max = 8

    /// "In 1 hour", "Tomorrow at 09:00", "Next week (Monday) at 09:00".
    var label: String {
        switch kind {
        case .hours: return wsPlural(hours ?? 1, "In 1 hour", "In \(hours ?? 1) hours")
        case .days:
            let day = (days ?? 1) == 1 ? "Tomorrow" : "In \(days ?? 1) days"
            return "\(day) at \(time ?? "09:00")"
        case .week: return "Next week (Monday) at \(time ?? "09:00")"
        }
    }

    /// The same time, whatever the unused fields hold.
    var key: String {
        switch kind {
        case .hours: "h\(hours ?? 0)"
        case .days: "d\(days ?? 0)@\(time ?? "")"
        case .week: "w@\(time ?? "")"
        }
    }

    /// Only the fields its kind uses, as the server stores them.
    var cleaned: WSSnoozePreset {
        switch kind {
        case .hours: WSSnoozePreset(kind: .hours, hours: Swift.min(168, Swift.max(1, hours ?? 1)))
        case .days: WSSnoozePreset(kind: .days, days: Swift.min(365, Swift.max(1, days ?? 1)), time: time ?? "09:00")
        case .week: WSSnoozePreset(kind: .week, time: time ?? "09:00")
        }
    }

    static func same(_ a: [WSSnoozePreset], _ b: [WSSnoozePreset]) -> Bool {
        a.map(\.key) == b.map(\.key)
    }
}

/// Every workspace setting the General page edits, with the server's defaults filled in.
struct WSGeneralValues: Equatable, Sendable {
    var name = ""
    var ticketsEnabled = true
    var mailEnabled = true
    var pagesEnabled = true
    var timezone = "UTC"
    var locale = "en"
    var localeFixed = false
    var helpCenterEnabled = false
    var helpCenterTitle = ""
    var csatEnabled = false
    var undoSendSeconds = 5
    var undoSendChatSeconds = 0
    var snoozePresets = WSSnoozePreset.defaults
    var messageDelete = "own"
    var collabTicketReplies = true
    var collabTicketReplyTo = "address"
    var brandColor = ""
    var gravatar = false
    var domainLogos = true
    var agentOnlineTime = true
    var statusLabels: [String: DisplayOverride] = [:]
    var priorityLabels: [String: DisplayOverride] = [:]
    var sendAndFinishButton = false
    var severityEnabled = true

    var brandColorValid: Bool {
        brandColor.isEmpty || brandColor.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil
    }
}

struct WSWorkspaceInfo: Decodable, Sendable {
    var id: String
    var name: String
    var slug: String
    var avatarURL: String?
    var mailDisabledReason: String?
    var helpCenterLogo: String?
    var helpCenterFavicon: String?
    var autoAssign: String
    var values: WSGeneralValues

    enum CodingKeys: String, CodingKey {
        case id, name, slug, settings, images
        case avatarURL = "avatar_url"
        case mailDisabledReason = "mail_disabled_reason"
    }

    enum SettingsKeys: String, CodingKey {
        case tickets_enabled, mail_enabled, pages_enabled, timezone, locale, locale_fixed, help_center_enabled, help_center_title
        case csat_enabled, undo_send_seconds, undo_send_chat_seconds, snooze_presets, message_delete
        case collab_ticket_replies, collab_ticket_reply_to, brand_color, gravatar, domain_logos, agent_online_time
        case status_labels, priority_labels, send_and_finish_button, severity_enabled, auto_assign
    }

    enum ImageKeys: String, CodingKey {
        case help_center_logo, help_center_favicon
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.lenient(String.self, forKey: .id) ?? ""
        name = c.lenient(String.self, forKey: .name) ?? ""
        slug = c.lenient(String.self, forKey: .slug) ?? ""
        avatarURL = c.lenient(String.self, forKey: .avatarURL)
        mailDisabledReason = c.lenient(String.self, forKey: .mailDisabledReason)
        if let images = try? c.nestedContainer(keyedBy: ImageKeys.self, forKey: .images) {
            helpCenterLogo = images.lenient(String.self, forKey: .help_center_logo)
            helpCenterFavicon = images.lenient(String.self, forKey: .help_center_favicon)
        }
        var v = WSGeneralValues()
        v.name = name
        var assign = "none"
        if let s = try? c.nestedContainer(keyedBy: SettingsKeys.self, forKey: .settings) {
            v.ticketsEnabled = s.lenient(Bool.self, forKey: .tickets_enabled) ?? true
            v.mailEnabled = s.lenient(Bool.self, forKey: .mail_enabled) ?? true
            v.pagesEnabled = s.lenient(Bool.self, forKey: .pages_enabled) ?? true
            v.timezone = s.lenient(String.self, forKey: .timezone) ?? "UTC"
            v.locale = WSLocales.match(s.lenient(String.self, forKey: .locale)) ?? "en"
            v.localeFixed = s.lenient(Bool.self, forKey: .locale_fixed) ?? false
            v.helpCenterEnabled = s.lenient(Bool.self, forKey: .help_center_enabled) ?? false
            v.helpCenterTitle = s.lenient(String.self, forKey: .help_center_title) ?? ""
            v.csatEnabled = s.lenient(Bool.self, forKey: .csat_enabled) ?? false
            v.undoSendSeconds = s.lenient(Int.self, forKey: .undo_send_seconds) ?? 5
            v.undoSendChatSeconds = s.lenient(Int.self, forKey: .undo_send_chat_seconds) ?? 0
            let presets = s.lenient([WSSnoozePreset].self, forKey: .snooze_presets) ?? []
            v.snoozePresets = presets.isEmpty ? WSSnoozePreset.defaults : Array(presets.prefix(WSSnoozePreset.max))
            v.messageDelete = s.lenient(String.self, forKey: .message_delete) ?? "own"
            v.collabTicketReplies = s.lenient(Bool.self, forKey: .collab_ticket_replies) ?? true
            v.collabTicketReplyTo = s.lenient(String.self, forKey: .collab_ticket_reply_to) ?? "address"
            v.brandColor = s.lenient(String.self, forKey: .brand_color) ?? ""
            v.gravatar = s.lenient(Bool.self, forKey: .gravatar) ?? false
            v.domainLogos = s.lenient(Bool.self, forKey: .domain_logos) ?? true
            v.agentOnlineTime = s.lenient(Bool.self, forKey: .agent_online_time) ?? true
            v.statusLabels = s.lenient([String: DisplayOverride].self, forKey: .status_labels) ?? [:]
            v.priorityLabels = s.lenient([String: DisplayOverride].self, forKey: .priority_labels) ?? [:]
            v.sendAndFinishButton = s.lenient(Bool.self, forKey: .send_and_finish_button) ?? false
            v.severityEnabled = s.lenient(Bool.self, forKey: .severity_enabled) ?? true
            assign = s.lenient(String.self, forKey: .auto_assign) ?? "none"
        }
        values = v
        autoAssign = assign
    }

    /// Mail can be switched on here (not off for the instance or the plan).
    var mailUsable: Bool { mailDisabledReason != "instance_disabled" && mailDisabledReason != "plan" }
}

/// The languages customer-facing pages ship in, with their native names (web `i18n` SUPPORTED).
enum WSLocales {
    static let all: [(code: String, name: String)] = [
        ("en", "English"), ("es", "Español"), ("fr", "Français"), ("de", "Deutsch"), ("pt", "Português"),
        ("it", "Italiano"), ("nl", "Nederlands"), ("pl", "Polski"), ("cs", "Čeština"), ("ja", "日本語"), ("zh-CN", "简体中文"),
        ("ko", "한국어"), ("tr", "Türkçe"), ("az", "Azərbaycan dili"), ("ar", "العربية"),
    ]

    static func name(_ code: String) -> String { all.first { $0.code == code }?.name ?? "English" }

    /// Any BCP 47 tag onto a supported language, or nil.
    static func match(_ tag: String?) -> String? {
        guard let tag, !tag.isEmpty else { return nil }
        let t = tag.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "_", with: "-").lowercased()
        if let exact = all.first(where: { $0.code.lowercased() == t }) { return exact.code }
        let base = String(t.split(separator: "-").first ?? "")
        if base == "zh" { return t.contains("hant") || t.hasSuffix("-tw") || t.hasSuffix("-hk") ? nil : "zh-CN" }
        return all.first { $0.code.lowercased() == base }?.code
    }
}

/// The default brand's help center address (`GET /v1/brands`).
struct WSBrandHelp: Decodable, Sendable {
    var isDefault: Bool
    var url: String

    enum CodingKeys: String, CodingKey { case is_default, help_center }
    enum HelpKeys: String, CodingKey { case url }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isDefault = c.lenient(Bool.self, forKey: .is_default) ?? false
        url = (try? c.nestedContainer(keyedBy: HelpKeys.self, forKey: .help_center))?.lenient(String.self, forKey: .url) ?? ""
    }
}

// MARK: - Members

/// A member as the Members page shows it: `Member` plus when they joined, their own
/// message rule and their profile for customers.
struct WSMember: Decodable, Hashable, Sendable, Identifiable {
    var user: MemberUser
    var role: Role
    var presence: Availability?
    var messageDelete: String?
    var createdAt: Date?
    var profile: MemberProfile

    var id: String { user.id }
    var displayName: String { user.name.isEmpty ? (user.email ?? "Someone") : user.name }

    enum CodingKeys: String, CodingKey {
        case user, role, presence, profile
        case messageDelete = "message_delete"
        case createdAt = "created_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try c.decode(MemberUser.self, forKey: .user)
        role = c.lenient(Role.self, forKey: .role) ?? .viewer
        presence = c.lenient(Availability.self, forKey: .presence)
        messageDelete = c.lenient(String.self, forKey: .messageDelete)
        createdAt = c.lenient(Date.self, forKey: .createdAt)
        profile = c.lenient(MemberProfile.self, forKey: .profile) ?? .empty
    }

    /// The order the web lists members in: owners, admins, agents, viewers, then by name.
    var rank: Int {
        switch role {
        case .owner: 0
        case .admin: 1
        case .agent: 2
        case .viewer: 3
        }
    }
}

struct WSInvitation: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var email: String
    var role: Role
    var expiresAt: Date?
    var createdAt: Date?
    var invitedBy: UserRef?

    enum CodingKeys: String, CodingKey {
        case id, email, role
        case expiresAt = "expires_at"
        case createdAt = "created_at"
        case invitedBy = "invited_by"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        email = c.lenient(String.self, forKey: .email) ?? ""
        role = c.lenient(Role.self, forKey: .role) ?? .agent
        expiresAt = c.lenient(Date.self, forKey: .expiresAt)
        createdAt = c.lenient(Date.self, forKey: .createdAt)
        invitedBy = c.lenient(UserRef.self, forKey: .invitedBy)
    }

    var expired: Bool { (expiresAt ?? .distantFuture) < AppClock.now }
}

/// Which roles each role may hand out, and whom it may manage (web `Members.tsx`).
enum WSMemberRules {
    static func grantable(by me: Role) -> [Role] {
        switch me {
        case .owner: [.admin, .agent, .viewer]
        case .admin: [.agent, .viewer]
        default: []
        }
    }

    static func canManage(me: Role, meID: String, target: WSMember) -> Bool {
        if target.id == meID || target.role == .owner { return false }
        if me == .owner { return true }
        return me == .admin && (target.role == .agent || target.role == .viewer)
    }

    static func hint(_ role: Role) -> String {
        switch role {
        case .owner: "Full control, including deleting the workspace"
        case .admin: "Manages settings, mailboxes and members"
        case .agent: "Works tickets, contacts and articles"
        case .viewer: "Reads everything, changes nothing"
        }
    }

    static func tone(_ role: Role) -> Tone {
        switch role {
        case .owner: .violet
        case .admin: .blue
        case .agent: .green
        case .viewer: .gray
        }
    }

    static func deleteRule(_ rule: String) -> String {
        switch rule {
        case "off": "Deletes no messages"
        case "all": "Deletes any agent\u{2019}s notes and replies"
        default: "Deletes their own notes"
        }
    }
}

// MARK: - Teams

enum WSTeamRole: String, Codable, Sendable, CaseIterable, Identifiable {
    case lead, member, observer
    var id: String { rawValue }

    var title: String {
        switch self {
        case .lead: "Lead"
        case .member: "Member"
        case .observer: "Observer"
        }
    }

    var hint: String {
        switch self {
        case .lead: "Manages the team's settings and members, and works its tickets."
        case .member: "Works the team's tickets and gets new ones by assignment."
        case .observer: "Sees the team's tickets and can comment, but is never assigned."
        }
    }

    var tone: Tone {
        switch self {
        case .lead: .violet
        case .member: .blue
        case .observer: .gray
        }
    }
}

struct WSTeamMembership: Codable, Hashable, Sendable {
    var userID: String
    var role: WSTeamRole

    enum CodingKeys: String, CodingKey {
        case userID = "user_id"
        case role
    }

    init(userID: String, role: WSTeamRole) {
        self.userID = userID
        self.role = role
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        userID = try c.decode(String.self, forKey: .userID)
        role = c.lenient(WSTeamRole.self, forKey: .role) ?? .member
    }
}

struct WSTimeRange: Codable, Hashable, Sendable {
    var start: String
    var end: String
}

struct WSHoliday: Codable, Hashable, Sendable {
    var date: String
    var name: String
}

enum WSWeekday: String, CaseIterable, Codable, Sendable, Identifiable {
    case mon, tue, wed, thu, fri, sat, sun
    var id: String { rawValue }

    var title: String {
        switch self {
        case .mon: "Monday"
        case .tue: "Tuesday"
        case .wed: "Wednesday"
        case .thu: "Thursday"
        case .fri: "Friday"
        case .sat: "Saturday"
        case .sun: "Sunday"
        }
    }
}

struct WSHours: Codable, Hashable, Sendable {
    var enabled: Bool
    var timezone: String
    var schedule: [String: [WSTimeRange]]
    var holidays: [WSHoliday]

    init(enabled: Bool, timezone: String, schedule: [String: [WSTimeRange]], holidays: [WSHoliday]) {
        self.enabled = enabled
        self.timezone = timezone
        self.schedule = schedule
        self.holidays = holidays
    }

    enum CodingKeys: String, CodingKey { case enabled, timezone, schedule, holidays }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.lenient(Bool.self, forKey: .enabled) ?? true
        timezone = c.lenient(String.self, forKey: .timezone) ?? "UTC"
        let raw = c.lenient([String: [WSTimeRange]].self, forKey: .schedule) ?? [:]
        var schedule: [String: [WSTimeRange]] = [:]
        for day in WSWeekday.allCases { schedule[day.rawValue] = raw[day.rawValue] ?? [] }
        self.schedule = schedule
        holidays = c.lenient([WSHoliday].self, forKey: .holidays) ?? []
    }

    func ranges(_ day: WSWeekday) -> [WSTimeRange] { schedule[day.rawValue] ?? [] }

    /// Weekdays 09:00 to 17:00, weekends closed.
    static func standard(timezone: String) -> WSHours {
        var schedule: [String: [WSTimeRange]] = [:]
        for day in WSWeekday.allCases {
            schedule[day.rawValue] = day == .sat || day == .sun ? [] : [WSTimeRange(start: "09:00", end: "17:00")]
        }
        return WSHours(enabled: true, timezone: timezone, schedule: schedule, holidays: [])
    }

    /// A day's ranges run forwards and don't overlap.
    static func problem(_ ranges: [WSTimeRange]) -> String? {
        let sorted = ranges.sorted { $0.start < $1.start }
        for range in sorted where range.end <= range.start { return "Each range must end after it starts." }
        for (a, b) in zip(sorted, sorted.dropFirst()) where b.start < a.end { return "Ranges can't overlap." }
        return nil
    }
}

struct WSTeam: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var description: String
    var color: String
    var isPrivate: Bool
    var members: [WSTeamMembership]
    var memberIDs: [String]
    var signatureHTML: String
    var businessHours: WSHours?
    var assignMode: String?
    var mailboxIDs: [String]
    var openCount: Int
    var unassignedCount: Int

    enum CodingKeys: String, CodingKey {
        case id, name, description, color, members
        case isPrivate = "private"
        case memberIDs = "member_ids"
        case signatureHTML = "signature_html"
        case businessHours = "business_hours"
        case assignMode = "assign_mode"
        case mailboxIDs = "mailbox_ids"
        case openCount = "open_count"
        case unassignedCount = "unassigned_count"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, forKey: .name) ?? ""
        description = c.lenient(String.self, forKey: .description) ?? ""
        color = c.lenient(String.self, forKey: .color) ?? "gray"
        isPrivate = c.lenient(Bool.self, forKey: .isPrivate) ?? false
        members = c.lenient([WSTeamMembership].self, forKey: .members) ?? []
        memberIDs = c.lenient([String].self, forKey: .memberIDs) ?? members.map(\.userID)
        signatureHTML = c.lenient(String.self, forKey: .signatureHTML) ?? ""
        businessHours = c.lenient(WSHours.self, forKey: .businessHours)
        assignMode = c.lenient(String.self, forKey: .assignMode)
        mailboxIDs = c.lenient([String].self, forKey: .mailboxIDs) ?? []
        openCount = c.lenient(Int.self, forKey: .openCount) ?? 0
        unassignedCount = c.lenient(Int.self, forKey: .unassignedCount) ?? 0
    }

    var tone: Tone { Tone(label: color) }
}

/// A mailbox as the Teams pages list it (`GET /v1/mailboxes`).
struct WSMailbox: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var email: String
    var teamID: String?
    var aliases: [String]
    var aliasTeams: [String: String]
    var isPrivate: Bool

    enum CodingKeys: String, CodingKey {
        case id, email, aliases
        case teamID = "team_id"
        case aliasTeams = "alias_teams"
        case isPrivate = "private"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        email = c.lenient(String.self, forKey: .email) ?? ""
        teamID = c.lenient(String.self, forKey: .teamID)
        aliases = c.lenient([String].self, forKey: .aliases) ?? []
        aliasTeams = c.lenient([String: String].self, forKey: .aliasTeams) ?? [:]
        isPrivate = c.lenient(Bool.self, forKey: .isPrivate) ?? false
    }
}

enum WSAssignModes {
    static let all = ["none", "round_robin", "load_balanced"]

    static func title(_ mode: String) -> String {
        switch mode {
        case "round_robin": "Round robin"
        case "load_balanced": "Load balanced"
        default: "Off"
        }
    }

    static func hint(_ mode: String) -> String {
        switch mode {
        case "round_robin": "Online teammates take turns."
        case "load_balanced": "New tickets go to whoever has the fewest open."
        default: "New tickets wait in Unassigned until someone takes them."
        }
    }
}

/// The colours a team, label or override can take (`LabelColor`).
enum WSColors {
    static let all: [String] = ["gray", "red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "purple", "pink", "rose"]
}

// MARK: - Plan and billing

struct WSBilling: Decodable, Sendable {
    struct AI: Decodable, Sendable {
        var unlimited = false
        var monthlyUSD = 0.0
        var usedUSD = 0.0
        var purchasedUSD = 0.0
        var remainingUSD = 0.0
        var periodEnd: Date?

        enum CodingKeys: String, CodingKey {
            case unlimited
            case monthlyUSD = "monthly_usd"
            case usedUSD = "used_usd"
            case purchasedUSD = "purchased_usd"
            case remainingUSD = "remaining_usd"
            case periodEnd = "period_end"
        }

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            unlimited = c.lenient(Bool.self, forKey: .unlimited) ?? false
            monthlyUSD = c.lenient(Double.self, forKey: .monthlyUSD) ?? 0
            usedUSD = c.lenient(Double.self, forKey: .usedUSD) ?? 0
            purchasedUSD = c.lenient(Double.self, forKey: .purchasedUSD) ?? 0
            remainingUSD = c.lenient(Double.self, forKey: .remainingUSD) ?? 0
            periodEnd = c.lenient(Date.self, forKey: .periodEnd)
        }
    }

    struct Collab: Decodable, Sendable {
        var access: String
        var until: Date?
        var enabled: Bool

        enum CodingKeys: String, CodingKey { case access, until, enabled }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            access = c.lenient(String.self, forKey: .access) ?? "none"
            until = c.lenient(Date.self, forKey: .until)
            enabled = c.lenient(Bool.self, forKey: .enabled) ?? false
        }
    }

    var plan: String
    var billingEnabled: Bool
    var status: String
    var seats: Int
    var billedSeats: Int
    var currentPeriodEnd: Date?
    var cancelAtPeriodEnd: Bool
    var maxMailboxes: Int
    var maxMembers: Int
    var usedMailboxes: Int
    var usedMembers: Int
    var ai: AI
    var collab: Collab?
    var lowAtUSD: Double?

    enum CodingKeys: String, CodingKey {
        case plan, status, seats, limits, usage, ai, collab
        case billingEnabled = "billing_enabled"
        case billedSeats = "billed_seats"
        case currentPeriodEnd = "current_period_end"
        case cancelAtPeriodEnd = "cancel_at_period_end"
        case autoRecharge = "auto_recharge"
    }

    enum LimitKeys: String, CodingKey { case max_mailboxes, max_members }
    enum UsageKeys: String, CodingKey { case mailboxes, members }
    enum RechargeKeys: String, CodingKey { case low_at_usd }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        plan = c.lenient(String.self, forKey: .plan) ?? "self_hosted"
        billingEnabled = c.lenient(Bool.self, forKey: .billingEnabled) ?? false
        status = c.lenient(String.self, forKey: .status) ?? "none"
        seats = c.lenient(Int.self, forKey: .seats) ?? 0
        billedSeats = c.lenient(Int.self, forKey: .billedSeats) ?? seats
        currentPeriodEnd = c.lenient(Date.self, forKey: .currentPeriodEnd)
        cancelAtPeriodEnd = c.lenient(Bool.self, forKey: .cancelAtPeriodEnd) ?? false
        let limits = try? c.nestedContainer(keyedBy: LimitKeys.self, forKey: .limits)
        maxMailboxes = limits?.lenient(Int.self, forKey: .max_mailboxes) ?? 0
        maxMembers = limits?.lenient(Int.self, forKey: .max_members) ?? 0
        let usage = try? c.nestedContainer(keyedBy: UsageKeys.self, forKey: .usage)
        usedMailboxes = usage?.lenient(Int.self, forKey: .mailboxes) ?? 0
        usedMembers = usage?.lenient(Int.self, forKey: .members) ?? 0
        ai = c.lenient(AI.self, forKey: .ai) ?? AI()
        collab = c.lenient(Collab.self, forKey: .collab)
        lowAtUSD = (try? c.nestedContainer(keyedBy: RechargeKeys.self, forKey: .autoRecharge))?.lenient(Double.self, forKey: .low_at_usd)
    }

    var selfHosted: Bool { plan == "self_hosted" || !billingEnabled }

    var hasSubscription: Bool {
        guard billingEnabled else { return false }
        if plan == "pro" { return status != "none" }
        return plan == "collab" && ["active", "trialing", "past_due", "unpaid", "incomplete"].contains(status)
    }

    /// Collab given for free by an operator, without a subscription.
    var complimentary: Bool { plan == "collab" && collab?.access == "complimentary" && !hasSubscription }

    struct Limit {
        var limited: Bool
        var used: Int
        var max: Int
        var atLimit: Bool { limited && used >= max }
        var over: Bool { limited && used > max }
    }

    func limit(members: Bool) -> Limit {
        let max = members ? maxMembers : maxMailboxes
        return Limit(limited: max > 0, used: members ? usedMembers : usedMailboxes, max: max)
    }

    /// Below this the AI balance reads as running low: $5, at most a fifth of the allowance, at least $0.05.
    var aiLow: Bool {
        guard !ai.unlimited else { return false }
        let threshold = lowAtUSD ?? Swift.max(0.05, Swift.min(5, ai.monthlyUSD / 5))
        return ai.remainingUSD < threshold
    }
}

struct WSUsage: Decodable, Sendable {
    struct Row: Hashable, Sendable {
        var key: String
        var label: String
        var usd: Double
        var calls: Int
        var ownKey = false
    }

    struct Day: Hashable, Sendable, Identifiable {
        var date: Date
        var usd: Double
        var id: Date { date }
    }

    var totalUSD: Double
    var totalCalls: Int
    var ownKeyCalls: Int
    var byFeature: [Row]
    var byMember: [Row]
    var byModel: [Row]
    var byDay: [Day]

    enum CodingKeys: String, CodingKey {
        case totalUSD = "total_usd"
        case totalCalls = "total_calls"
        case ownKeyCalls = "own_key_calls"
        case byFeature = "by_feature"
        case byMember = "by_member"
        case byModel = "by_model"
        case byDay = "by_day"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalUSD = c.lenient(Double.self, forKey: .totalUSD) ?? 0
        totalCalls = c.lenient(Int.self, forKey: .totalCalls) ?? 0
        ownKeyCalls = c.lenient(Int.self, forKey: .ownKeyCalls) ?? 0
        let features = c.lenient([JSONValue].self, forKey: .byFeature) ?? []
        byFeature = features.map { row in
            let key = row["feature"]?.string ?? "other"
            return Row(key: key, label: WSFeatureNames.billing(key), usd: row["usd"]?.double ?? 0, calls: row["calls"]?.int ?? 0)
        }
        let members = c.lenient([JSONValue].self, forKey: .byMember) ?? []
        byMember = members.map { row in
            let user = row["user"]
            let name = user?["name"]?.string
            return Row(key: user?["id"]?.string ?? "widget", label: name ?? "Chat widget", usd: row["usd"]?.double ?? 0, calls: row["calls"]?.int ?? 0)
        }
        let models = c.lenient([JSONValue].self, forKey: .byModel) ?? []
        byModel = models.map { row in
            let model = row["model"]?.string ?? ""
            let source = row["source"]?.string ?? "instance"
            return Row(key: "\(source):\(model)", label: model == "jev" ? "Decision model" : model, usd: row["usd"]?.double ?? 0, calls: row["calls"]?.int ?? 0, ownKey: source == "own_key")
        }
        let days = c.lenient([JSONValue].self, forKey: .byDay) ?? []
        let parser = DateFormatter()
        parser.locale = Locale(identifier: "en_US_POSIX")
        parser.timeZone = TimeZone(identifier: "UTC")
        parser.dateFormat = "yyyy-MM-dd"
        byDay = days.compactMap { row in
            guard let raw = row["date"]?.string else { return nil }
            let date = parser.date(from: String(raw.prefix(10))) ?? (try? Date.ISO8601FormatStyle().parse(raw))
            return date.map { Day(date: $0, usd: row["usd"]?.double ?? 0) }
        }
    }
}

enum WSFeatureNames {
    /// The name in usage reports (web `billing.features`).
    static func billing(_ key: String) -> String {
        switch key {
        case "summarize": "Summaries"
        case "rewrite": "Rewrites"
        case "translate": "Translations"
        case "triage": "Triage"
        case "decide": "Automation decisions"
        case "answer_check": "Answer checks"
        case "copilot": "Ask about a ticket"
        case "draft_reply": "Draft replies"
        case "answer": "Widget answers"
        case "answer_email": "Email answers"
        case "playground": "Agent playground"
        case "kb_draft": "Article drafts"
        case "assistant": "Assistant"
        case "assistant_peer": "Asking a teammate's Ollie"
        case "procedure": "Procedures run by automations"
        default: "Other"
        }
    }

    /// The name in the AI page's costs table (web `ai.features`).
    static func action(_ key: String) -> String {
        switch key {
        case "summarize": "Summarize a ticket"
        case "rewrite": "Rewrite a draft"
        case "translate": "Translate a message or draft"
        case "triage": "Triage a ticket"
        case "decide": "Ask a yes/no question in an automation"
        case "answer_check": "Check the knowledge base before answering"
        case "copilot": "Ask about a ticket"
        case "draft_reply": "Draft a reply"
        case "answer": "Answer in the chat widget"
        case "answer_email": "Answer email"
        case "playground": "Test the agent in the playground"
        case "kb_draft": "Draft a help article"
        case "assistant": "Assistant messages"
        case "assistant_peer": "Ollie asking a teammate's Ollie"
        case "procedure": "Run a procedure from an automation"
        default: key
        }
    }

    static let costOrder = ["summarize", "rewrite", "translate", "triage", "copilot", "draft_reply", "answer", "kb_draft", "assistant", "assistant_peer", "procedure"]
}

enum WSUSD {
    /// "$4.20", "$0.0135" for amounts under a cent.
    static func format(_ value: Double, precise: Bool = false) -> String {
        let digits = precise && value > 0 && value < 0.01 ? 4 : 2
        return value.formatted(.currency(code: "USD").precision(.fractionLength(digits)).locale(Locale(identifier: "en_US")))
    }
}

// MARK: - AI (`GET /v1/ai/config`)

struct WSAIValues: Codable, Equatable, Sendable {
    var enabled = true
    var autoTriage = false
    var autoSummarize = false
    var widgetAnswers = false
    var assistant = true
    var assistantPeer = false
    var draftTools = true
    var tone = "friendly"
    var replyLanguage = "customer"
    var instructions = ""
    var model = ""
    var fastModel = ""

    enum CodingKeys: String, CodingKey {
        case enabled, assistant, tone, instructions, model
        case autoTriage = "auto_triage"
        case autoSummarize = "auto_summarize"
        case widgetAnswers = "widget_answers"
        case assistantPeer = "assistant_peer"
        case draftTools = "draft_tools"
        case replyLanguage = "reply_language"
        case fastModel = "fast_model"
    }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.lenient(Bool.self, forKey: .enabled) ?? true
        autoTriage = c.lenient(Bool.self, forKey: .autoTriage) ?? false
        autoSummarize = c.lenient(Bool.self, forKey: .autoSummarize) ?? false
        widgetAnswers = c.lenient(Bool.self, forKey: .widgetAnswers) ?? false
        assistant = c.lenient(Bool.self, forKey: .assistant) ?? true
        assistantPeer = c.lenient(Bool.self, forKey: .assistantPeer) ?? false
        draftTools = c.lenient(Bool.self, forKey: .draftTools) ?? true
        tone = c.lenient(String.self, forKey: .tone) ?? "friendly"
        replyLanguage = c.lenient(String.self, forKey: .replyLanguage) ?? "customer"
        instructions = c.lenient(String.self, forKey: .instructions) ?? ""
        model = c.lenient(String.self, forKey: .model) ?? ""
        fastModel = c.lenient(String.self, forKey: .fastModel) ?? ""
    }

    static let presetTones = ["friendly", "professional", "concise"]
    static let toneMax = 200
    static let instructionsMax = 2000
}

struct WSAIConfig: Decodable, Sendable {
    var enabled: Bool
    var provider: String
    var defaultModel: String
    var fastModel: String
    var embeddings: Bool
    var features: WSAIValues
    var assistantAuto: [String]
    var costs: [String: Double]
    var metered: Bool
    var assistantName: String
    var ownKey: Bool

    enum CodingKeys: String, CodingKey {
        case enabled, provider, models, embeddings, features, costs, metered
        case assistantName = "assistant_name"
        case ownKey = "own_key"
    }

    enum ModelKeys: String, CodingKey { case `default`, fast }
    enum FeatureKeys: String, CodingKey { case assistant_auto }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = c.lenient(Bool.self, forKey: .enabled) ?? false
        provider = c.lenient(String.self, forKey: .provider) ?? ""
        let models = try? c.nestedContainer(keyedBy: ModelKeys.self, forKey: .models)
        defaultModel = models?.lenient(String.self, forKey: .default) ?? ""
        fastModel = models?.lenient(String.self, forKey: .fast) ?? ""
        embeddings = c.lenient(Bool.self, forKey: .embeddings) ?? false
        features = c.lenient(WSAIValues.self, forKey: .features) ?? WSAIValues()
        assistantAuto = (try? c.nestedContainer(keyedBy: FeatureKeys.self, forKey: .features))?.lenient([String].self, forKey: .assistant_auto) ?? []
        costs = c.lenient([String: Double].self, forKey: .costs) ?? [:]
        metered = c.lenient(Bool.self, forKey: .metered) ?? false
        assistantName = c.lenient(String.self, forKey: .assistantName).flatMap { $0.isEmpty ? nil : $0 } ?? "Ollie"
        ownKey = c.lenient(Bool.self, forKey: .ownKey) ?? false
    }

    /// "about $0.0135" when each call is charged on what it uses.
    func costText(_ usd: Double) -> String {
        let cost = WSUSD.format(usd, precise: true)
        return metered ? "about \(cost)" : cost
    }
}

/// The built-in changes Ollie may make without asking (contracts/ai.md "Approvals").
enum WSAutoTools {
    static let all = ["update_ticket", "bulk_update_tickets", "add_note", "create_kb_draft", "create_view", "create_automation_draft"]

    static func title(_ tool: String) -> String {
        switch tool {
        case "update_ticket": "Update a ticket"
        case "bulk_update_tickets": "Update several tickets"
        case "add_note": "Add an internal note"
        case "create_kb_draft": "Save a draft article"
        case "create_view": "Save a personal view"
        case "create_automation_draft": "Save an automation, switched off"
        default: tool
        }
    }

    static func hint(_ tool: String) -> String {
        switch tool {
        case "update_ticket": "Assignee, status, priority, labels and fields of one ticket."
        case "bulk_update_tickets": "The same change on up to 50 tickets at once."
        case "add_note": "Notes are seen by the team only."
        case "create_kb_draft": "Drafts stay unpublished until someone publishes them."
        case "create_view": "Saved for the teammate who asked."
        case "create_automation_draft": "Admins only. It stays off until someone turns it on."
        default: ""
        }
    }
}

struct WSModelOption: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var vendor: String
    var typicalReplyUSD: Double?

    enum CodingKeys: String, CodingKey {
        case id, name, vendor
        case typicalReplyUSD = "typical_reply_usd"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, forKey: .name) ?? id
        vendor = c.lenient(String.self, forKey: .vendor) ?? ""
        typicalReplyUSD = c.lenient(Double.self, forKey: .typicalReplyUSD)
    }
}

struct WSModelList: Decodable, Sendable {
    var data: [WSModelOption]
    var defaultID: String
    var fastID: String

    enum CodingKeys: String, CodingKey {
        case data, fast
        case defaultID = "default"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        data = c.lenient([WSModelOption].self, forKey: .data) ?? []
        defaultID = c.lenient(String.self, forKey: .defaultID) ?? ""
        fastID = c.lenient(String.self, forKey: .fast) ?? ""
    }

    func name(_ id: String) -> String { data.first { $0.id == id }?.name ?? id }
}

struct WSProviderKey: Decodable, Hashable, Sendable {
    var kind: String
    var baseURLHost: String
    var last4: String
    var model: String
    var status: String
    var statusAt: Date?
    var createdBy: UserRef?
    var createdAt: Date?
    var updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case kind, last4, model, status
        case baseURLHost = "base_url_host"
        case statusAt = "status_at"
        case createdBy = "created_by"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.lenient(String.self, forKey: .kind) ?? "openrouter"
        baseURLHost = c.lenient(String.self, forKey: .baseURLHost) ?? ""
        last4 = c.lenient(String.self, forKey: .last4) ?? ""
        model = c.lenient(String.self, forKey: .model) ?? ""
        status = c.lenient(String.self, forKey: .status) ?? "ok"
        statusAt = c.lenient(Date.self, forKey: .statusAt)
        createdBy = c.lenient(UserRef.self, forKey: .createdBy)
        createdAt = c.lenient(Date.self, forKey: .createdAt)
        updatedAt = c.lenient(Date.self, forKey: .updatedAt)
    }

    static func providerName(_ kind: String) -> String {
        switch kind {
        case "openai": "OpenAI-compatible"
        case "anthropic": "Anthropic"
        default: "OpenRouter"
        }
    }
}

struct WSProvider: Decodable, Sendable {
    var mode: String
    var instanceProvider: String
    var billing: Bool
    var key: WSProviderKey?

    enum CodingKeys: String, CodingKey {
        case mode, billing, key
        case instanceProvider = "instance_provider"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mode = c.lenient(String.self, forKey: .mode) ?? "instance"
        instanceProvider = c.lenient(String.self, forKey: .instanceProvider) ?? ""
        billing = c.lenient(Bool.self, forKey: .billing) ?? true
        key = c.lenient(WSProviderKey.self, forKey: .key)
    }
}

struct WSProviderTest: Decodable, Sendable {
    var ok: Bool
    var message: String?
    var models: [String]

    enum CodingKeys: String, CodingKey { case ok, message, models }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.lenient(Bool.self, forKey: .ok) ?? false
        message = c.lenient(String.self, forKey: .message)
        models = c.lenient([String].self, forKey: .models) ?? []
    }
}

// MARK: - Integrations

struct WSIntegrationTool: Decodable, Hashable, Sendable, Identifiable {
    var name: String
    var title: String
    var description: String
    var readOnly: Bool
    var readOnlyHint: Bool
    var askFirst: Bool
    var autoRun: Bool
    var enabled: Bool

    var id: String { name }

    enum CodingKeys: String, CodingKey {
        case name, title, description, enabled
        case readOnly = "read_only"
        case readOnlyHint = "read_only_hint"
        case askFirst = "ask_first"
        case autoRun = "auto_run"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        title = c.lenient(String.self, forKey: .title).flatMap { $0.isEmpty ? nil : $0 } ?? name
        description = c.lenient(String.self, forKey: .description) ?? ""
        readOnly = c.lenient(Bool.self, forKey: .readOnly) ?? false
        readOnlyHint = c.lenient(Bool.self, forKey: .readOnlyHint) ?? readOnly
        askFirst = c.lenient(Bool.self, forKey: .askFirst) ?? false
        autoRun = c.lenient(Bool.self, forKey: .autoRun) ?? false
        enabled = c.lenient(Bool.self, forKey: .enabled) ?? true
    }
}

struct WSIntegration: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var provider: String
    var name: String
    var host: String
    var iconURL: String?
    var authType: String
    var status: String
    var enabled: Bool
    var lastError: String
    var tools: [WSIntegrationTool]
    var syncedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, provider, name, host, status, enabled, tools
        case iconURL = "icon_url"
        case authType = "auth_type"
        case lastError = "last_error"
        case syncedAt = "synced_at"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        provider = c.lenient(String.self, forKey: .provider) ?? "custom"
        name = c.lenient(String.self, forKey: .name) ?? ""
        host = c.lenient(String.self, forKey: .host) ?? ""
        iconURL = c.lenient(String.self, forKey: .iconURL)
        authType = c.lenient(String.self, forKey: .authType) ?? "none"
        status = c.lenient(String.self, forKey: .status) ?? "connected"
        enabled = c.lenient(Bool.self, forKey: .enabled) ?? true
        lastError = c.lenient(String.self, forKey: .lastError) ?? ""
        tools = c.lenient([WSIntegrationTool].self, forKey: .tools) ?? []
        syncedAt = c.lenient(Date.self, forKey: .syncedAt)
    }

    /// The pill: Off, Connected, Waiting for sign-in or Not working.
    var state: (title: String, tone: Tone) {
        if !enabled { return ("Off", .gray) }
        switch status {
        case "connected": return ("Connected", .green)
        case "pending": return ("Waiting for sign-in", .amber)
        default: return ("Not working", .red)
        }
    }

    var statusRank: Int {
        switch status {
        case "error": 0
        case "pending": 1
        default: 2
        }
    }

    /// "8 tools, 3 ask first", the error, or the sign-in that waits.
    var summary: String {
        if status == "error", !lastError.isEmpty { return lastError }
        if status == "pending" { return "Finish signing in to use it." }
        let on = tools.filter(\.enabled).count
        let asks = tools.filter { !$0.readOnly && !$0.autoRun && $0.enabled }.count
        let base = wsPlural(on, "1 tool", "\(on) tools")
        return asks > 0 ? "\(base), \(asks) ask first" : base
    }
}

struct WSIntegrationProvider: Decodable, Hashable, Sendable, Identifiable {
    var key: String
    var name: String
    var category: String
    var description: String
    var auth: String
    var tokenHelp: String?
    var tokenURL: String?

    var id: String { key }

    enum CodingKeys: String, CodingKey {
        case key, name, category, description, auth
        case tokenHelp = "token_help"
        case tokenURL = "token_url"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        name = c.lenient(String.self, forKey: .name) ?? key
        category = c.lenient(String.self, forKey: .category) ?? "automation"
        description = c.lenient(String.self, forKey: .description) ?? ""
        auth = c.lenient(String.self, forKey: .auth) ?? "oauth"
        tokenHelp = c.lenient(String.self, forKey: .tokenHelp)
        tokenURL = c.lenient(String.self, forKey: .tokenURL)
    }
}

enum WSCategories {
    static let all = ["issues", "docs", "chat", "crm", "payments", "files", "automation"]

    static func title(_ key: String) -> String {
        switch key {
        case "all": "All"
        case "issues": "Issues"
        case "docs": "Docs"
        case "chat": "Chat"
        case "crm": "CRM"
        case "payments": "Payments"
        case "files": "Files"
        case "automation": "Automation"
        default: key.capitalized
        }
    }

    static func tone(_ provider: String) -> Tone {
        switch provider {
        case "linear", "stripe": .indigo
        case "github", "notion", "square": .gray
        case "atlassian", "intercom", "paypal", "box": .blue
        case "sentry": .purple
        case "asana": .rose
        case "monday": .pink
        case "slack": .violet
        case "close", "shopify": .green
        case "zapier": .orange
        default: .teal
        }
    }
}

/// `{data: [...]}` or a bare array, for the lists that answer without paging.
struct WSList<T: Decodable & Sendable>: Decodable, Sendable {
    var data: [T]

    init(from decoder: Decoder) throws {
        data = try Page<T>(from: decoder).data
    }
}
