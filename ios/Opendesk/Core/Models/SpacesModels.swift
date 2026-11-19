import Foundation

// Spaces (contracts/spaces.md): named sidebars of sections and rows from any of the person's
// workspaces, and the overview (contracts/api.md "Several workspaces") that numbers them.

/// A Space's colour (`SpaceColor`), grey when unknown.
enum SpaceColor: String, CaseIterable, Codable, Sendable, Identifiable {
    case grey, blue, violet, teal, green, amber, red, pink

    var id: String { rawValue }

    var tone: Tone {
        switch self {
        case .grey: .gray
        case .blue: .blue
        case .violet: .violet
        case .teal: .teal
        case .green: .green
        case .amber: .amber
        case .red: .red
        case .pink: .pink
        }
    }

    var title: String { rawValue == "grey" ? "Grey" : rawValue.prefix(1).uppercased() + rawValue.dropFirst() }

    /// The colours new Spaces take, in turn (web `NEW_COLORS`).
    static let newOrder: [SpaceColor] = [.blue, .violet, .teal, .green, .amber, .red, .pink, .grey]

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SpaceColor(rawValue: raw) ?? .grey
    }
}

/// What a row names (`SpaceItemKind`). Unknown kinds are kept as written, so a Space saved by a
/// newer app survives an edit here, and skipped where shown.
struct SpaceItemKind: RawRepresentable, Hashable, Codable, Sendable {
    let rawValue: String
    init(rawValue: String) { self.rawValue = rawValue }

    static let section = SpaceItemKind(rawValue: "section")
    static let ticketFolder = SpaceItemKind(rawValue: "ticket_folder")
    static let team = SpaceItemKind(rawValue: "team")
    static let view = SpaceItemKind(rawValue: "view")
    static let box = SpaceItemKind(rawValue: "box")
    static let account = SpaceItemKind(rawValue: "account")
    static let folder = SpaceItemKind(rawValue: "folder")
    static let page = SpaceItemKind(rawValue: "page")
    /// A page of Pages or the wiki.
    static let wikiPage = SpaceItemKind(rawValue: "wiki_page")
    /// A teamspace: a team's pages.
    static let wikiSpace = SpaceItemKind(rawValue: "wiki_space")
    /// A ticket inbox (a helpdesk mailbox): its Unassigned folder.
    static let mailbox = SpaceItemKind(rawValue: "mailbox")
    static let everywhere = SpaceItemKind(rawValue: "everywhere")

    init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

struct SpaceItem: Codable, Hashable, Sendable, Identifiable {
    /// A workspace the person is in; "" for an everywhere row.
    var workspaceID: String
    var kind: SpaceItemKind
    var itemID: String
    /// The person's own label for the row.
    var name: String?
    /// The number beside the row (`SidebarBadge`); nil is the row's default, "none" shows none.
    var badge: String?
    /// One emoji in place of the row's own icon.
    var icon: String?
    /// A whole section only: its rows top to bottom as row keys (`team:<id>`, `box:assigned`); in
    /// Favorites, rows the Space adds (contracts/spaces.md "Arranging a whole section").
    var rows: [String]?
    /// A whole section only: the row keys it does not show in this Space.
    var hidden: [String]?

    enum CodingKeys: String, CodingKey {
        case kind, name, badge, icon, rows, hidden
        case workspaceID = "workspace_id"
        case itemID = "id"
    }

    init(workspaceID: String, kind: SpaceItemKind, itemID: String, name: String? = nil, badge: String? = nil, icon: String? = nil) {
        self.workspaceID = workspaceID
        self.kind = kind
        self.itemID = itemID
        self.name = name
        self.badge = badge
        self.icon = icon
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspaceID = c.lenient(String.self, forKey: .workspaceID) ?? ""
        kind = try c.decode(SpaceItemKind.self, forKey: .kind)
        itemID = try c.decode(String.self, forKey: .itemID)
        name = c.lenient(String.self, forKey: .name).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 }
        badge = c.lenient(String.self, forKey: .badge)
        icon = c.lenient(String.self, forKey: .icon).flatMap { $0.isEmpty ? nil : $0 }
        if kind == .section {
            rows = c.lenient([String].self, forKey: .rows).flatMap { $0.isEmpty ? nil : $0 }
            hidden = c.lenient([String].self, forKey: .hidden).flatMap { $0.isEmpty ? nil : $0 }
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(workspaceID, forKey: .workspaceID)
        try c.encode(kind, forKey: .kind)
        try c.encode(itemID, forKey: .itemID)
        let cleaned = name.map(SpaceRules.clean) ?? ""
        if !cleaned.isEmpty { try c.encode(cleaned, forKey: .name) }
        if let badge { try c.encode(badge, forKey: .badge) }
        if let icon, !icon.isEmpty { try c.encode(icon, forKey: .icon) }
        // Kept as the web editor arranged it, so a save from here never loses it.
        if kind == .section, let rows, !rows.isEmpty { try c.encode(rows, forKey: .rows) }
        if kind == .section, let hidden, !hidden.isEmpty { try c.encode(hidden, forKey: .hidden) }
    }

    /// A whole section's rows as this Space arranges them (contracts/spaces.md "Arranging a whole
    /// section"): its hidden rows left out, in Favorites its own rows first, and in the sections that
    /// keep an order (Tickets, Mail's accounts, Teams, Workspace) its order first, the rest after.
    func arranged(_ entries: [(SpaceItemKind, String)]) -> [(SpaceItemKind, String)] {
        let hidden = Set(self.hidden ?? [])
        let rows = self.rows ?? []
        func key(_ e: (SpaceItemKind, String)) -> String { "\(e.0.rawValue):\(e.1)" }
        if itemID == "favorites" {
            let favoriteKinds: Set<String> = ["box", "folder", "account", "view", "team", "ticket_folder"]
            let added: [(SpaceItemKind, String)] = rows.compactMap { k in
                guard let at = k.firstIndex(of: ":") else { return nil }
                let kind = String(k[..<at])
                let id = String(k[k.index(after: at)...])
                return favoriteKinds.contains(kind) && !id.isEmpty ? (SpaceItemKind(rawValue: kind), id) : nil
            }
            let named = Set(added.map(key))
            return added + entries.filter { !named.contains(key($0)) && !hidden.contains(key($0)) }
        }
        let shown = entries.filter { !hidden.contains(key($0)) }
        guard ["inbox", "mail", "teams", "workspace"].contains(itemID), !rows.isEmpty else { return shown }
        var place: [String: Int] = [:]
        for (i, k) in rows.enumerated() where place[k] == nil { place[k] = i }
        // Mail's boxes keep their place; only its accounts take one.
        let takesPlace = { (e: (SpaceItemKind, String)) -> Bool in itemID != "mail" || e.0 == .account }
        let moving = shown.filter(takesPlace)
        let inOrder = moving.filter { place[key($0)] != nil }.sorted { place[key($0)]! < place[key($1)]! } + moving.filter { place[key($0)] == nil }
        var next = inOrder.makeIterator()
        return shown.map { takesPlace($0) ? (next.next() ?? $0) : $0 }
    }

    /// The one key an item has in a Space: its workspace, kind and id.
    var id: String { "\(workspaceID):\(kind.rawValue):\(itemID)" }

    var isEverywhere: Bool { kind == .everywhere }
    var hidesNumber: Bool { badge == "none" }

    /// Rows that need Collab: its mail and its favorites.
    var needsCollab: Bool {
        kind == .box || kind == .account || kind == .folder || (kind == .section && (itemID == "mail" || itemID == "favorites"))
    }

    /// Rows of tickets, left out where the workspace has Tickets off.
    var needsTickets: Bool {
        kind == .ticketFolder || kind == .team || kind == .view || kind == .mailbox || (kind == .page && itemID == "reports")
            || (kind == .section && ["inbox", "teams", "views"].contains(itemID))
    }
}

struct SpaceSection: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String = ""
    var collapsed = false
    /// One emoji beside the title.
    var icon: String?
    var items: [SpaceItem] = []

    enum CodingKeys: String, CodingKey { case id, title, collapsed, icon, items }

    init(id: String, title: String = "", collapsed: Bool = false, icon: String? = nil, items: [SpaceItem] = []) {
        self.id = id
        self.title = title
        self.collapsed = collapsed
        self.icon = icon
        self.items = items
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.lenient(String.self, forKey: .title) ?? ""
        collapsed = c.lenient(Bool.self, forKey: .collapsed) ?? false
        icon = c.lenient(String.self, forKey: .icon).flatMap { $0.isEmpty ? nil : $0 }
        items = (c.lenient([LenientItem].self, forKey: .items) ?? []).compactMap(\.item)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(SpaceRules.clean(title), forKey: .title)
        try c.encode(collapsed, forKey: .collapsed)
        if let icon, !icon.isEmpty { try c.encode(icon, forKey: .icon) }
        try c.encode(items, forKey: .items)
    }

    /// One malformed row never drops the section.
    private struct LenientItem: Decodable {
        var item: SpaceItem?
        init(from decoder: Decoder) throws { item = try? SpaceItem(from: decoder) }
    }
}

struct Space: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    /// "" (the name's first letter) or one of `SpaceIcon`.
    var icon: String = ""
    var color: SpaceColor = .grey
    /// Another workspace's badge beside its rows.
    var marks = true
    var sections: [SpaceSection] = []

    enum CodingKeys: String, CodingKey { case id, name, icon, color, marks, sections }

    init(id: String = UUID().uuidString.lowercased(), name: String, icon: String = "", color: SpaceColor = .blue, marks: Bool = true, sections: [SpaceSection]) {
        self.id = id
        self.name = name
        self.icon = icon
        self.color = color
        self.marks = marks
        self.sections = sections
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        icon = c.lenient(String.self, forKey: .icon) ?? ""
        color = c.lenient(SpaceColor.self, forKey: .color) ?? .grey
        marks = c.lenient(Bool.self, forKey: .marks) ?? true
        sections = c.lenient([SpaceSection].self, forKey: .sections) ?? []
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(SpaceRules.clean(name), forKey: .name)
        try c.encode(icon, forKey: .icon)
        try c.encode(color, forKey: .color)
        try c.encode(marks, forKey: .marks)
        try c.encode(sections, forKey: .sections)
    }

    var items: [SpaceItem] { sections.flatMap(\.items) }

    func contains(_ item: SpaceItem) -> Bool { items.contains { $0.id == item.id } }
}

/// `GET/PUT /v1/me/spaces`.
struct SpacesList: Codable, Sendable {
    var spaces: [Space]
    var saved: Bool = false

    init(spaces: [Space], saved: Bool = true) {
        self.spaces = spaces
        self.saved = saved
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spaces = c.lenient([Space].self, forKey: .spaces) ?? []
        saved = c.lenient(Bool.self, forKey: .saved) ?? false
    }
}

/// `GET /v1/sidebar/starter`.
struct StarterSpace: Codable, Sendable {
    var space: Space?
}

/// One workspace's sidebar numbers in `GET /v1/me/overview`.
struct WorkspaceOverview: Codable, Hashable, Sendable, Identifiable {
    var id: String
    var name: String
    var slug: String?
    var avatarURL: String?
    var role: Role?
    var suspended = false
    var unreadNotifications = 0
    var ticketCounts: TicketCounts?
    /// Nil while the workspace has no Mail.
    var mailCounts: MailCounts?

    enum CodingKeys: String, CodingKey {
        case id, name, slug, role, suspended
        case avatarURL = "avatar_url"
        case unreadNotifications = "unread_notifications"
        case ticketCounts = "ticket_counts"
        case mailCounts = "mail_counts"
    }

    init(id: String, name: String, slug: String? = nil, avatarURL: String? = nil, role: Role? = nil, suspended: Bool = false, unreadNotifications: Int = 0, ticketCounts: TicketCounts? = nil, mailCounts: MailCounts? = nil) {
        self.id = id
        self.name = name
        self.slug = slug
        self.avatarURL = avatarURL
        self.role = role
        self.suspended = suspended
        self.unreadNotifications = unreadNotifications
        self.ticketCounts = ticketCounts
        self.mailCounts = mailCounts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, forKey: .name) ?? ""
        slug = c.lenient(String.self, forKey: .slug)
        avatarURL = c.lenient(String.self, forKey: .avatarURL)
        role = c.lenient(Role.self, forKey: .role)
        suspended = c.lenient(Bool.self, forKey: .suspended) ?? false
        unreadNotifications = c.lenient(Int.self, forKey: .unreadNotifications) ?? 0
        ticketCounts = c.lenient(TicketCounts.self, forKey: .ticketCounts)
        mailCounts = c.lenient(MailCounts.self, forKey: .mailCounts)
    }
}

struct OverviewList: Codable, Sendable {
    var workspaces: [WorkspaceOverview]
}

/// How the person arranges their workspaces (`GET /v1/me/workspace-prefs`): the hidden ones stay
/// out of the Everywhere lists.
struct WorkspacePrefs: Codable, Sendable {
    var order: [String] = []
    var hidden: [String] = []

    init(order: [String] = [], hidden: [String] = []) {
        self.order = order
        self.hidden = hidden
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        order = c.lenient([String].self, forKey: .order) ?? []
        hidden = c.lenient([String].self, forKey: .hidden) ?? []
    }
}

/// The Everywhere lists (`/everywhere/mine`, `/everywhere/mail`).
enum EverywhereList: String, CaseIterable, Identifiable, Sendable {
    case mine, mail

    var id: String { rawValue }

    var title: String {
        switch self {
        case .mine: "Assigned to me everywhere"
        case .mail: "All mail everywhere"
        }
    }

    var shortTitle: String {
        switch self {
        case .mine: "Assigned to me"
        case .mail: "All mail"
        }
    }

    var symbol: String {
        switch self {
        case .mine: "person.crop.circle.badge.checkmark"
        case .mail: "envelope.open"
        }
    }
}

/// The limits and names of contracts/spaces.md, checked before a save.
enum SpaceRules {
    static let spaces = 20
    static let sections = 20
    static let sectionItems = 60
    static let items = 300
    static let name = 40
    static let title = 40
    static let rowName = 64

    /// The icons a Space can take: the contract's names and the symbols the app draws them with.
    static let icons: [(name: String, symbol: String)] = [
        ("sun", "sun.max"), ("moon", "moon"), ("star", "star"), ("inbox", "tray"), ("mail", "envelope"),
        ("headphones", "headphones"), ("users", "person.2"), ("briefcase", "briefcase"), ("rocket", "paperplane"),
        ("flame", "flame"), ("zap", "bolt"), ("heart", "heart"), ("coffee", "cup.and.saucer"), ("flag", "flag"),
        ("bookmark", "bookmark"), ("layers", "square.3.layers.3d"), ("target", "scope"), ("globe", "globe"),
        ("bell", "bell"), ("leaf", "leaf"), ("home", "house"), ("chart", "chart.bar"), ("shield", "shield"),
        ("sparkles", "sparkles"),
    ]

    static func symbol(for icon: String) -> String? { icons.first { $0.name == icon }?.symbol }

    /// A name as people type it: trimmed, inner runs of space made one.
    static func clean(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// What the API would refuse in one Space, in words; nil when it can be saved.
    static func problem(in space: Space, members: Set<String>) -> String? {
        let name = clean(space.name)
        if name.isEmpty { return "Give the Space a name." }
        if name.count > Self.name { return "Keep the name to \(Self.name) characters." }
        if space.sections.count > sections { return "A Space holds at most \(sections) sections." }
        var total = 0
        for section in space.sections {
            if clean(section.title).count > title { return "Keep section titles to \(title) characters." }
            if section.items.count > sectionItems { return "A section holds at most \(sectionItems) rows." }
            total += section.items.count
            for item in section.items {
                if let label = item.name, clean(label).count > rowName { return "Keep row names to \(rowName) characters." }
                if !item.isEverywhere, !members.contains(item.workspaceID) { return "A row belongs to a workspace you're no longer in. Remove it to save." }
            }
        }
        if total > items { return "A Space holds at most \(items) rows." }
        return nil
    }

    /// A section id unique within the Space.
    static func newSectionID(in space: Space?) -> String {
        let taken = Set(space?.sections.map(\.id) ?? [])
        let letters = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        while true {
            let id = "s" + String((0 ..< 8).map { _ in letters.randomElement()! })
            if !taken.contains(id) { return id }
        }
    }

    /// A colour no Space uses yet, else the next in turn.
    static func nextColor(_ list: [Space]) -> SpaceColor {
        let used = Set(list.map(\.color))
        return SpaceColor.newOrder.first { !used.contains($0) } ?? SpaceColor.newOrder[list.count % SpaceColor.newOrder.count]
    }

    /// A name not yet used in the list: "Support", then "Support 2".
    static func uniqueName(_ base: String, in list: [Space]) -> String {
        let names = Set(list.map { clean($0.name).lowercased() })
        let stem = String(clean(base).prefix(name - 3)).isEmpty ? "Space" : String(clean(base).prefix(name - 3))
        if !names.contains(stem.lowercased()) { return stem }
        var n = 2
        while names.contains("\(stem) \(n)".lowercased()) { n += 1 }
        return "\(stem) \(n)"
    }
}
