#if DEBUG
import Foundation

// The Channels group of workspace settings in the demo: mailboxes, phone, support channels,
// the settings of Collab mail accounts, inbox categories, routing, brands and chat widgets.
// Records are kept in the API's own JSON shape, so a patch merges as the server's does.
//
// `GET /v1/mailboxes` and `GET /v1/brands` are answered here only with a `limit` (as the
// settings pages ask); other screens keep the shapes their own areas answer.

typealias DemoChannelObject = [String: JSONValue]

private func channelID(_ kind: Int, _ n: Int) -> String {
    String(format: "0197a0c0-%04x-7000-8000-%012d", kind, n)
}

private enum ChannelKind {
    static let phone = 0x0C41, support = 0x0C42, destination = 0x0C43, rule = 0x0C44
    static let skill = 0x0C45, brand = 0x0C46, widget = 0x0C47, mailbox = 0x0C48
}

private func js(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
private func jn(_ value: Int) -> JSONValue { .number(Double(value)) }
private func jstrs(_ values: [String]) -> JSONValue { .array(values.map(JSONValue.string)) }
private func jago(_ minutes: Double) -> JSONValue { .string(DemoSeed.stamp(DemoSeed.ago(minutes))) }
private func jcond(_ field: String, _ op: String, _ value: String) -> JSONValue {
    .object(["field": .string(field), "op": .string(op), "value": .string(value)])
}

/// `base` with `patch` laid over it; keys in `nested` merge one level down.
private func channelMerge(_ base: DemoChannelObject, _ patch: DemoChannelObject, nested: Set<String> = []) -> DemoChannelObject {
    var out = base
    for (key, value) in patch {
        if nested.contains(key), let inner = value.object {
            out[key] = .object(channelMerge(out[key]?.object ?? [:], inner))
        } else {
            out[key] = value
        }
    }
    return out
}

struct DemoChannelSettings: Sendable {
    var mailboxes: [DemoChannelObject] = []
    var phoneConnections: [DemoChannelObject] = []
    var supportConnections: [DemoChannelObject] = []
    var destinations: [DemoChannelObject] = []
    var deliveries: [DemoChannelObject] = []
    var ollie: [String] = []
    var rules: [DemoChannelObject] = []
    var skills: [DemoChannelObject] = []
    var brands: [DemoChannelObject] = []
    var widgets: [DemoChannelObject] = []
    var workspaceCategories: DemoChannelObject?
    var teamCategories: [DemoChannelObject] = []
    /// What settings read of a Collab account beyond the Mail area's model, by account id.
    var accountExtras: [String: DemoChannelObject] = [:]
    var senderRules: [String: [DemoChannelObject]] = [:]

    static var defaultBrandMargin: String { demoKBID(0x22, 1) }

    static func seed(_ ws: DemoWorkspace) -> DemoChannelSettings {
        var s = DemoChannelSettings()
        if ws.id == DemoSeed.marginID {
            s.seedMargin(ws)
        } else {
            s.seedSmall(ws)
        }
        return s
    }

    // MARK: Seeds

    private static func helpURL(_ ws: DemoWorkspace, slug: String) -> String {
        let base = ws.kb.helpCenter ?? "https://\(ws.workspace.slug ?? "help").opendesk.help"
        guard var parts = URLComponents(string: base), let host = parts.host, let dot = host.firstIndex(of: ".") else { return base }
        parts.host = slug + host[dot...]
        parts.path = ""
        return parts.string ?? base
    }

    private static func defaultBrand(_ ws: DemoWorkspace, color: String) -> DemoChannelObject {
        let slug = ws.workspace.slug ?? "help"
        let url = ws.kb.helpCenter ?? helpURL(ws, slug: slug)
        let help: DemoChannelObject = [
            "enabled": .bool(ws.kb.helpCenter != nil), "title": .string("\(ws.workspace.name) help center"),
            "url": .string(url), "default_url": .string(url), "domain": .null,
        ]
        return [
            "id": .string(demoKBID(0x22, ws.id == DemoSeed.marginID ? 1 : 2)), "name": .string(ws.workspace.name), "slug": .string(slug),
            "is_default": .bool(true), "color": .string(color), "locale": .string("en"), "help_center": .object(help),
            "images": .object(["logo": .null]), "position": jn(0), "updated_at": jago(20 * 1440),
        ]
    }

    private static func mailbox(
        id: String, name: String, email: String, display: String, team: String?, brand: String?,
        inbound: String, outbound: String, config: DemoChannelObject, received: Double, created: Double
    ) -> DemoChannelObject {
        [
            "id": .string(id), "name": .string(name), "email": .string(email), "display_name": .string(display),
            "inbound_kind": .string(inbound), "outbound_kind": .string(outbound), "forwarding_address": .string(""),
            "config": .object(config), "team_id": js(team), "brand_id": js(brand), "aliases": .array([]),
            "alias_teams": .object([:]), "alias_settings": .object([:]), "from_name_format": .string("{agent} at {mailbox}"),
            "trusted_form_senders": .array([]), "bot_id": .null, "private": .bool(false),
            "personal_replies": .object(["enabled": .null, "reply_to": .null, "accounts": .string("any")]),
            "receiving": .string("ok"), "sending": .string("ok"), "signature_html": .string(""),
            "auto_reply_enabled": .bool(false), "auto_reply_subject": .string(""), "auto_reply_html": .string(""),
            "ai_answers": .bool(false), "ai_answers_mode": .string("draft"), "ai_answers_outside_hours": .bool(false),
            "status": .string("active"), "last_error": .string(""), "last_synced_at": jago(1), "last_received_at": jago(received),
            "created_at": jago(created),
        ]
    }

    private static func widgetSettings(color: String, greeting: String, intro: String, title: String) -> DemoChannelObject {
        [
            "enabled": .bool(true), "greeting": .string(greeting), "intro": .string(intro), "chat_welcome": .bool(true),
            "require_email": .bool(false), "allowed_origins": .array([]), "color": .string(color), "theme": .string("auto"),
            "position": .string("right"), "offset_x": jn(20), "offset_y": jn(20), "launcher": .string("icon"),
            "launcher_label": .string(""), "radius": .string("soft"), "title": .string(title), "subtitle": .string("We usually answer within a few minutes"),
            "show_team": .bool(true), "suggestions": .array([]), "sound": .bool(false), "topics": .array([]),
            "offline_message": .string("We're away right now. Leave a message and we'll email you back."),
            "email_follow_up": .bool(true), "attachments": .bool(true), "attachment_types": .array([]),
            "voice_messages": .bool(false), "voice_max_seconds": jn(60),
        ]
    }

    private static func widget(id: String, brand: String, name: String, key: String, team: String?, settings: DemoChannelObject, seen: Double?, position: Int) -> DemoChannelObject {
        [
            "id": .string(id), "brand_id": .string(brand), "name": .string(name), "key": .string(key), "team_id": js(team),
            "bot_id": .null, "settings": .object(settings), "seen_at": seen.map(jago) ?? .null, "secret_available": .bool(false),
            "position": jn(position), "images": .object(["avatar": .null, "launcher": .null]),
        ]
    }

    private mutating func seedMargin(_ ws: DemoWorkspace) {
        let margin = Self.defaultBrandMargin
        let inkwell = channelID(ChannelKind.brand, 1)

        // Brands: the workspace's own, and a second product with its own help center domain.
        brands = [Self.defaultBrand(ws, color: "#4f46e5")]
        brands[0]["default_mailbox_id"] = .string(DemoSeed.supportMailbox)
        let inkDomain: DemoChannelObject = [
            "hostname": .string("help.getinkwell.com"), "status": .string("active"), "problem": .string(""), "checked_at": jago(3 * 60),
            "records": .array([.object(["type": .string("CNAME"), "name": .string("help.getinkwell.com"), "value": .string("custom.opendesk.help"), "ok": .bool(true)])]),
        ]
        let inkDefault = Self.helpURL(ws, slug: "inkwell")
        brands.append([
            "id": .string(inkwell), "name": .string("Inkwell"), "slug": .string("inkwell"), "is_default": .bool(false),
            "color": .string("#0f766e"), "locale": .string("en"),
            "help_center": .object(["enabled": .bool(true), "title": .string("Inkwell help"), "url": .string("https://help.getinkwell.com"), "default_url": .string(inkDefault), "domain": .object(inkDomain)]),
            "images": .object(["logo": .null]), "default_mailbox_id": .string(channelID(ChannelKind.mailbox, 1)), "position": jn(1), "updated_at": jago(4 * 1440),
        ])

        // Mailboxes: Google sign-in reading directly, forwarding with SMTP, and an IMAP one that needs attention.
        var support = Self.mailbox(
            id: DemoSeed.supportMailbox, name: "Support", email: "support@margin.app", display: "Margin Support", team: DemoSeed.support, brand: margin,
            inbound: "google", outbound: "google",
            config: ["oauth_email": .string("support@margin.app"), "oauth_grant": .string("api"), "oauth_client": .string("instance"), "mail_host": .string("google_workspace"), "provider_mark_read": .bool(true), "provider_archive_on_solve": .bool(true), "provider_label": .bool(true)],
            received: 4, created: 240 * 1440
        )
        support["aliases"] = jstrs(["partners@margin.app", "help@margin.app"])
        support["alias_teams"] = .object(["partners@margin.app": .string(DemoSeed.partnerships)])
        support["alias_settings"] = .object([
            "partners@margin.app": .object(["display_name": .string("Margin Partnerships"), "signature_html": .string(""), "brand_id": .null, "send_as": .string("verified"), "send_as_by": .string("google")]),
            "help@margin.app": .object(["display_name": .string(""), "signature_html": .string(""), "brand_id": .null, "send_as": .string("unknown"), "send_as_by": .string("")]),
        ])
        support["provider_send_as"] = .object([
            "readable": .bool(true), "checked_at": jago(2 * 1440),
            "addresses": .array([
                .object(["email": .string("support@margin.app"), "display_name": .string("Margin Support"), "verified": .bool(true)]),
                .object(["email": .string("partners@margin.app"), "display_name": .string("Margin Partnerships"), "verified": .bool(true)]),
            ]),
        ])
        support["signature_html"] = .string("<p>{agent}<br>Margin Support</p>")
        support["ai_answers"] = .bool(true)
        support["trusted_form_senders"] = jstrs(["forms@margin.app"])

        var billing = Self.mailbox(
            id: DemoSeed.billingMailbox, name: "Billing", email: "billing@margin.app", display: "Margin Billing", team: DemoSeed.billing, brand: margin,
            inbound: "forwarding", outbound: "smtp",
            config: ["smtp_host": .string("smtp.fastmail.com"), "smtp_port": jn(465), "smtp_tls": .string("tls"), "smtp_username": .string("billing@margin.app"), "mail_host": .string("fastmail")],
            received: 95, created: 200 * 1440
        )
        billing["forwarding_address"] = .string("billing.k3f9@in.demo.opendesk.invalid")
        billing["last_synced_at"] = .null
        billing["auto_reply_enabled"] = .bool(true)
        billing["auto_reply_subject"] = .string("We got your message about {{ticket.subject}}")
        billing["auto_reply_html"] = .string("<p>Thanks for writing. Billing answers within one business day.</p>")

        var ink = Self.mailbox(
            id: channelID(ChannelKind.mailbox, 1), name: "Inkwell", email: "hello@inkwell.app", display: "Inkwell", team: DemoSeed.support, brand: inkwell,
            inbound: "imap", outbound: "smtp",
            config: ["imap_host": .string("imap.zoho.eu"), "imap_port": jn(993), "imap_tls": .string("tls"), "imap_username": .string("hello@inkwell.app"), "smtp_host": .string("smtp.zoho.eu"), "smtp_port": jn(465), "smtp_tls": .string("tls"), "smtp_username": .string("hello@inkwell.app"), "mail_host": .string("zoho")],
            received: 3 * 1440, created: 90 * 1440
        )
        ink["status"] = .string("error")
        ink["last_error"] = .string("The mail server refused the sign-in: the app password was revoked.")
        ink["last_synced_at"] = jago(26 * 60)
        mailboxes = [support, billing, ink]

        // Chat widgets.
        var site = Self.widgetSettings(color: "#4f46e5", greeting: "Hi, how can we help?", intro: "Ask us anything about Margin.", title: "Margin")
        site["allowed_origins"] = jstrs(["https://margin.app", "https://www.margin.app"])
        site["suggestions"] = jstrs(["How do I export my notes?", "Can I change my plan?", "Is there a mobile app?"])
        site["topics"] = .array([
            .object(["id": .string("topic-billing"), "label": .string("Billing and plans"), "team_id": .string(DemoSeed.billing)]),
            .object(["id": .string("topic-bug"), "label": .string("Report a problem"), "team_id": .string(DemoSeed.support)]),
            .object(["id": .string("topic-partners"), "label": .string("Partnerships"), "team_id": .string(DemoSeed.partnerships)]),
        ])
        var app = Self.widgetSettings(color: "#4f46e5", greeting: "Need a hand?", intro: "We can see your account, so you don't need to explain who you are.", title: "Margin")
        app["launcher"] = .string("label")
        app["launcher_label"] = .string("Help")
        app["require_email"] = .bool(false)
        app["attachment_types"] = jstrs(["images", "documents"])
        let inkSettings = Self.widgetSettings(color: "#0f766e", greeting: "Hello from Inkwell", intro: "Questions about Inkwell? We're here.", title: "Inkwell")
        widgets = [
            Self.widget(id: channelID(ChannelKind.widget, 1), brand: margin, name: "Website", key: "wk_margin_site_4f2a", team: DemoSeed.support, settings: site, seen: 6, position: 0),
            Self.widget(id: channelID(ChannelKind.widget, 2), brand: margin, name: "In the app", key: "wk_margin_app_9c1e", team: DemoSeed.support, settings: app, seen: 2, position: 1),
            Self.widget(id: channelID(ChannelKind.widget, 3), brand: inkwell, name: "Inkwell site", key: "wk_inkwell_7b30", team: DemoSeed.support, settings: inkSettings, seen: nil, position: 0),
        ]

        // Phone.
        phoneConnections = [[
            "id": .string(channelID(ChannelKind.phone, 1)), "provider": .string("aircall"), "name": .string("Support line"),
            "account_name": .string("Margin GmbH"), "status": .string("connected"), "last_error": .string(""),
            "health_status": .string("healthy"), "health_code": .string(""), "health_detail": .string(""),
            "reuse_days": jn(7), "assign_answered": .bool(true), "insight_cards": .bool(true), "last_event_at": jago(38), "webhook_url": .null,
        ]]

        // Support channels: Slack with two channels.
        let slack = channelID(ChannelKind.support, 1)
        supportConnections = [[
            "id": .string(slack), "provider": .string("slack"), "name": .string("Margin HQ"),
            "external_account_id": .string("T04MARGIN"), "external_account_name": .string("Margin HQ"), "external_account_handle": .string("margin-hq"),
            "status": .string("connected"), "last_error": .string(""), "health_status": .string("healthy"), "health_detail": .string(""),
            "webhook_url": .string("https://api.opendesk.sh/v1/support-channels/slack/\(slack)"),
        ]]
        destinations = [
            Self.destination(id: channelID(ChannelKind.destination, 1), connection: slack, team: DemoSeed.support, priority: "urgent", channel: ("C04ESCAL", "support-escalations"), mode: "route", notes: false),
            Self.destination(id: channelID(ChannelKind.destination, 2), connection: slack, team: DemoSeed.billing, priority: nil, channel: ("C04BILL", "billing"), mode: "copy", notes: true),
        ]
        let failures: [(Int, String, Int?, String, Int, String, Double)] = [
            (8812, "message.created", 1072, "delivered", 1, "", 4),
            (8807, "ticket.updated", 1072, "delivered", 1, "", 9),
            (8790, "message.created", 1068, "retrying", 3, "Slack answered ratelimited. Trying again shortly.", 14),
            (8774, "ticket.created", 1078, "delivered", 1, "", 52),
            (8761, "message.created", 1070, "failed", 5, "Slack answered channel_not_found: the bot was removed from the channel.", 3 * 60),
            (8744, "ticket.created", 1065, "delivered", 1, "", 5 * 60),
        ]
        deliveries = failures.map { seq, type, number, status, attempts, error, ago in
            ["event_seq": jn(seq), "event_type": .string(type), "ticket_number": number.map(jn) ?? .null, "status": .string(status),
             "attempts": jn(attempts), "last_error": .string(error), "updated_at": jago(ago)]
        }
        ollie = ["reply", "note", "assign_self", "status"]

        // Skills and routing rules.
        let skillNames = ["SSO and SAML", "Billing disputes", "API and webhooks", "German"]
        skills = skillNames.enumerated().map { index, name in
            ["id": .string(channelID(ChannelKind.skill, index + 1)), "name": .string(name), "archived": .bool(false)]
        }
        rules = [
            Self.rule(1, "Invoices and refunds to Billing", match: "any", [jcond("subject", "contains", "invoice"), jcond("subject", "contains", "refund"), jcond("body", "contains", "charged twice")], team: DemoSeed.billing, skills: [], runs: 214),
            Self.rule(2, "Partner domains to Partnerships", match: "any", [jcond("from_domain", "equals", "northwind.io"), jcond("subject", "contains", "partnership")], team: DemoSeed.partnerships, skills: [], runs: 37),
            Self.rule(3, "Sign-in trouble needs SSO skills", match: "all", [jcond("subject", "contains", "SSO"), jcond("channel", "equals", "email")], team: DemoSeed.support, skills: [channelID(ChannelKind.skill, 1)], runs: 58),
        ]
        var ollieRule = Self.rule(4, "Upset customers to Support", match: "all", [.object(["field": .string("ai_decide"), "op": .string("gt"), "value": .string("0.8"), "question": .string("Is the customer upset or about to cancel?")])], team: DemoSeed.support, skills: [], runs: 0)
        ollieRule["enabled"] = .bool(false)
        rules.append(ollieRule)

        // Inbox categories: the workspace's set, and Billing's own.
        let me = DemoPerson.jonas
        workspaceCategories = [
            "enabled": .bool(true), "locked": .bool(false), "team_id": .null, "team_name": .string(""), "position": jn(0),
            "categories": .array(Self.workspaceCategoryList.map(\.channelJSON)),
            "updated_at": jago(9 * 1440), "updated_by": .object(["id": .string(me.id), "name": .string(me.name)]),
        ]
        teamCategories = [[
            "enabled": .bool(true), "locked": .bool(false), "team_id": .string(DemoSeed.billing), "team_name": .string("Billing"), "position": jn(0),
            "categories": .array([
                MailCategory(key: "primary", name: "Primary", description: "People and everything else", color: "gray"),
                MailCategory(key: "invoices", name: "Invoices", description: "Invoices and receipts from vendors", color: "blue"),
                MailCategory(key: "payment-alerts", name: "Payment alerts", description: "Failed payments and disputes from Stripe", color: "red"),
            ].map(\.channelJSON)),
            "updated_at": jago(5 * 1440), "updated_by": .object(["id": .string(DemoPerson.lea.id), "name": .string(DemoPerson.lea.name)]),
        ]]

        // What settings show of the Collab accounts.
        accountExtras[DemoMail.gmail] = [
            "signature_sync": .string("two_way"), "display_name_sync": .string("two_way"), "created_at": jago(31 * 1440),
            "categories": .object(["ai": .bool(true), "own": .array([]), "sync_status": .string("")]),
        ]
        accountExtras[DemoMail.partners] = [
            "signature_sync": .string("microsoft"), "display_name_sync": .string("microsoft"), "created_at": jago(400 * 1440),
            "categories": .object(["ai": .bool(true), "own": .array([]), "sync_status": .string("")]),
            "history": .object([
                "status": .string("done"), "since": .null, "include_spam_trash": .bool(false),
                "requested_by": .object(["id": .string(DemoPerson.jonas.id), "name": .string(DemoPerson.jonas.name)]),
                "started_at": jago(399 * 1440), "finished_at": jago(398 * 1440), "imported": jn(18240), "present": jn(312),
                "too_large": jn(4), "unreadable": jn(1), "total": jn(18557), "last_error": .string(""),
            ]),
        ]
        senderRules[DemoMail.gmail] = [
            ["id": .string("rule-stripe"), "sender": .string("stripe.com"), "category": .string("updates")],
            ["id": .string("rule-substack"), "sender": .string("substack.com"), "category": .string("newsletters")],
        ]
    }

    /// Lumen Labs, where Maya is an agent: one of each, read only.
    private mutating func seedSmall(_ ws: DemoWorkspace) {
        let brand = demoKBID(0x22, 2)
        let team = ws.teams.first?.id
        brands = [Self.defaultBrand(ws, color: "#ea580c")]
        let local = ws.workspace.slug ?? "help"
        var box = Self.mailbox(
            id: channelID(ChannelKind.mailbox, 101), name: "Help", email: "help@\(local)labs.io", display: ws.workspace.name, team: team, brand: brand,
            inbound: "forwarding", outbound: "system", config: ["mail_host": .string("other")], received: 40, created: 120 * 1440
        )
        box["forwarding_address"] = .string("help-\(local)@in.opendesk.sh")
        mailboxes = [box]
        brands[0]["default_mailbox_id"] = .string(channelID(ChannelKind.mailbox, 101))
        widgets = [Self.widget(id: channelID(ChannelKind.widget, 101), brand: brand, name: "Website", key: "wk_\(local)_site", team: team, settings: Self.widgetSettings(color: "#ea580c", greeting: "Hi there", intro: "Ask the \(ws.workspace.name) team.", title: ws.workspace.name), seen: 30, position: 0)]
    }

    private static func destination(id: String, connection: String, team: String?, priority: String?, channel: (String, String), mode: String, notes: Bool) -> DemoChannelObject {
        [
            "id": .string(id), "connection_id": .string(connection), "team_id": js(team), "priority": js(priority),
            "external_channel_id": .string(channel.0), "external_channel_name": .string(channel.1), "enabled": .bool(true),
            "include_notes": .bool(notes), "message_limit": jn(3500), "mode": .string(mode), "conditions": .array([]),
            "mirror": jstrs(["customer_replies", "agent_replies"]), "ollie_summary": .bool(true), "ollie_warnings": .bool(true),
            "ollie_personality": .string(""), "ollie_length": .string("standard"),
        ]
    }

    private static func rule(_ n: Int, _ name: String, match: String, _ conditions: [JSONValue], team: String, skills: [String], runs: Int) -> DemoChannelObject {
        [
            "id": .string(channelID(ChannelKind.rule, n)), "name": .string(name), "enabled": .bool(true), "position": jn(n - 1),
            "run_count": jn(runs), "match": .string(match), "conditions": .array(conditions), "team_id": .string(team), "skill_ids": jstrs(skills),
        ]
    }

    static let workspaceCategoryList: [MailCategory] = [
        MailCategory(key: "primary", name: "Primary", description: "People and everything else", color: "gray"),
        MailCategory(key: "updates", name: "Updates", description: "Receipts, bills, confirmations and alerts", color: "blue"),
        MailCategory(key: "newsletters", name: "Newsletters", description: "Newsletters and mailing lists", color: "violet"),
        MailCategory(key: "promotions", name: "Promotions", description: "Deals, offers and marketing", color: "amber"),
    ]

    static let presets: [MailCategory] = workspaceCategoryList + [
        MailCategory(key: "social", name: "Social", description: "Social networks and community sites", color: "pink"),
        MailCategory(key: "receipts", name: "Receipts", description: "Orders, invoices and payment confirmations", color: "green"),
        MailCategory(key: "notifications", name: "Notifications", description: "Alerts from tools and services", color: "teal"),
        MailCategory(key: "travel", name: "Travel", description: "Bookings, tickets and itineraries", color: "indigo"),
    ]

    static let gmailCategories: [MailCategory] = [
        MailCategory(key: "primary", name: "Primary", description: "Gmail's Primary tab", color: "gray"),
        MailCategory(key: "social", name: "Social", description: "Gmail's Social tab", color: "pink"),
        MailCategory(key: "promotions", name: "Promotions", description: "Gmail's Promotions tab", color: "amber"),
        MailCategory(key: "updates", name: "Updates", description: "Gmail's Updates tab", color: "blue"),
        MailCategory(key: "forums", name: "Forums", description: "Gmail's Forums tab", color: "teal"),
    ]
}

private extension MailCategory {
    var channelJSON: JSONValue {
        .object(["key": .string(key), "name": .string(name), "description": .string(description), "color": .string(color)])
    }
}

// MARK: - Routes

extension DemoBackend {
    /// The answer (nil inside for 204), or nil when the route isn't this group's.
    func channelSettingsRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        switch call.path.first {
        case "mailboxes": return try channelMailboxRoutes(call, in: &ws)
        case "phone": return try channelPhoneRoutes(call, in: &ws)
        case "support-channels": return try channelSupportRoutes(call, in: &ws)
        case "me":
            guard call.match("POST", "me/support-channel-link-code") != nil else { return nil }
            return .some(encode(JSONValue.object(["code": .string("OD-4F7K-92QX"), "expires_at": .string(DemoSeed.stamp(DemoSeed.ahead(10)))])))
        case "collab": return try channelCollabRoutes(call, in: &ws)
        case "routing-rules", "routing": return try channelRoutingRoutes(call, in: &ws)
        case "skills":
            guard call.match("GET", "skills") != nil else { return nil }
            return .some(channelList(ws.settings.channels.skills))
        case "brands", "widgets": return try channelBrandRoutes(call, in: &ws)
        default: return nil
        }
    }

    // MARK: Plumbing

    private func channelList(_ items: [DemoChannelObject]) -> Data {
        encode(JSONValue.object(["data": .array(items.map(JSONValue.object))]))
    }

    private func channelOne(_ item: DemoChannelObject) -> Data { encode(JSONValue.object(item)) }

    private func channelAdmin(_ ws: DemoWorkspace) throws {
        guard ws.role == .owner || ws.role == .admin else {
            throw Failure(status: 403, code: "forbidden", detail: "Only admins can change this.")
        }
    }

    private func channelIndex(_ items: [DemoChannelObject], _ id: String, _ what: String) throws -> Int {
        guard let index = items.firstIndex(where: { $0["id"]?.string == id }) else { throw notFound(what) }
        return index
    }

    private func channelName(_ call: Call, _ key: String = "name") -> String {
        (call.string(key) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var channelMe: JSONValue { .object(["id": .string(me.id), "name": .string(me.name)]) }

    // MARK: Mailboxes

    private func channelMailboxRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        if call.match("GET", "mailboxes") != nil {
            guard call.query["limit"] != nil else { return nil }
            return .some(channelList(ws.settings.channels.mailboxes))
        }
        if call.match("GET", "mailboxes/connect-options") != nil {
            let provider: JSONValue = .object(["configured": .bool(true), "oauth": .bool(true), "api_sync": .bool(true)])
            return .some(encode(JSONValue.object([
                "google": provider, "microsoft": provider, "forwarding": .object(["enabled": .bool(true)]),
                "mailbox_imap": .bool(true), "instance_imap": .bool(true), "system_send": .bool(true), "system_sender": .string("no-reply@demo.opendesk.invalid"),
            ])))
        }
        if call.match("POST", "mailboxes/detect") != nil {
            return .some(encode(channelDetect(channelName(call, "email"))))
        }
        if call.match("POST", "mailboxes") != nil {
            try channelAdmin(ws)
            return .some(channelOne(try channelCreateMailbox(call, in: &ws)))
        }
        if let id = call.match("GET", "mailboxes/*")?.first {
            let index = try channelIndex(ws.settings.channels.mailboxes, id, "mailbox")
            return .some(channelOne(ws.settings.channels.mailboxes[index]))
        }
        if let id = call.match("GET", "mailboxes/*/usage")?.first {
            let tickets = ws.tickets.filter { $0.mailboxID == id }
            return .some(encode(JSONValue.object(["tickets": jn(tickets.count), "open": jn(tickets.filter { !$0.status.isDone }.count)])))
        }
        if let id = call.match("POST", "mailboxes/*/test")?.first {
            let index = try channelIndex(ws.settings.channels.mailboxes, id, "mailbox")
            return .some(encode(channelTest(ws.settings.channels.mailboxes[index])))
        }
        if let id = call.match("POST", "mailboxes/*/send-as/check")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(ws.settings.channels.mailboxes, id, "mailbox")
            var box = ws.settings.channels.mailboxes[index]
            let emails = [box["email"]?.string ?? ""] + (box["aliases"]?.array?.compactMap(\.string) ?? [])
            let display = box["display_name"]?.string ?? ""
            box["provider_send_as"] = .object([
                "readable": .bool(true), "checked_at": .string(DemoSeed.stamp(now())),
                "addresses": .array(emails.map { .object(["email": .string($0), "display_name": .string(display), "verified": .bool(true)]) }),
            ])
            var aliases = box["alias_settings"]?.object ?? [:]
            for email in emails.dropFirst() {
                var one = aliases[email]?.object ?? [:]
                one["send_as"] = .string("verified")
                one["send_as_by"] = .string(box["outbound_kind"]?.string ?? "")
                aliases[email] = .object(one)
            }
            box["alias_settings"] = .object(aliases)
            ws.settings.channels.mailboxes[index] = box
            return .some(channelOne(box))
        }
        if let id = call.match("PATCH", "mailboxes/*")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(ws.settings.channels.mailboxes, id, "mailbox")
            var patch = call.body.object ?? [:]
            for secret in ["password", "smtp_password", "verify"] { patch.removeValue(forKey: secret) }
            if let config = patch["config"]?.object {
                patch["config"] = .object(config.filter { !$0.key.contains("password") })
            }
            if let name = patch["name"]?.string, name.trimmingCharacters(in: .whitespaces).isEmpty {
                throw Failure(status: 422, code: "validation_failed", detail: "Give the mailbox a name.")
            }
            var box = channelMerge(ws.settings.channels.mailboxes[index], patch, nested: ["config"])
            if patch["config"] != nil || patch["inbound_kind"] != nil, box["status"]?.string == "error" {
                box["status"] = .string("active")
                box["last_error"] = .string("")
            }
            ws.settings.channels.mailboxes[index] = box
            return .some(channelOne(box))
        }
        if let id = call.match("DELETE", "mailboxes/*")?.first {
            try channelAdmin(ws)
            _ = try channelIndex(ws.settings.channels.mailboxes, id, "mailbox")
            ws.settings.channels.mailboxes.removeAll { $0["id"]?.string == id }
            for index in ws.settings.channels.brands.indices where ws.settings.channels.brands[index]["default_mailbox_id"]?.string == id {
                ws.settings.channels.brands[index]["default_mailbox_id"] = .null
            }
            return .some(nil)
        }
        return nil
    }

    /// `POST /v1/collab/accounts/{id}/use-for-tickets`: a mailbox that reads the account's inbox
    /// from now on, with its connection; the account leaves Mail unless kept. The member who
    /// connected it alone may: anyone else's is not found.
    private func channelUseForTickets(_ index: Int, _ call: Call, in ws: inout DemoWorkspace) throws -> JSONValue {
        let account = ws.mail.accounts[index]
        guard account.owner?.id == me.id else { throw notFound("account") }
        let email = account.email.lowercased()
        if ws.settings.channels.mailboxes.contains(where: { $0["email"]?.string == email }) {
            throw Failure(status: 409, code: "email_taken", detail: "That address already belongs to a mailbox.")
        }
        let name = channelName(call)
        let local = email.split(separator: "@").first.map { String($0).capitalized } ?? "Inbox"
        let own = account.name.isEmpty || account.name.contains("@") ? local : account.name
        let imap = account.provider == .imap
        var config: DemoChannelObject = ["sync_start": .string("new")]
        if !imap {
            config["oauth_grant"] = .string("api")
            config["oauth_client"] = .string("collab")
        }
        let box = DemoChannelSettings.mailboxForCreate(
            id: made(), name: name.isEmpty ? own : name, email: email, display: "",
            team: call.string("team_id"), brand: call.string("brand_id") ?? ws.settings.channels.brands.first { $0["is_default"]?.bool == true }?["id"]?.string,
            inbound: account.provider.rawValue, outbound: imap ? "smtp" : account.provider.rawValue, config: config, created: DemoSeed.stamp(now())
        )
        ws.settings.channels.mailboxes.append(box)
        let id = box["id"]?.string ?? ""
        publish("mailbox.created", ["mailbox": .object(["id": .string(id)])], in: &ws)
        let keep = call.body["keep_account"]?.bool ?? false
        if !keep {
            ws.mail.accounts.remove(at: index)
            ws.mail.folders.removeAll { $0.accountID == account.id }
            ws.mail.threads.removeAll { $0.accountID == account.id }
            ws.settings.channels.accountExtras[account.id] = nil
            ws.settings.channels.senderRules[account.id] = nil
            publish("collab.changed", ["account_id": .string(account.id), "thread_ids": .array([]), "folders": .bool(true)], in: &ws)
        }
        return .object(["mailbox_id": .string(id), "account_removed": .bool(!keep)])
    }

    private func channelCreateMailbox(_ call: Call, in ws: inout DemoWorkspace) throws -> DemoChannelObject {
        let email = channelName(call, "email").lowercased()
        guard email.contains("@"), email.contains(".") else {
            throw Failure(status: 422, code: "validation_failed", detail: "Enter the address customers write to.")
        }
        let taken = ws.settings.channels.mailboxes.contains { box in
            box["email"]?.string == email || (box["aliases"]?.array?.contains(.string(email)) ?? false)
        }
        if taken { throw Failure(status: 409, code: "email_taken", detail: "That address already belongs to a mailbox.") }
        let inbound = call.string("inbound_kind") ?? "forwarding"
        let outbound = call.string("outbound_kind") ?? "smtp"
        let config = (call.body["config"]?.object ?? [:]).filter { !$0.key.contains("password") }
        let local = email.split(separator: "@").first.map(String.init) ?? "mail"
        let name = channelName(call)
        var box = DemoChannelSettings.mailboxForCreate(
            id: made(), name: name.isEmpty ? local.capitalized : name, email: email, display: channelName(call, "display_name"),
            team: call.string("team_id"), brand: call.string("brand_id") ?? ws.settings.channels.brands.first { $0["is_default"]?.bool == true }?["id"]?.string,
            inbound: inbound, outbound: outbound, config: config, created: DemoSeed.stamp(now())
        )
        if let aliases = call.body["aliases"], aliases.array != nil { box["aliases"] = aliases }
        if let format = call.string("from_name_format") { box["from_name_format"] = .string(format) }
        if inbound == "forwarding" {
            box["forwarding_address"] = .string("\(local)-\(String(box["id"]?.string?.suffix(4) ?? "0000"))@in.opendesk.sh")
            box["last_synced_at"] = .null
        }
        ws.settings.channels.mailboxes.append(box)
        return box
    }

    private func channelDetect(_ email: String) -> JSONValue {
        let domain = email.split(separator: "@").last.map { String($0).lowercased() } ?? ""
        func server(_ host: String, _ port: Int, _ security: String) -> JSONValue {
            .object(["host": .string(host), "port": jn(port), "security": .string(security)])
        }
        switch domain {
        case "gmail.com", "googlemail.com":
            return .object([
                "domain": .string(domain), "host": .string("gmail"), "label": .string("Gmail"), "source": .string("known"),
                "settings": .object(["imap": server("imap.gmail.com", 993, "tls"), "smtp": server("smtp.gmail.com", 465, "tls")]),
                "password_auth": .string("app_password"), "app_password_url": .string("https://myaccount.google.com/apppasswords"), "oauth": .string("google"),
            ])
        case "outlook.com", "hotmail.com", "live.com":
            return .object([
                "domain": .string(domain), "host": .string("outlook"), "label": .string("Outlook.com"), "source": .string("known"),
                "settings": .object(["imap": server("outlook.office365.com", 993, "tls"), "smtp": server("smtp-mail.outlook.com", 587, "starttls")]),
                "password_auth": .string("oauth_only"), "oauth": .string("microsoft"),
            ])
        case "margin.app":
            return .object([
                "domain": .string(domain), "host": .string("google_workspace"), "label": .string("Google Workspace"), "source": .string("mx"),
                "settings": .object(["imap": server("imap.gmail.com", 993, "tls"), "smtp": server("smtp.gmail.com", 465, "tls")]),
                "password_auth": .string("app_password"), "app_password_url": .string("https://myaccount.google.com/apppasswords"), "oauth": .string("google"),
            ])
        default:
            return .object(["domain": .string(domain), "host": .string("other"), "label": .string(""), "source": .string("none"), "password_auth": .string("password")])
        }
    }

    private func channelTest(_ box: DemoChannelObject) -> JSONValue {
        let ok: JSONValue = .object(["ok": .bool(true), "error": .string(""), "detail": .string("")])
        let inbound = box["inbound_kind"]?.string ?? "forwarding"
        if box["status"]?.string == "error" {
            return .object([
                "inbound": .object(["ok": .bool(false), "error": .string("auth_failed"), "detail": .string("The mail server refused the sign-in.")]),
                "outbound": ok,
                "cause": .object(["title": .string("The app password was revoked"), "fix": .string("Create a new app password with your mail provider and paste it under Server settings.")]),
            ])
        }
        return .object(["inbound": inbound == "forwarding" ? .null : ok, "outbound": ok])
    }

    // MARK: Phone

    private func channelPhoneRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        if call.match("GET", "phone/providers") != nil {
            func field(_ name: String, _ label: String, secret: Bool) -> JSONValue {
                .object(["name": .string(name), "label": .string(label), "secret": .bool(secret)])
            }
            let providers: [JSONValue] = [
                .object(["key": .string("aircall"), "name": .string("Aircall"), "fields": .array([field("api_id", "API ID", secret: false), field("api_token", "API token", secret: true)]), "manual_webhook": .bool(false), "insight_cards": .bool(true)]),
                .object(["key": .string("voys"), "name": .string("Voys"), "fields": .array([field("api_token", "API token", secret: true)]), "manual_webhook": .bool(true), "insight_cards": .bool(false)]),
            ]
            return .some(encode(JSONValue.object(["data": .array(providers)])))
        }
        if call.match("GET", "phone/connections") != nil { return .some(channelList(ws.settings.channels.phoneConnections)) }
        if call.match("POST", "phone/connections") != nil {
            try channelAdmin(ws)
            let provider = call.string("provider") ?? ""
            guard provider == "aircall" || provider == "voys" else { throw Failure(status: 422, code: "validation_failed", detail: "Pick a phone system.") }
            let credentials = call.body["credentials"]?.object ?? [:]
            guard !credentials.isEmpty, credentials.values.allSatisfy({ !($0.string ?? "").trimmingCharacters(in: .whitespaces).isEmpty }) else {
                throw Failure(status: 422, code: "validation_failed", detail: "Fill in every field.")
            }
            let id = made()
            let manual = provider == "voys"
            let connection: DemoChannelObject = [
                "id": .string(id), "provider": .string(provider), "name": .string(manual ? "Voys" : "Aircall"),
                "account_name": .string(manual ? "Margin B.V." : "Margin GmbH"), "status": .string("connected"), "last_error": .string(""),
                "health_status": .string(manual ? "action_required" : "healthy"), "health_code": .string(manual ? "webhook_missing" : ""),
                "health_detail": .string(manual ? "Add the webhook address in Voys to start receiving calls." : ""),
                "reuse_days": jn(7), "assign_answered": .bool(true), "insight_cards": .bool(!manual), "last_event_at": .null,
                "webhook_url": manual ? .string("https://api.opendesk.sh/v1/phone/webhooks/\(id)") : .null,
            ]
            ws.settings.channels.phoneConnections.append(connection)
            return .some(channelOne(connection))
        }
        if let id = call.match("PATCH", "phone/connections/*")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(ws.settings.channels.phoneConnections, id, "connection")
            var patch = call.body.object ?? [:]
            if patch.removeValue(forKey: "credentials") != nil {
                patch["status"] = .string("connected")
                patch["last_error"] = .string("")
                patch["health_status"] = .string("healthy")
                patch["health_code"] = .string("")
                patch["health_detail"] = .string("")
            }
            ws.settings.channels.phoneConnections[index] = channelMerge(ws.settings.channels.phoneConnections[index], patch)
            return .some(channelOne(ws.settings.channels.phoneConnections[index]))
        }
        if let id = call.match("POST", "phone/connections/*/test")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(ws.settings.channels.phoneConnections, id, "connection")
            var connection = ws.settings.channels.phoneConnections[index]
            if connection["health_code"]?.string != "webhook_missing" {
                connection["health_status"] = .string("healthy")
                connection["health_detail"] = .string("")
            }
            ws.settings.channels.phoneConnections[index] = connection
            return .some(channelOne(connection))
        }
        if let id = call.match("POST", "phone/connections/*/rotate-webhook")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(ws.settings.channels.phoneConnections, id, "connection")
            ws.settings.channels.phoneConnections[index]["webhook_url"] = .string("https://api.opendesk.sh/v1/phone/webhooks/\(made())")
            return .some(channelOne(ws.settings.channels.phoneConnections[index]))
        }
        if let id = call.match("DELETE", "phone/connections/*")?.first {
            try channelAdmin(ws)
            _ = try channelIndex(ws.settings.channels.phoneConnections, id, "connection")
            ws.settings.channels.phoneConnections.removeAll { $0["id"]?.string == id }
            return .some(nil)
        }
        return nil
    }

    // MARK: Support channels

    private func channelSupportRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        if call.match("GET", "support-channels/providers") != nil { return .some(encode(JSONValue.object(["data": .array(channelSupportProviders)]))) }
        if call.match("GET", "support-channels/connections") != nil { return .some(channelList(ws.settings.channels.supportConnections)) }
        if call.match("GET", "support-channels/destinations") != nil { return .some(channelList(ws.settings.channels.destinations)) }
        if call.match("GET", "support-channels/ollie") != nil { return .some(encode(JSONValue.object(["actions": jstrs(ws.settings.channels.ollie)]))) }
        if call.match("PUT", "support-channels/ollie") != nil {
            try channelAdmin(ws)
            ws.settings.channels.ollie = call.body["actions"]?.array?.compactMap(\.string) ?? []
            return .some(encode(JSONValue.object(["actions": jstrs(ws.settings.channels.ollie)])))
        }
        if call.match("GET", "support-channels/operations") != nil { return .some(encode(channelOperations(ws))) }
        if call.match("GET", "support-channels/deliveries") != nil {
            let all = ws.settings.channels.deliveries
            let offset = Int(call.query["cursor"] ?? "") ?? 0
            let limit = max(1, Int(call.query["limit"] ?? "") ?? 50)
            let slice = Array(all.dropFirst(offset).prefix(limit))
            let next: JSONValue = offset + slice.count < all.count ? .string(String(offset + slice.count)) : .null
            return .some(encode(JSONValue.object(["data": .array(slice.map(JSONValue.object)), "next_cursor": next])))
        }
        if let seq = call.match("POST", "support-channels/deliveries/*/retry")?.first {
            try channelAdmin(ws)
            guard let index = ws.settings.channels.deliveries.firstIndex(where: { $0["event_seq"]?.int == Int(seq) }) else { throw notFound("delivery") }
            ws.settings.channels.deliveries[index]["status"] = .string("delivered")
            ws.settings.channels.deliveries[index]["attempts"] = jn((ws.settings.channels.deliveries[index]["attempts"]?.int ?? 0) + 1)
            ws.settings.channels.deliveries[index]["last_error"] = .string("")
            ws.settings.channels.deliveries[index]["updated_at"] = .string(DemoSeed.stamp(now()))
            return .some(channelOne(ws.settings.channels.deliveries[index]))
        }
        if let provider = call.match("POST", "support-channels/providers/*/accounts")?.first {
            try channelAdmin(ws)
            let servers: [JSONValue] = provider == "discord" ? [
                .object(["id": .string("1102938475610"), "name": .string("Margin Community"), "available": .bool(true)]),
                .object(["id": .string("1102938475611"), "name": .string("Inkwell Beta"), "available": .bool(false)]),
            ] : []
            return .some(encode(JSONValue.object(["data": .array(servers)])))
        }
        if call.match("POST", "support-channels/connections") != nil {
            try channelAdmin(ws)
            return .some(channelOne(try channelSupportConnect(call, in: &ws)))
        }
        if let id = call.match("PATCH", "support-channels/connections/*")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(ws.settings.channels.supportConnections, id, "connection")
            var connection = ws.settings.channels.supportConnections[index]
            if call.body["credentials"] != nil {
                connection["status"] = .string("connected")
                connection["last_error"] = .string("")
                connection["health_status"] = .string("healthy")
                connection["health_detail"] = .string("")
            }
            if let name = call.string("name"), !name.isEmpty { connection["name"] = .string(name) }
            ws.settings.channels.supportConnections[index] = connection
            return .some(channelOne(connection))
        }
        if let id = call.match("POST", "support-channels/connections/*/test")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(ws.settings.channels.supportConnections, id, "connection")
            ws.settings.channels.supportConnections[index]["health_status"] = .string("healthy")
            ws.settings.channels.supportConnections[index]["health_detail"] = .string("")
            return .some(channelOne(ws.settings.channels.supportConnections[index]))
        }
        if let id = call.match("DELETE", "support-channels/connections/*")?.first {
            try channelAdmin(ws)
            _ = try channelIndex(ws.settings.channels.supportConnections, id, "connection")
            ws.settings.channels.supportConnections.removeAll { $0["id"]?.string == id }
            ws.settings.channels.destinations.removeAll { $0["connection_id"]?.string == id }
            return .some(nil)
        }
        if let id = call.match("GET", "support-channels/connections/*/destinations")?.first {
            let index = try channelIndex(ws.settings.channels.supportConnections, id, "connection")
            return .some(encode(JSONValue.object(["data": .array(channelSupportChannels(ws.settings.channels.supportConnections[index]["provider"]?.string ?? ""))])))
        }
        if call.match("POST", "support-channels/destinations") != nil {
            try channelAdmin(ws)
            let connection = call.string("connection_id") ?? ""
            _ = try channelIndex(ws.settings.channels.supportConnections, connection, "connection")
            guard !(call.string("external_channel_id") ?? "").isEmpty else {
                throw Failure(status: 422, code: "validation_failed", detail: "Pick a channel.")
            }
            var destination = DemoChannelSettings.destinationDefaults(id: made(), connection: connection)
            destination = channelMerge(destination, call.body.object ?? [:])
            destination["id"] = .string(made())
            ws.settings.channels.destinations.append(destination)
            return .some(channelOne(destination))
        }
        if let id = call.match("PATCH", "support-channels/destinations/*")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(ws.settings.channels.destinations, id, "channel")
            var patch = call.body.object ?? [:]
            patch.removeValue(forKey: "id")
            patch.removeValue(forKey: "connection_id")
            ws.settings.channels.destinations[index] = channelMerge(ws.settings.channels.destinations[index], patch)
            return .some(channelOne(ws.settings.channels.destinations[index]))
        }
        if let id = call.match("DELETE", "support-channels/destinations/*")?.first {
            try channelAdmin(ws)
            _ = try channelIndex(ws.settings.channels.destinations, id, "channel")
            ws.settings.channels.destinations.removeAll { $0["id"]?.string == id }
            return .some(nil)
        }
        return nil
    }

    private var channelSupportProviders: [JSONValue] {
        func field(_ name: String, _ label: String, secret: Bool = false, generated: Bool = false, discovered: Bool = false, help: String = "") -> JSONValue {
            .object(["name": .string(name), "label": .string(label), "secret": .bool(secret), "generated": .bool(generated), "discovered": .bool(discovered), "help": .string(help)])
        }
        return [
            .object(["key": .string("slack"), "name": .string("Slack"), "description": .string("Slack threads where agents work tickets."), "configures": .bool(false),
                     "fields": .array([field("bot_token", "Bot token", secret: true, help: "Starts with xoxb-"), field("signing_secret", "Signing secret", secret: true)])]),
            .object(["key": .string("discord"), "name": .string("Discord"), "description": .string("Discord threads where agents work tickets."), "configures": .bool(true),
                     "fields": .array([field("bot_token", "Bot token", secret: true), field("public_key", "Public key"), field("guild_id", "Server", discovered: true)])]),
            .object(["key": .string("telegram"), "name": .string("Telegram"), "description": .string("Telegram forum topics where agents work tickets."), "configures": .bool(true),
                     "fields": .array([field("bot_token", "Bot token", secret: true), field("webhook_secret", "Webhook secret", secret: true, generated: true)])]),
        ]
    }

    private func channelSupportChannels(_ provider: String) -> [JSONValue] {
        func option(_ id: String, _ name: String, _ available: Bool = true) -> JSONValue {
            .object(["id": .string(id), "name": .string(name), "available": .bool(available)])
        }
        switch provider {
        case "slack": return [option("C04ESCAL", "support-escalations"), option("C04BILL", "billing"), option("C04PART", "partners"), option("C04GEN", "general", false)]
        case "discord": return [option("1203948576", "help"), option("1203948577", "bug-reports")]
        case "telegram": return [option("-1001928374", "Margin support desk")]
        default: return []
        }
    }

    private func channelSupportConnect(_ call: Call, in ws: inout DemoWorkspace) throws -> DemoChannelObject {
        let provider = call.string("provider") ?? ""
        guard ["slack", "discord", "telegram"].contains(provider) else { throw Failure(status: 422, code: "validation_failed", detail: "Pick a provider.") }
        let credentials = call.body["credentials"]?.object ?? [:]
        guard !(credentials["bot_token"]?.string ?? "").trimmingCharacters(in: .whitespaces).isEmpty else {
            throw Failure(status: 422, code: "credentials_refused", detail: "\(provider.capitalized) refused the bot token. Check it and try again.")
        }
        let id = made()
        let names: [String: (String, String)] = ["slack": ("Margin HQ", "margin-hq"), "discord": ("Margin Community", "margin"), "telegram": ("Margin Support Bot", "margin_support_bot")]
        let (account, handle) = names[provider] ?? ("", "")
        let name = channelName(call)
        let connection: DemoChannelObject = [
            "id": .string(id), "provider": .string(provider), "name": .string(name.isEmpty ? account : name),
            "external_account_id": .string(String(id.suffix(8))), "external_account_name": .string(account), "external_account_handle": .string(handle),
            "status": .string("connected"), "last_error": .string(""),
            "health_status": .string(provider == "slack" ? "action_required" : "healthy"),
            "health_detail": .string(provider == "slack" ? "Finish the setup steps in Slack." : ""),
            "webhook_url": .string("https://api.opendesk.sh/v1/support-channels/\(provider)/\(id)"),
        ]
        ws.settings.channels.supportConnections.append(connection)
        return connection
    }

    private func channelOperations(_ ws: DemoWorkspace) -> JSONValue {
        let c = ws.settings.channels
        let healthy = c.supportConnections.filter { $0["health_status"]?.string == "healthy" }.count
        func count(_ status: String) -> Int { c.deliveries.filter { $0["status"]?.string == status }.count }
        let pending = c.deliveries.filter { ["queued", "retrying"].contains($0["status"]?.string ?? "") }
        return .object([
            "connections": .object(["total": jn(c.supportConnections.count), "healthy": jn(healthy), "unhealthy": jn(c.supportConnections.count - healthy), "alerted": jn(0)]),
            "deliveries": .object([
                "queued": jn(count("queued")), "retrying": jn(count("retrying")), "delivered": jn(count("delivered")), "failed": jn(count("failed")),
                "average_latency_ms": .number(840), "maximum_latency_ms": .number(4200),
                "oldest_pending_at": pending.last?["updated_at"] ?? .null,
            ]),
            "webhooks": .object(["rejected": jn(2), "duplicates_suppressed": jn(14)]),
        ])
    }

    // MARK: Routing

    private func channelRoutingRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        if call.match("GET", "routing-rules") != nil {
            return .some(channelList(ws.settings.channels.rules.sorted { ($0["position"]?.int ?? 0) < ($1["position"]?.int ?? 0) }))
        }
        if call.match("POST", "routing-rules/reorder") != nil {
            try channelAdmin(ws)
            let ids = call.body["ids"]?.array?.compactMap(\.string) ?? []
            for (position, id) in ids.enumerated() {
                if let index = ws.settings.channels.rules.firstIndex(where: { $0["id"]?.string == id }) {
                    ws.settings.channels.rules[index]["position"] = jn(position)
                }
            }
            return .some(nil)
        }
        if call.match("POST", "routing-rules") != nil {
            try channelAdmin(ws)
            let body = call.body.object ?? [:]
            try channelCheckRule(body, creating: true)
            var rule: DemoChannelObject = [
                "id": .string(made()), "name": .string(channelName(call)), "enabled": .bool(true),
                "position": jn(ws.settings.channels.rules.count), "run_count": jn(0), "match": .string("all"),
                "conditions": .array([]), "team_id": .null, "skill_ids": .array([]),
            ]
            for key in ["enabled", "match", "conditions", "team_id", "skill_ids"] { if let value = body[key] { rule[key] = value } }
            ws.settings.channels.rules.append(rule)
            return .some(channelOne(rule))
        }
        if let id = call.match("PATCH", "routing-rules/*")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(ws.settings.channels.rules, id, "rule")
            var patch = call.body.object ?? [:]
            for key in ["id", "position", "run_count"] { patch.removeValue(forKey: key) }
            try channelCheckRule(patch, creating: false)
            ws.settings.channels.rules[index] = channelMerge(ws.settings.channels.rules[index], patch)
            return .some(channelOne(ws.settings.channels.rules[index]))
        }
        if let id = call.match("DELETE", "routing-rules/*")?.first {
            try channelAdmin(ws)
            _ = try channelIndex(ws.settings.channels.rules, id, "rule")
            ws.settings.channels.rules.removeAll { $0["id"]?.string == id }
            return .some(nil)
        }
        if call.match("POST", "routing/test") != nil {
            try channelAdmin(ws)
            return .some(encode(channelRoutingTest(call.body, in: ws)))
        }
        return nil
    }

    private func channelCheckRule(_ body: DemoChannelObject, creating: Bool) throws {
        if creating || body["name"] != nil, (body["name"]?.string ?? "").trimmingCharacters(in: .whitespaces).isEmpty {
            throw Failure(status: 422, code: "validation_failed", detail: "Give the rule a name.")
        }
        if creating || body["conditions"] != nil, (body["conditions"]?.array ?? []).isEmpty {
            throw Failure(status: 422, code: "validation_failed", detail: "Add at least one condition.")
        }
        if creating, body["team_id"]?.string == nil {
            throw Failure(status: 422, code: "validation_failed", detail: "Pick the team it routes to.")
        }
    }

    /// Where a message would go: the rules in order, then the address's, widget's or topic's team.
    private func channelRoutingTest(_ body: JSONValue, in ws: DemoWorkspace) -> JSONValue {
        let c = ws.settings.channels
        let to = (body["to"]?.string ?? "").lowercased()
        let from = (body["from"]?.string ?? "").lowercased()
        let widgetID = body["widget_id"]?.string
        let mailbox = c.mailboxes.first { box in
            box["email"]?.string == to || (box["aliases"]?.array?.contains(.string(to)) ?? false)
        }
        let widget = c.widgets.first { $0["id"]?.string == widgetID }
        let brandID = mailbox?["brand_id"]?.string ?? widget?["brand_id"]?.string
        let values: [String: String] = [
            "subject": body["subject"]?.string ?? "", "body": body["body"]?.string ?? "", "from_email": from,
            "from_domain": String(from.split(separator: "@").last ?? ""), "channel": body["channel"]?.string ?? "email",
            "mailbox_id": mailbox?["id"]?.string ?? "", "received_at": to, "brand_id": brandID ?? "",
            "widget_id": widgetID ?? "", "page_url": body["page_url"]?.string ?? "", "topic": body["topic"]?.string ?? "",
        ]
        var steps: [JSONValue] = []
        var chosen: DemoChannelObject?
        for rule in c.rules.sorted(by: { ($0["position"]?.int ?? 0) < ($1["position"]?.int ?? 0) }) where rule["enabled"]?.bool ?? true {
            let outcome = channelRuleMatches(rule, values)
            steps.append(.object(["rule_id": rule["id"] ?? .null, "name": rule["name"] ?? .null, "matched": .string(outcome)]))
            if outcome == "true", chosen == nil { chosen = rule }
        }
        var team: String?
        var routed: JSONValue = .null
        var required: [JSONValue] = []
        if let chosen {
            team = chosen["team_id"]?.string
            routed = .object(["via": .string("rule"), "rule_name": chosen["name"] ?? .null])
            let ids = chosen["skill_ids"]?.array?.compactMap(\.string) ?? []
            required = c.skills.filter { ids.contains($0["id"]?.string ?? "") }.map { .object(["id": $0["id"] ?? .null, "name": $0["name"] ?? .null]) }
        } else if let mailbox {
            team = mailbox["alias_teams"]?[to]?.string ?? mailbox["team_id"]?.string
            routed = .object(["via": .string("address")])
        } else if let widget {
            let topic = widget["settings"]?["topics"]?.array?.first { $0["id"]?.string == values["topic"] }
            if let topicTeam = topic?["team_id"]?.string {
                team = topicTeam
                routed = .object(["via": .string("topic"), "topic_label": topic?["label"] ?? .null])
            } else {
                team = widget["team_id"]?.string
                routed = team == nil ? .null : .object(["via": .string("widget")])
            }
        }
        return .object([
            "team_id": js(team), "brand_id": js(brandID), "mailbox_id": mailbox?["id"] ?? .null, "routed": routed,
            "steps": .array(steps), "required_skills": .array(required), "assign_mode": .string(team == DemoSeed.support ? "round_robin" : "none"),
        ])
    }

    /// "true", "false", or "unknown" for what only Ollie can tell.
    private func channelRuleMatches(_ rule: DemoChannelObject, _ values: [String: String]) -> String {
        let conditions = rule["conditions"]?.array ?? []
        var results: [String] = []
        for condition in conditions {
            let field = condition["field"]?.string ?? ""
            guard let actual = values[field] else { results.append("unknown"); continue }
            let a = actual.lowercased()
            let want = (condition["value"]?.string ?? "").lowercased()
            let hit: Bool
            switch condition["op"]?.string ?? "equals" {
            case "contains": hit = a.contains(want)
            case "not_contains": hit = !a.contains(want)
            case "not_equals": hit = a != want
            case "starts_with": hit = a.hasPrefix(want)
            default: hit = a == want
            }
            results.append(hit ? "true" : "false")
        }
        if rule["match"]?.string == "any" {
            if results.contains("true") { return "true" }
            return results.contains("unknown") ? "unknown" : "false"
        }
        if results.contains("false") { return "false" }
        return results.contains("unknown") ? "unknown" : "true"
    }

    // MARK: Brands and widgets

    private func channelBrandOut(_ brand: DemoChannelObject, in ws: DemoWorkspace) -> DemoChannelObject {
        let id = brand["id"]?.string
        var out = brand
        out["mailbox_count"] = jn(ws.settings.channels.mailboxes.filter { $0["brand_id"]?.string == id }.count)
        out["widget_count"] = jn(ws.settings.channels.widgets.filter { $0["brand_id"]?.string == id }.count)
        return out
    }

    private func channelBrandRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        let c = ws.settings.channels
        if call.match("GET", "brands") != nil {
            guard call.query["limit"] != nil else { return nil }
            return .some(channelList(c.brands.map { channelBrandOut($0, in: ws) }))
        }
        if call.match("POST", "brands") != nil {
            try channelAdmin(ws)
            let name = channelName(call)
            guard !name.isEmpty else { throw Failure(status: 422, code: "validation_failed", detail: "Give the brand a name.") }
            let slug = channelName(call, "slug").lowercased()
            guard !slug.isEmpty else { throw Failure(status: 422, code: "validation_failed", detail: "Choose a help center address.") }
            if c.brands.contains(where: { $0["slug"]?.string == slug }) {
                throw Failure(status: 409, code: "slug_taken", detail: "That address is taken. Try another.")
            }
            let url = DemoChannelSettings.helpURLFor(ws, slug: slug)
            let brand: DemoChannelObject = [
                "id": .string(made()), "name": .string(name), "slug": .string(slug), "is_default": .bool(false),
                "color": .string(call.string("color") ?? "#4f46e5"), "locale": .string("en"),
                "help_center": .object(["enabled": .bool(false), "title": .string("\(name) help"), "url": .string(url), "default_url": .string(url), "domain": .null]),
                "images": .object(["logo": .null]), "default_mailbox_id": .null, "position": jn(c.brands.count), "updated_at": .string(DemoSeed.stamp(now())),
            ]
            ws.settings.channels.brands.append(brand)
            return .some(channelOne(channelBrandOut(brand, in: ws)))
        }
        if let id = call.match("PATCH", "brands/*")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(c.brands, id, "brand")
            var patch = (call.body.object ?? [:]).filter { ["name", "color", "locale", "slug", "help_center", "default_mailbox_id"].contains($0.key) }
            if let name = patch["name"]?.string, name.trimmingCharacters(in: .whitespaces).isEmpty {
                throw Failure(status: 422, code: "validation_failed", detail: "Give the brand a name.")
            }
            var brand = c.brands[index]
            if let slug = patch["slug"]?.string?.lowercased(), slug != brand["slug"]?.string {
                if c.brands.contains(where: { $0["slug"]?.string == slug }) {
                    throw Failure(status: 409, code: "slug_taken", detail: "That address is taken. Try another.")
                }
                patch["slug"] = .string(slug)
                let url = DemoChannelSettings.helpURLFor(ws, slug: slug)
                var help = brand["help_center"]?.object ?? [:]
                help["default_url"] = .string(url)
                if help["domain"]?.isNull ?? true { help["url"] = .string(url) }
                brand["help_center"] = .object(help)
            }
            brand = channelMerge(brand, patch, nested: ["help_center"])
            brand["updated_at"] = .string(DemoSeed.stamp(now()))
            ws.settings.channels.brands[index] = brand
            return .some(channelOne(channelBrandOut(brand, in: ws)))
        }
        if let id = call.match("POST", "brands/*/default")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(c.brands, id, "brand")
            for i in ws.settings.channels.brands.indices { ws.settings.channels.brands[i]["is_default"] = .bool(i == index) }
            return .some(channelOne(channelBrandOut(ws.settings.channels.brands[index], in: ws)))
        }
        if let id = call.match("DELETE", "brands/*")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(c.brands, id, "brand")
            if c.brands[index]["is_default"]?.bool == true {
                throw Failure(status: 409, code: "default_brand", detail: "Make another brand the default first.")
            }
            if c.mailboxes.contains(where: { $0["brand_id"]?.string == id }) {
                throw Failure(status: 409, code: "brand_in_use", detail: "Move its addresses to another brand first.")
            }
            ws.settings.channels.brands.remove(at: index)
            ws.settings.channels.widgets.removeAll { $0["brand_id"]?.string == id }
            return .some(nil)
        }
        if let id = call.match("PUT", "brands/*/help-domain")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(c.brands, id, "brand")
            let host = channelName(call, "hostname").lowercased()
            guard host.split(separator: ".").count >= 3, !host.contains("/"), !host.contains(" ") else {
                throw Failure(status: 422, code: "invalid_hostname", detail: "Use a subdomain you own, like help.example.com.")
            }
            var help = c.brands[index]["help_center"]?.object ?? [:]
            help["domain"] = .object([
                "hostname": .string(host), "status": .string("pending"), "problem": .string(""), "checked_at": .null,
                "records": .array([.object(["type": .string("CNAME"), "name": .string(host), "value": .string("custom.opendesk.help"), "ok": .bool(false)])]),
            ])
            ws.settings.channels.brands[index]["help_center"] = .object(help)
            return .some(channelOne(channelBrandOut(ws.settings.channels.brands[index], in: ws)))
        }
        if let id = call.match("POST", "brands/*/help-domain/check")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(c.brands, id, "brand")
            var help = c.brands[index]["help_center"]?.object ?? [:]
            guard var domain = help["domain"]?.object, let host = domain["hostname"]?.string else { throw notFound("domain") }
            domain["status"] = .string("active")
            domain["checked_at"] = .string(DemoSeed.stamp(now()))
            domain["records"] = .array([.object(["type": .string("CNAME"), "name": .string(host), "value": .string("custom.opendesk.help"), "ok": .bool(true)])])
            help["domain"] = .object(domain)
            help["url"] = .string("https://\(host)")
            ws.settings.channels.brands[index]["help_center"] = .object(help)
            return .some(channelOne(channelBrandOut(ws.settings.channels.brands[index], in: ws)))
        }
        if let id = call.match("DELETE", "brands/*/help-domain")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(c.brands, id, "brand")
            var help = c.brands[index]["help_center"]?.object ?? [:]
            help["domain"] = .null
            help["url"] = help["default_url"] ?? .null
            ws.settings.channels.brands[index]["help_center"] = .object(help)
            return .some(nil)
        }

        if call.match("GET", "widgets") != nil {
            return .some(channelList(c.widgets.sorted { ($0["position"]?.int ?? 0) < ($1["position"]?.int ?? 0) }))
        }
        if call.match("POST", "widgets") != nil {
            try channelAdmin(ws)
            let name = channelName(call)
            guard !name.isEmpty else { throw Failure(status: 422, code: "validation_failed", detail: "Give the widget a name.") }
            let brandID = call.string("brand_id") ?? ""
            let brandIndex = try channelIndex(c.brands, brandID, "brand")
            let color = c.brands[brandIndex]["color"]?.string ?? "#4f46e5"
            let id = made()
            let settings = DemoChannelSettings.settingsForNewWidget(color: color, title: c.brands[brandIndex]["name"]?.string ?? name)
            var widget = DemoChannelSettings.widgetForCreate(id: id, brand: brandID, name: name, key: "wk_\(id.suffix(10))", team: call.string("team_id"), settings: settings, position: c.widgets.filter { $0["brand_id"]?.string == brandID }.count)
            ws.settings.channels.widgets.append(widget)
            widget["secret"] = .string("whsec_demo_\(id.suffix(12))")
            widget["secret_available"] = .bool(true)
            return .some(channelOne(widget))
        }
        if let id = call.match("PATCH", "widgets/*")?.first {
            try channelAdmin(ws)
            let index = try channelIndex(c.widgets, id, "widget")
            var patch = (call.body.object ?? [:]).filter { ["name", "team_id", "bot_id", "settings"].contains($0.key) }
            if let name = patch["name"]?.string, name.trimmingCharacters(in: .whitespaces).isEmpty {
                throw Failure(status: 422, code: "validation_failed", detail: "Give the widget a name.")
            }
            if var settings = patch["settings"]?.object {
                if let topics = settings["topics"]?.array {
                    settings["topics"] = .array(topics.map { topic in
                        guard var object = topic.object, object["id"] == nil else { return topic }
                        object["id"] = .string(made())
                        return .object(object)
                    })
                }
                patch["settings"] = .object(settings)
            }
            ws.settings.channels.widgets[index] = channelMerge(c.widgets[index], patch, nested: ["settings"])
            return .some(channelOne(ws.settings.channels.widgets[index]))
        }
        if let id = call.match("DELETE", "widgets/*")?.first {
            try channelAdmin(ws)
            _ = try channelIndex(c.widgets, id, "widget")
            ws.settings.channels.widgets.removeAll { $0["id"]?.string == id }
            return .some(nil)
        }
        if let id = call.match("POST", "widgets/*/secret/rotate")?.first {
            try channelAdmin(ws)
            _ = try channelIndex(c.widgets, id, "widget")
            return .some(encode(JSONValue.object(["secret": .string("whsec_demo_\(made().suffix(12))")])))
        }
        return nil
    }

    // MARK: Collab accounts and categories

    private func channelCollabRoutes(_ call: Call, in ws: inout DemoWorkspace) throws -> Data?? {
        // A workspace without Collab gets the Mail area's own refusal.
        guard ws.mail.enabled else { return nil }

        if call.match("GET", "collab/accounts") != nil {
            guard call.query["manage"] != nil else { return nil }
            return .some(encode(JSONValue.array(ws.mail.accountsOut().map { .object(channelAccountOut($0, in: ws)) })))
        }
        if call.match("POST", "collab/accounts/imap") != nil {
            return .some(channelOne(try channelConnectIMAP(call, in: &ws)))
        }
        if call.match("GET", "collab/categories") != nil { return .some(encode(channelCategoriesOut(ws))) }
        if call.match("PUT", "collab/categories/workspace") != nil {
            try channelAdmin(ws)
            let enabled = call.body["enabled"]?.bool ?? true
            var set: DemoChannelObject = ws.settings.channels.workspaceCategories ?? ["team_id": .null, "team_name": .string(""), "position": jn(0)]
            set["enabled"] = .bool(enabled)
            set["locked"] = .bool(call.body["locked"]?.bool ?? false)
            if enabled { set["categories"] = .array(try channelCategories(call.body["categories"]).map(\.channelJSON)) }
            set["updated_at"] = .string(DemoSeed.stamp(now()))
            set["updated_by"] = channelMe
            ws.settings.channels.workspaceCategories = set
            channelResolveCategories(in: &ws)
            return .some(encode(channelCategoriesOut(ws)))
        }
        if call.match("DELETE", "collab/categories/workspace") != nil {
            try channelAdmin(ws)
            ws.settings.channels.workspaceCategories = nil
            channelResolveCategories(in: &ws)
            return .some(encode(channelCategoriesOut(ws)))
        }
        if call.match("PUT", "collab/categories/team-order") != nil {
            try channelAdmin(ws)
            let ids = call.body["team_ids"]?.array?.compactMap(\.string) ?? []
            for (position, id) in ids.enumerated() {
                if let index = ws.settings.channels.teamCategories.firstIndex(where: { $0["team_id"]?.string == id }) {
                    ws.settings.channels.teamCategories[index]["position"] = jn(position)
                }
            }
            channelResolveCategories(in: &ws)
            return .some(encode(channelCategoriesOut(ws)))
        }
        if let team = call.match("PUT", "collab/categories/teams/*")?.first {
            try channelAdmin(ws)
            guard let named = ws.teams.first(where: { $0.id == team }) else { throw notFound("team") }
            let enabled = call.body["enabled"]?.bool ?? true
            let index = ws.settings.channels.teamCategories.firstIndex { $0["team_id"]?.string == team }
            var set: DemoChannelObject = index.map { ws.settings.channels.teamCategories[$0] } ?? [
                "team_id": .string(team), "locked": .bool(false), "position": jn(ws.settings.channels.teamCategories.count),
            ]
            set["team_name"] = .string(named.name)
            set["enabled"] = .bool(enabled)
            set["categories"] = enabled ? .array(try channelCategories(call.body["categories"]).map(\.channelJSON)) : .array([])
            set["updated_at"] = .string(DemoSeed.stamp(now()))
            set["updated_by"] = channelMe
            if let index { ws.settings.channels.teamCategories[index] = set } else { ws.settings.channels.teamCategories.append(set) }
            channelResolveCategories(in: &ws)
            return .some(encode(channelCategoriesOut(ws)))
        }
        if let team = call.match("DELETE", "collab/categories/teams/*")?.first {
            try channelAdmin(ws)
            ws.settings.channels.teamCategories.removeAll { $0["team_id"]?.string == team }
            channelResolveCategories(in: &ws)
            return .some(encode(channelCategoriesOut(ws)))
        }
        if call.match("POST", "collab/categories/suggest") != nil {
            let about = (call.string("about") ?? "").lowercased()
            var found = [
                MailCategory(key: "primary", name: "Primary", description: "People and everything else", color: "gray"),
                MailCategory(key: "customers", name: "Customers", description: "Mail from customers and prospects", color: "blue"),
                MailCategory(key: "invoices", name: "Invoices", description: "Invoices, receipts and payment notices", color: "green"),
                MailCategory(key: "newsletters", name: "Newsletters", description: "Newsletters and mailing lists", color: "violet"),
            ]
            if about.contains("partner") {
                found[1] = MailCategory(key: "partners", name: "Partners", description: "Mail from partners and resellers", color: "teal")
            }
            return .some(encode(JSONValue.object(["categories": .array(found.map(\.channelJSON))])))
        }

        guard call.path.count >= 3, call.path[1] == "accounts" else { return nil }
        let id = call.path[2]
        guard let index = ws.mail.accountIndex(id), ws.mail.visibleAccounts.contains(where: { $0.id == id }) else { return nil }

        if call.match("GET", "collab/accounts/*/category-rules") != nil {
            let rules = ws.settings.channels.senderRules[id] ?? []
            return .some(encode(JSONValue.object(["rules": .array(rules.map(JSONValue.object))])))
        }
        if call.match("POST", "collab/accounts/*/use-for-tickets") != nil {
            try channelAdmin(ws)
            return .some(encode(try channelUseForTickets(index, call, in: &ws)))
        }
        // Only the account's settings are this group's; folders, sync and the rest stay the Mail area's.
        let own = call.path.count == 3 ? ["PATCH", "DELETE"].contains(call.method) : ["categories", "category-rules", "history", "signature", "display-name"].contains(call.path[3])
        guard own else { return nil }
        guard ws.mail.accounts[index].canManage else {
            throw Failure(status: 403, code: "forbidden", detail: "Only the people who manage this account can change it.")
        }

        if call.match("POST", "collab/accounts/*/category-rules") != nil {
            guard let moved = try mailRoutes(call, in: &ws), let data = moved, let answer = try? JSONValue.parse(data) else { return nil }
            let rule: DemoChannelObject = ["id": .string(made()), "sender": answer["sender"] ?? .null, "category": answer["category"] ?? .null]
            ws.settings.channels.senderRules[id, default: []].removeAll { $0["sender"] == rule["sender"] }
            ws.settings.channels.senderRules[id, default: []].insert(rule, at: 0)
            return .some(channelOne(channelMerge(rule, ["moved": answer["moved"] ?? jn(0)])))
        }
        if let rule = call.match("DELETE", "collab/accounts/*/category-rules/*")?.last {
            ws.settings.channels.senderRules[id]?.removeAll { $0["id"]?.string == rule }
            return .some(nil)
        }
        if call.match("PATCH", "collab/accounts/*") != nil {
            try channelPatchAccount(index, call.body, in: &ws)
        } else if call.match("DELETE", "collab/accounts/*") != nil {
            ws.mail.accounts.remove(at: index)
            ws.mail.folders.removeAll { $0.accountID == id }
            ws.mail.threads.removeAll { $0.accountID == id }
            ws.settings.channels.accountExtras[id] = nil
            ws.settings.channels.senderRules[id] = nil
            publish("collab.changed", ["account_id": .string(id), "thread_ids": .array([]), "folders": .bool(true)], in: &ws)
            return .some(nil)
        } else if call.match("PUT", "collab/accounts/*/categories") != nil {
            try channelSetAccountCategories(index, call.body, in: &ws)
        } else if call.match("PUT", "collab/accounts/*/history") != nil {
            let total = 4000 + (ws.mail.threads.filter { $0.accountID == id }.count * 37)
            ws.settings.channels.accountExtras[id, default: [:]]["history"] = .object([
                "status": .string("running"), "since": call.body["since"] ?? .null, "include_spam_trash": .bool(call.body["include_spam_trash"]?.bool ?? false),
                "requested_by": channelMe, "started_at": .string(DemoSeed.stamp(now())), "finished_at": .null,
                "imported": jn(0), "present": jn(0), "too_large": jn(0), "unreadable": jn(0), "total": jn(total), "last_error": .string(""),
            ])
            ws.mail.accounts[index].history = MailHistory(status: "running", since: nil)
        } else if call.match("PATCH", "collab/accounts/*/history") != nil {
            guard var history = ws.settings.channels.accountExtras[id]?["history"]?.object else { throw notFound("import") }
            let status = call.body["paused"]?.bool == true ? "paused" : "running"
            history["status"] = .string(status)
            ws.settings.channels.accountExtras[id, default: [:]]["history"] = .object(history)
            ws.mail.accounts[index].history = MailHistory(status: status, since: nil)
        } else if call.match("DELETE", "collab/accounts/*/history") != nil {
            guard var history = ws.settings.channels.accountExtras[id]?["history"]?.object else { throw notFound("import") }
            history["status"] = .string("canceled")
            history["finished_at"] = .string(DemoSeed.stamp(now()))
            ws.settings.channels.accountExtras[id, default: [:]]["history"] = .object(history)
            ws.mail.accounts[index].history = MailHistory(status: "canceled", since: nil)
        } else if call.match("POST", "collab/accounts/*/signature/pull") != nil {
            guard ws.mail.accounts[index].provider == .google else {
                throw Failure(status: 422, code: "unsupported", detail: "Only Gmail shares its signature.")
            }
            ws.settings.channels.accountExtras[id, default: [:]]["signature_sync"] = .string("two_way")
        } else if call.match("POST", "collab/accounts/*/display-name/pull") != nil {
            guard ws.mail.accounts[index].provider == .google else {
                throw Failure(status: 422, code: "unsupported", detail: "Only Gmail shares its sender name.")
            }
            let name = ws.mail.accounts[index].owner?.name ?? me.name
            ws.mail.accounts[index].displayName = name
            ws.settings.channels.accountExtras[id, default: [:]]["display_name_sync"] = .string("two_way")
        } else {
            return nil
        }
        publish("collab.changed", ["account_id": .string(id), "thread_ids": .array([]), "folders": .bool(false)], in: &ws)
        guard let account = ws.mail.accounts.first(where: { $0.id == id }) else { throw notFound("account") }
        return .some(channelOne(channelAccountOut(account, in: ws)))
    }

    /// The Mail area's account plus what only its settings read.
    private func channelAccountOut(_ account: MailAccount, in ws: DemoWorkspace) -> DemoChannelObject {
        var out = (try? JSONValue.from(account))?.object ?? [:]
        let extras = ws.settings.channels.accountExtras[account.id] ?? [:]
        for (key, value) in extras where key != "categories" { out[key] = value }
        let locked = channelLocked(ws)
        var categories: DemoChannelObject = out["categories"]?.object ?? [
            "enabled": .bool(false), "categories": .array([]), "source": .string("account"), "mode": .string("off"), "engine": .string("off"),
        ]
        categories["locked"] = .bool(locked)
        for (key, value) in extras["categories"]?.object ?? [:] { categories[key] = value }
        if categories["ai"] == nil { categories["ai"] = .bool(true) }
        if let team = channelTeamSet(for: account, in: ws), categories["source"]?.string == "team" {
            categories["team"] = .object(["id": team["team_id"] ?? .null, "name": team["team_name"] ?? .null])
        }
        out["categories"] = .object(categories)
        return out
    }

    private func channelConnectIMAP(_ call: Call, in ws: inout DemoWorkspace) throws -> DemoChannelObject {
        let email = channelName(call, "email").lowercased()
        guard email.contains("@") else { throw Failure(status: 422, code: "validation_failed", detail: "Enter the address of the account.") }
        guard !(call.string("password") ?? "").isEmpty else { throw Failure(status: 422, code: "validation_failed", detail: "Enter the account's password.") }
        if ws.mail.accounts.contains(where: { $0.email.lowercased() == email }) {
            throw Failure(status: 409, code: "account_exists", detail: "That account is already connected.")
        }
        let id = made()
        let name = channelName(call)
        let shared = call.string("visibility") == "shared"
        let audience = (try? call.body["shared_with"]?.decode(MailAudience.self)) ?? .nobody
        let account = MailAccount(
            id: id, provider: .imap, email: email, name: name, displayName: me.name, color: "indigo", owner: me,
            visibility: shared ? "shared" : "private", sharedWith: shared ? audience : .nobody, status: "active", lastSyncedAt: now(), canManage: true,
            identities: [MailIdentity(identityID: nil, email: email, displayName: me.name, primary: true, isDefault: true, fromName: me.name)],
            defaultFrom: email, categories: MailAccountCategories(enabled: false, categories: [], source: "none", mode: "follow", engine: "off")
        )
        ws.mail.accounts.append(account)
        let roles: [(String, MailFolderRole)] = [("Inbox", .inbox), ("Sent", .sent), ("Drafts", .drafts), ("Archive", .archive), ("Trash", .trash)]
        for (folder, role) in roles {
            ws.mail.folders.append(MailFolder(id: made(), accountID: id, name: folder, path: folder, role: role, kind: "folder", color: nil, canRename: false))
        }
        let config = call.body.object ?? [:]
        let imap: DemoChannelObject = [
            "imap_host": config["imap_host"] ?? .string(""), "imap_port": config["imap_port"] ?? jn(993), "imap_tls": config["imap_tls"] ?? .string("tls"),
            "imap_username": config["imap_username"] ?? .string(email), "smtp_host": config["smtp_host"] ?? .string(""),
            "smtp_port": config["smtp_port"] ?? jn(465), "smtp_tls": config["smtp_tls"] ?? .string("tls"), "smtp_username": config["smtp_username"] ?? .string(email),
        ]
        var extras: DemoChannelObject = ["imap": .object(imap), "created_at": .string(DemoSeed.stamp(now())), "categories": .object(["ai": .bool(true), "own": .array([])])]
        if let since = call.body["history"]?["since"] {
            extras["history"] = .object([
                "status": .string("running"), "since": since, "include_spam_trash": .bool(false), "requested_by": channelMe,
                "started_at": .string(DemoSeed.stamp(now())), "imported": jn(0), "present": jn(0), "too_large": jn(0), "unreadable": jn(0), "last_error": .string(""),
            ])
        }
        ws.settings.channels.accountExtras[id] = extras
        channelResolveCategories(in: &ws)
        publish("collab.changed", ["account_id": .string(id), "thread_ids": .array([]), "folders": .bool(true)], in: &ws)
        let saved = ws.mail.accounts.first { $0.id == id } ?? account
        return channelAccountOut(saved, in: ws)
    }

    private func channelPatchAccount(_ index: Int, _ body: JSONValue, in ws: inout DemoWorkspace) throws {
        var account = ws.mail.accounts[index]
        if let name = body["name"]?.string { account.name = name.trimmingCharacters(in: .whitespaces) }
        if let display = body["display_name"]?.string {
            account.displayName = display
            for i in account.identities.indices where account.identities[i].primary { account.identities[i].displayName = display }
        }
        if let color = body["color"]?.string { account.color = color }
        if let signature = body["signature_html"]?.string {
            account.signatureHTML = signature
            for i in account.identities.indices where account.identities[i].primary { account.identities[i].signatureHTML = signature }
        }
        if let visibility = body["visibility"]?.string { account.visibility = visibility == "shared" ? "shared" : "private" }
        if let audience = try? body["shared_with"]?.decode(MailAudience.self) { account.sharedWith = audience }
        if account.visibility == "shared", account.sharedWith.isEmpty {
            throw Failure(status: 422, code: "validation_failed", detail: "Choose who it's shared with.")
        }
        if account.visibility == "private" { account.sharedWith = .nobody }
        if let handling = body["handling_enabled"]?.bool { account.handlingEnabled = handling }
        if let replyAll = body["reply_all"]?.bool { account.replyAll = replyAll }
        if let imap = body["imap"]?.object {
            let clean = imap.filter { !$0.key.contains("password") }
            let before = ws.settings.channels.accountExtras[account.id]?["imap"]?.object ?? [:]
            ws.settings.channels.accountExtras[account.id, default: [:]]["imap"] = .object(channelMerge(before, clean))
            account.status = "active"
            account.lastError = ""
            account.reconnect = false
        }
        ws.mail.accounts[index] = account
        channelResolveCategories(in: &ws)
    }

    private func channelSetAccountCategories(_ index: Int, _ body: JSONValue, in ws: inout DemoWorkspace) throws {
        let id = ws.mail.accounts[index].id
        var categories = ws.mail.accounts[index].categories ?? MailAccountCategories()
        let locked = channelLocked(ws)
        if let ai = body["ai"]?.bool {
            ws.settings.channels.accountExtras[id, default: [:]]["categories"] = .object(channelMerge(ws.settings.channels.accountExtras[id]?["categories"]?.object ?? [:], ["ai": .bool(ai)]))
        }
        let mode = body["mode"]?.string ?? categories.mode
        if !locked {
            switch mode {
            case "off":
                categories = MailAccountCategories(enabled: false, categories: [], source: "account", mode: "off", engine: "off")
            case "custom":
                let list = try channelCategories(body["categories"])
                categories = MailAccountCategories(enabled: true, categories: list, source: "account", mode: "custom", engine: "local")
                var extras = ws.settings.channels.accountExtras[id]?["categories"]?.object ?? [:]
                extras["own"] = .array(list.map(\.channelJSON))
                ws.settings.channels.accountExtras[id, default: [:]]["categories"] = .object(extras)
            case "gmail":
                guard ws.mail.accounts[index].provider == .google else {
                    throw Failure(status: 422, code: "unsupported", detail: "Only Gmail accounts can use Gmail's categories.")
                }
                categories = MailAccountCategories(enabled: true, categories: DemoChannelSettings.gmailCategories, source: "account", mode: "gmail", engine: "gmail")
                var extras = ws.settings.channels.accountExtras[id]?["categories"]?.object ?? [:]
                extras["sync_status"] = .string("ready")
                ws.settings.channels.accountExtras[id, default: [:]]["categories"] = .object(extras)
            default:
                categories.mode = "follow"
            }
        }
        if mode != "gmail" {
            var extras = ws.settings.channels.accountExtras[id]?["categories"]?.object ?? [:]
            extras["sync_status"] = .string("")
            ws.settings.channels.accountExtras[id, default: [:]]["categories"] = .object(extras)
        }
        ws.mail.accounts[index].categories = categories
        channelResolveCategories(in: &ws)
    }

    /// The categories a body names, with keys for those made in the editor; between 2 and 10, named once each.
    private func channelCategories(_ value: JSONValue?) throws -> [MailCategory] {
        let list = (try? value?.decode([MailCategory].self)) ?? []
        guard (2 ... 10).contains(list.count) else {
            throw Failure(status: 422, code: "validation_failed", detail: "Use between 2 and 10 categories.")
        }
        var keys = Set<String>()
        var names = Set<String>()
        return try list.map { category in
            var category = category
            category.name = category.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !category.name.isEmpty, names.insert(category.name.lowercased()).inserted else {
                throw Failure(status: 422, code: "validation_failed", detail: "Every category needs its own name.")
            }
            if category.key.isEmpty || category.key.hasPrefix("~") || keys.contains(category.key) {
                let base = MailCategoryKit.slug(category.name)
                var key = base.isEmpty ? "category" : base
                var n = 2
                while keys.contains(key) { key = "\(base)-\(n)"; n += 1 }
                category.key = key
            }
            keys.insert(category.key)
            return category
        }
    }

    private func channelLocked(_ ws: DemoWorkspace) -> Bool {
        guard let set = ws.settings.channels.workspaceCategories else { return false }
        return set["enabled"]?.bool == true && set["locked"]?.bool == true
    }

    /// The first set, in the admins' order, of a team a shared account is shared with.
    private func channelTeamSet(for account: MailAccount, in ws: DemoWorkspace) -> DemoChannelObject? {
        guard !account.isPrivate else { return nil }
        return ws.settings.channels.teamCategories
            .sorted { ($0["position"]?.int ?? 0) < ($1["position"]?.int ?? 0) }
            .first { account.sharedWith.teamIDs.contains($0["team_id"]?.string ?? "") }
    }

    /// Accounts that follow take their team's set, else the workspace's; a lock makes everyone follow.
    private func channelResolveCategories(in ws: inout DemoWorkspace) {
        let locked = channelLocked(ws)
        let workspace = ws.settings.channels.workspaceCategories
        for index in ws.mail.accounts.indices {
            guard var categories = ws.mail.accounts[index].categories else { continue }
            categories.locked = locked
            if locked { categories.mode = "follow" }
            if categories.mode == "follow" {
                let set = channelTeamSet(for: ws.mail.accounts[index], in: ws) ?? workspace
                let enabled = set?["enabled"]?.bool ?? false
                categories.enabled = enabled
                categories.categories = enabled ? ((try? set?["categories"]?.decode([MailCategory].self)) ?? []) : []
                categories.source = set == nil ? "none" : (set?["team_id"]?.string == nil ? "workspace" : "team")
                categories.engine = enabled ? "local" : "off"
            }
            ws.mail.accounts[index].categories = categories
        }
    }

    private func channelCategoriesOut(_ ws: DemoWorkspace) -> JSONValue {
        let c = ws.settings.channels
        let teams = c.teamCategories.sorted { ($0["position"]?.int ?? 0) < ($1["position"]?.int ?? 0) }
        return .object([
            "workspace": c.workspaceCategories.map(JSONValue.object) ?? .null,
            "teams": .array(teams.map(JSONValue.object)),
            "presets": .array(DemoChannelSettings.presets.map(\.channelJSON)),
            "gmail_categories": .array(DemoChannelSettings.gmailCategories.map(\.channelJSON)),
            "sorting": .string("ai"),
            "suggest": .bool(true),
        ])
    }
}

// MARK: - Records made here

extension DemoChannelSettings {
    static func helpURLFor(_ ws: DemoWorkspace, slug: String) -> String { helpURL(ws, slug: slug) }

    static func mailboxForCreate(
        id: String, name: String, email: String, display: String, team: String?, brand: String?,
        inbound: String, outbound: String, config: DemoChannelObject, created: String
    ) -> DemoChannelObject {
        var box = mailbox(id: id, name: name, email: email, display: display, team: team, brand: brand, inbound: inbound, outbound: outbound, config: config, received: 0, created: 0)
        box["created_at"] = .string(created)
        box["last_received_at"] = .null
        box["last_synced_at"] = .string(created)
        return box
    }

    static func settingsForNewWidget(color: String, title: String) -> DemoChannelObject {
        widgetSettings(color: color, greeting: "Hi, how can we help?", intro: "", title: title)
    }

    static func widgetForCreate(id: String, brand: String, name: String, key: String, team: String?, settings: DemoChannelObject, position: Int) -> DemoChannelObject {
        widget(id: id, brand: brand, name: name, key: key, team: team, settings: settings, seen: nil, position: position)
    }

    static func destinationDefaults(id: String, connection: String) -> DemoChannelObject {
        destination(id: id, connection: connection, team: nil, priority: nil, channel: ("", ""), mode: "route", notes: false)
    }
}
#endif
