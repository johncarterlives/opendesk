import SwiftUI

/// "Add a ticket inbox" (the web's `AddInboxDialog`): a new address through the same steps as
/// Settings › Mailboxes, or a Collab mail account the member connected, handed over
/// (contracts/collab.md "Using an account for tickets"). Then how it answers and whether it
/// gets a section of its own, and it opens. Admins only; anyone else is asked to find one.
struct AddInboxSheet: View {
    /// A Mail account to hand over; nil adds a new address.
    var account: MailAccount?
    /// Opens the inbox once it is set up.
    let onOpen: (String) -> Void

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var store = MailboxSettingsStore()
    @State private var ready: Ready?

    struct Ready {
        var mailbox: SettingsMailbox
        var handedOver: Bool
    }

    var body: some View {
        NavigationStack {
            Group {
                if !env.session.isAdmin {
                    askAdmin
                } else if let ready {
                    AddInboxReplies(mailbox: ready.mailbox, handedOver: ready.handedOver, store: store) {
                        dismiss()
                        onOpen(ready.mailbox.id)
                    }
                } else if let account {
                    AddInboxFromAccount(account: account) { id in await added(id, handedOver: true) }
                } else {
                    MailboxNewView(title: "Add a ticket inbox", onDone: { id in Task { await added(id, handedOver: false) } })
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    SheetButton(.cancel, ready == nil ? "Cancel" : "Close") { dismiss() }
                }
            }
        }
        .motion(Motion.snappy, value: ready?.mailbox.id)
        .onAppear { store.attach(env.session.api) }
    }

    private var askAdmin: some View {
        AccountPage(title: "Add a ticket inbox", spacing: 20) {
            Text("Only workspace admins add ticket inboxes. Ask one of them to add this address.")
                .font(ODFont.callout)
                .foregroundStyle(Theme.fg2)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
            Button { dismiss() } label: { ButtonLabel(title: "Got it") }
                .buttonStyle(InkButtonStyle())
        }
    }

    /// The mailbox exists: the list learns of it, then how it answers.
    private func added(_ id: String, handedOver: Bool) async {
        await env.directory.refreshMailboxes()
        do {
            ready = Ready(mailbox: try await store.fetch(id), handedOver: handedOver)
        } catch {
            // It exists either way: open it.
            dismiss()
            onOpen(id)
        }
    }
}

/// A Mail account the member connected, handed over: its name, team and brand, and whether it
/// stays in Mail. Only new mail becomes tickets.
private struct AddInboxFromAccount: View {
    let account: MailAccount
    let onDone: @MainActor (String) async -> Void

    @Environment(AppEnvironment.self) private var env
    @State private var store = MailboxSettingsStore()
    @State private var name: String
    @State private var teamID: String?
    @State private var brandID: String?
    @State private var keep = false
    @State private var saving = false
    @State private var error: String?

    init(account: MailAccount, onDone: @escaping @MainActor (String) async -> Void) {
        self.account = account
        self.onDone = onDone
        // The name defaults to the account's, never an address.
        _name = State(initialValue: account.name.contains("@") ? "" : account.name)
    }

    var body: some View {
        AccountPage(title: "Use this address for tickets", spacing: 20) {
            Text("New mail to \(account.email) becomes tickets, read with the connection it already has.")
                .font(ODFont.callout)
                .foregroundStyle(Theme.fg3)
                .padding(.horizontal, 4)
                .fixedSize(horizontal: false, vertical: true)
            ChannelForm(title: "Ticket inbox") {
                ODTextField(label: "Name", text: $name, prompt: "Support")
                ChannelHint("How your team sees this inbox.")
                ChannelTeamMenu(label: "Team", teamID: $teamID)
                if store.brands.count > 1 {
                    ChannelMenuField(label: "Brand", value: store.brands.first { $0.id == brandID }?.name ?? store.brands.first(where: \.isDefault)?.name ?? "Default brand") {
                        ForEach(store.brands) { brand in Button(brand.name) { brandID = brand.id } }
                    }
                }
            }
            AccountSection {
                AccountToggleRow(
                    title: "Keep it in Mail too",
                    subtitle: keep ? "It stays in Mail as well; its new mail shows in both." : "It leaves Mail, so the same mail isn't in two places.",
                    isOn: $keep
                )
            }
            ChannelHint("Only mail that arrives from now on becomes tickets. What is already there stays in Mail.")
                .padding(.horizontal, 4)
            FormError(text: error)
            Button(action: submit) { ButtonLabel(title: "Use for tickets", busy: saving, symbol: "arrow.right") }
                .buttonStyle(InkButtonStyle())
                .disabled(saving)
        }
        .task {
            store.attach(env.session.api)
            await store.loadExtras(admin: true)
        }
    }

    private func submit() {
        saving = true
        error = nil
        var body: ChannelBody = ["keep_account": .bool(keep)]
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { body["name"] = .string(trimmed) }
        if let teamID { body["team_id"] = .string(teamID) }
        if let brandID { body["brand_id"] = .string(brandID) }
        Task {
            do {
                let answer: UseForTicketsAnswer = try await env.session.api.post("v1/collab/accounts/\(account.id)/use-for-tickets", body: body)
                Haptics.success()
                await onDone(answer.mailboxID)
            } catch {
                Haptics.error()
                self.error = (error as? APIError)?.detail ?? error.userMessage
            }
            saving = false
        }
    }
}

/// `POST /v1/collab/accounts/{id}/use-for-tickets` → `{mailbox_id, account_removed}`.
private struct UseForTicketsAnswer: Decodable, Sendable {
    var mailboxID: String
    var accountRemoved: Bool

    enum CodingKeys: String, CodingKey {
        case mailboxID = "mailbox_id"
        case accountRemoved = "account_removed"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        mailboxID = try c.decode(String.self, forKey: .mailboxID)
        accountRemoved = c.lenient(Bool.self, forKey: .accountRemoved) ?? false
    }
}

/// How the new inbox answers (an automatic reply, a signature, Ollie) and its own section in
/// the menu; then it opens.
private struct AddInboxReplies: View {
    let mailbox: SettingsMailbox
    let handedOver: Bool
    let store: MailboxSettingsStore
    let onDone: () -> Void

    @Environment(AppEnvironment.self) private var env
    @State private var autoReply: Bool
    @State private var subject: String
    @State private var message = "Thanks for writing to us. We'll get back to you soon."
    @State private var signature = ""
    @State private var ollie: Bool
    @State private var section = true
    @State private var saving = false
    @State private var error: String?

    init(mailbox: SettingsMailbox, handedOver: Bool, store: MailboxSettingsStore, onDone: @escaping () -> Void) {
        self.mailbox = mailbox
        self.handedOver = handedOver
        self.store = store
        self.onDone = onDone
        _autoReply = State(initialValue: mailbox.autoReplyEnabled)
        _subject = State(initialValue: mailbox.autoReplySubject.isEmpty ? "We got your message" : mailbox.autoReplySubject)
        _ollie = State(initialValue: mailbox.aiAnswers)
    }

    var body: some View {
        AccountPage(title: "How \(mailbox.label) answers", spacing: 20) {
            if handedOver {
                ChannelBanner(tone: .green, title: "\(mailbox.email) now takes tickets.")
            }
            if mailbox.inboundKind == "forwarding", !mailbox.forwardingAddress.isEmpty {
                ChannelForm(title: "Receiving") {
                    ChannelCopyField(label: "Forward mail for \(mailbox.email) to this address to start receiving it", text: mailbox.forwardingAddress)
                }
            }
            AccountSection {
                AccountToggleRow(title: "Send an automatic reply", subtitle: "Customers hear back at once that you got their message.", isOn: $autoReply)
            }
            if autoReply {
                ChannelForm {
                    ODTextField(label: "Subject", text: $subject)
                    AddInboxTextArea(label: "Message", text: $message)
                }
            }
            ChannelForm(title: "Signature", footer: "Under every reply from this address. More options in its settings.") {
                AddInboxTextArea(label: "Signature", text: $signature, prompt: "The support team")
            }
            AccountSection {
                if env.directory.ai.enabled {
                    AccountToggleRow(title: "Ollie answers emails", subtitle: "Ollie drafts an answer to each new email for your team to check.", isOn: $ollie)
                    AccountDivider(tiles: false)
                }
                AccountToggleRow(title: "Its own section in the menu", subtitle: "Its folders under its name, apart from Tickets.", isOn: $section)
            }
            FormError(text: error)
            Button(action: finish) { ButtonLabel(title: "Open the inbox", busy: saving) }
                .buttonStyle(InkButtonStyle())
                .disabled(saving)
        }
        .motion(Motion.snappy, value: autoReply)
    }

    private func finish() {
        saving = true
        error = nil
        var patch: ChannelBody = [:]
        if autoReply != mailbox.autoReplyEnabled { patch["auto_reply_enabled"] = .bool(autoReply) }
        if autoReply {
            patch["auto_reply_subject"] = .string(subject.trimmingCharacters(in: .whitespacesAndNewlines))
            patch["auto_reply_html"] = .string(HTMLText.html(fromPlain: message))
        }
        if !signature.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            patch["signature_html"] = .string(HTMLText.html(fromPlain: signature))
        }
        if env.directory.ai.enabled, ollie != mailbox.aiAnswers { patch["ai_answers"] = .bool(ollie) }
        Task {
            do {
                if !patch.isEmpty { try await store.patch(mailbox.id, patch) }
            } catch {
                Haptics.error()
                self.error = (error as? APIError)?.detail ?? error.userMessage
                saving = false
                return
            }
            if section { try? await env.directory.setInboxSection(mailbox.id, true) }
            Haptics.success()
            env.toasts.show("\(mailbox.label) is ready", kind: .success)
            saving = false
            onDone()
        }
    }
}

/// A few lines of plain text, styled like `ODTextField`.
private struct AddInboxTextArea: View {
    let label: String
    @Binding var text: String
    var prompt = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
            TextField(text: $text, axis: .vertical) { Text(prompt).foregroundStyle(Theme.fg4) }
                .font(ODFont.sans(16))
                .foregroundStyle(Theme.fg)
                .lineLimit(2...6)
                .padding(.horizontal, 13)
                .padding(.vertical, 12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        }
    }
}

extension AppEnvironment {
    /// Who may turn a Mail account into a ticket inbox (contracts/collab.md "Using an account
    /// for tickets"): a workspace admin, for an account they connected themselves.
    func canHandOver(_ account: MailAccount) -> Bool {
        guard session.isAdmin, let me = session.user?.id else { return false }
        return account.owner?.id == me
    }
}
