import PhotosUI
import SwiftUI
import UIKit

/// Settings › General: the workspace's name, logo, time zone and language, the products it
/// uses, the help center, conversation rules, pictures, reports, status names, and for the
/// owner, transferring and deleting the workspace (web `WorkspaceSettings.tsx`).
struct GeneralSettings: View {
    @Environment(AppEnvironment.self) private var env
    @State private var store = GeneralSettingsStore()
    @State private var pickingZone = false
    @State private var editingSnooze = false
    @State private var editingDisplay = false
    @State private var photoSlot: String?
    @State private var picking = false
    @State private var photo: PhotosPickerItem?
    @State private var confirm: AccountConfirm?
    @State private var reauth: AccountStore.ReauthPrompt?
    @State private var deleting = false
    @State private var web: AccountWebPage?

    private var admin: Bool { env.session.isAdmin }
    private var owner: Bool { env.session.role == .owner }

    var body: some View {
        AccountPage(title: "General") {
            if let info = store.info {
                if !admin { SettingsReadOnlyNote() }
                identity(info)
                products(info)
                helpCenter(info)
                conversations(info)
                pictures
                reports
                display
                if admin { WSStarterSpaceSection() }
                if owner { danger(info) }
            } else if let error = store.error {
                ErrorState(message: error) { Task { await store.load() } }
            } else {
                WSLoading(rows: 5)
            }
        }
        .refreshable { await store.load() }
        .task {
            store.attach(env.session.api)
            await store.load()
        }
        .settingsSaveBar(dirty: store.dirty && admin, saving: store.saving, canSave: store.valid, save: save) { store.discard() }
        #if DEBUG
        // The QA harness's `/demo/settings-edit`: a name not saved yet, for the save bar.
        .onChange(of: env.router.demoAction, initial: true) { _, action in
            guard action == "settings-edit", store.info != nil else { return }
            env.router.demoAction = nil
            store.draft.name += " HQ"
        }
        #endif
        .sheet(isPresented: $pickingZone) {
            WSTimeZonePicker(title: "Timezone", selection: store.draft.timezone) { store.draft.timezone = $0 }
        }
        .sheet(isPresented: $editingSnooze) {
            WSSnoozeEditor(presets: $store.draft.snoozePresets, disabled: !admin)
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(isPresented: $editingDisplay) {
            WSDisplayEditor(statuses: $store.draft.statusLabels, priorities: $store.draft.priorityLabels, disabled: !admin)
                .presentationDetents([.large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(isPresented: $deleting) {
            WSDeleteWorkspaceSheet(name: store.info?.name ?? "")
                .presentationDetents([.medium, .large])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(item: $reauth) { prompt in
            AccountReauthSheet(prompt: prompt)
                .presentationDetents([.medium])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .photosPicker(isPresented: $picking, selection: $photo, matching: .images, preferredItemEncoding: .compatible)
        .onChange(of: photo) { _, item in
            guard let item, let slot = photoSlot else { return }
            upload(item, slot: slot)
        }
        .accountConfirm($confirm)
        .accountWebSheet($web)
        .onChange(of: env.session.workspace?.workspace) { _, _ in
            // Someone saved elsewhere: take their version unless this page has edits.
            if !store.dirty { Task { await store.load() } }
        }
    }

    // MARK: Workspace

    private func identity(_ info: WSWorkspaceInfo) -> some View {
        AccountSection(footer: "The logo shows in the workspace switcher, in emails and on the help center.") {
            imageRow(title: "Logo", subtitle: "Square, at least 128 pixels.", url: info.avatarURL, slot: "logo", name: info.name)
            AccountDivider(tiles: false)
            WSPanelField(label: "Workspace name", text: $store.draft.name, prompt: "Acme", disabled: !admin)
            AccountDivider(tiles: false)
            AccountRow(title: "Workspace URL", subtitle: "Used by the help center and the chat widget.") {
                Text(info.slug).font(ODFont.mono(13)).foregroundStyle(Theme.fg2)
            }
            AccountDivider(tiles: false)
            Button { pickingZone = true } label: {
                AccountRow(title: "Timezone", subtitle: "Reports, SLA business days and timestamps in emails use it.") {
                    AccountDisclosure(value: store.draft.timezone.replacingOccurrences(of: "_", with: " "))
                }
            }
            .buttonStyle(RowPressStyle())
            .disabled(!admin)
            AccountDivider(tiles: false)
            WSMenuRow(
                title: "Customer language",
                subtitle: "The help center, satisfaction survey and chat widget follow each visitor's browser language. This one is used when we don't support theirs.",
                options: WSLocales.all.map(\.code),
                selection: $store.draft.locale,
                label: { WSLocales.name($0) },
                disabled: !admin
            )
            AccountDivider(tiles: false)
            AccountToggleRow(
                title: "Use for everyone",
                subtitle: "Show the help center, satisfaction survey and chat widget in \(WSLocales.name(store.draft.locale)) for every visitor, whatever their browser language. A brand with its own language uses that one.",
                isOn: $store.draft.localeFixed,
                disabled: !admin
            )
        }
    }

    private func imageRow(title: String, subtitle: String, url: String?, slot: String, name: String) -> some View {
        AccountRow(title: title, subtitle: subtitle) {
            HStack(spacing: 10) {
                WSImageThumb(url: url, name: name, busy: store.uploading == slot)
                if admin {
                    Menu {
                        Button(url == nil ? "Upload an image" : "Replace image", systemImage: "photo.on.rectangle") {
                            photoSlot = slot
                            picking = true
                        }
                        if url != nil {
                            Button("Remove", systemImage: "trash", role: .destructive) { remove(slot) }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.system(size: 18))
                            .foregroundStyle(Theme.fg3)
                            .frame(width: 32, height: 32)
                    }
                    .accessibilityLabel("\(title) options")
                }
            }
        }
    }

    // MARK: Products

    private func products(_ info: WSWorkspaceInfo) -> some View {
        let mailUsable = info.mailUsable
        let mailHint: String = switch info.mailDisabledReason {
        case "instance_disabled": "Mail is turned off for this instance."
        case "plan": "Mail is not part of this workspace\u{2019}s plan."
        default: "Members\u{2019} own mail accounts, synced with their inboxes."
        }
        // At least one product stays on (contracts/pages.md "The product"): the last one on is locked.
        let mailOn = store.draft.mailEnabled && mailUsable
        let ticketsLocked = store.draft.ticketsEnabled && !mailOn && !store.draft.pagesEnabled
        let mailLocked = !mailUsable || (mailOn && !store.draft.ticketsEnabled && !store.draft.pagesEnabled)
        let pagesLocked = store.draft.pagesEnabled && !store.draft.ticketsEnabled && !mailOn
        return AccountSection(title: "Products", footer: "Choose what this workspace uses. At least one stays on.") {
            AccountToggleRow(
                symbol: "tray", tone: .blue, title: "Tickets",
                subtitle: "Shared inboxes, live chat, the help center and reports. Turn it off to hide them and pause new ticket work.",
                isOn: $store.draft.ticketsEnabled, disabled: !admin || ticketsLocked
            )
            AccountDivider()
            AccountToggleRow(
                symbol: "envelope", tone: .indigo, title: "Mail", subtitle: mailHint,
                isOn: Binding(get: { store.draft.mailEnabled && mailUsable }, set: { store.draft.mailEnabled = $0 }),
                disabled: !admin || mailLocked
            )
            AccountDivider()
            AccountToggleRow(
                symbol: "doc.richtext", tone: .violet, title: "Pages",
                subtitle: "Your workspace\u{2019}s own pages, databases and canvases, beside the wiki.",
                isOn: $store.draft.pagesEnabled, disabled: !admin || pagesLocked
            )
            if !store.draft.ticketsEnabled || !store.draft.mailEnabled || !store.draft.pagesEnabled {
                AccountDivider()
                AccountRow(
                    symbol: "checkmark.shield", tone: .green, title: "Nothing is deleted",
                    subtitle: "Tickets, mail, pages and connections are kept while a product is off. Incoming email, calls and chat messages wait and resume when Tickets is back on."
                )
            }
        }
    }

    // MARK: Help center

    private func helpCenter(_ info: WSWorkspaceInfo) -> some View {
        AccountSection(title: "Help center", footer: "A public site with your published knowledge base articles.") {
            AccountToggleRow(
                title: "Publish the help center",
                subtitle: store.draft.helpCenterEnabled ? "Anyone with the link can read published articles." : "Only your team can see articles.",
                isOn: $store.draft.helpCenterEnabled, disabled: !admin
            )
            AccountDivider(tiles: false)
            imageRow(title: "Help center logo", subtitle: "A wide logo for the help center header. Without one, the workspace logo and name are used.", url: info.helpCenterLogo, slot: "help_center_logo", name: store.draft.helpCenterTitle.isEmpty ? info.name : store.draft.helpCenterTitle)
            AccountDivider(tiles: false)
            imageRow(title: "Favicon", subtitle: "The small icon in the browser tab.", url: info.helpCenterFavicon, slot: "help_center_favicon", name: info.name)
            AccountDivider(tiles: false)
            WSPanelField(label: "Title", text: $store.draft.helpCenterTitle, prompt: "\(info.name) Help", disabled: !admin, counter: 80)
            if let url = store.helpURL {
                AccountDivider(tiles: false)
                Button {
                    web = URL(string: url).map(AccountWebPage.init)
                } label: {
                    AccountRow(title: "Public address") {
                        HStack(spacing: 6) {
                            Text(url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: ""))
                                .font(ODFont.mono(12.5))
                                .foregroundStyle(Theme.fg2)
                                .lineLimit(1)
                            Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.fg4)
                        }
                    }
                }
                .buttonStyle(RowPressStyle())
                .contextMenu {
                    Button("Copy link", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = url
                        env.toasts.show("Link copied", kind: .success)
                    }
                }
            }
        }
    }

    // MARK: Conversations

    private func conversations(_ info: WSWorkspaceInfo) -> some View {
        let undo = [0, 5, 10, 20, 30]
        return AccountSection(title: "Conversations") {
            AccountToggleRow(title: "Satisfaction survey", subtitle: "Ask customers to rate the conversation after a ticket is solved.", isOn: $store.draft.csatEnabled, disabled: !admin)
            AccountDivider(tiles: false)
            segmentedRow("Undo send for email", hint: "Email replies wait this long before they go out, so they can be taken back or made a note.") {
                AccountSegmented(options: undo, selection: $store.draft.undoSendSeconds) { $0 == 0 ? "Off" : "\($0)s" }
            }
            AccountDivider(tiles: false)
            segmentedRow("Undo send for chat", hint: "Chat replies wait this long before the customer sees them. Off by default, so chat stays live.") {
                AccountSegmented(options: undo, selection: $store.draft.undoSendChatSeconds) { $0 == 0 ? "Off" : "\($0)s" }
            }
            AccountDivider(tiles: false)
            Button { editingSnooze = true } label: {
                AccountRow(title: "Snooze options", subtitle: store.draft.snoozePresets.map(\.label).joined(separator: ", ")) {
                    AccountDisclosure(value: "\(store.draft.snoozePresets.count)")
                }
            }
            .buttonStyle(RowPressStyle())
            AccountDivider(tiles: false)
            segmentedRow("Agents can delete messages", hint: "Own notes: agents delete their own internal notes. Any agent\u{2019}s: also every agent\u{2019}s notes and replies. A deleted message stays as a marker. Admins can delete any message, read deleted ones and restore them, and give an agent another rule in Members.") {
                AccountSegmented(options: ["off", "own", "all"], selection: $store.draft.messageDelete) {
                    switch $0 {
                    case "off": "Off"
                    case "all": "Any agent\u{2019}s"
                    default: "Own notes"
                    }
                }
            }
            if env.directory.collab.enabled {
                AccountDivider(tiles: false)
                AccountToggleRow(
                    title: "Reply from your own mail",
                    subtitle: "Members can answer an email ticket from one of their connected mail accounts instead of the ticket's address, one reply at a time. The customer's answers still come back to the ticket. Each mailbox can set its own rules.",
                    isOn: $store.draft.collabTicketReplies, disabled: !admin
                )
                if store.draft.collabTicketReplies {
                    AccountDivider(tiles: false)
                    segmentedRow("Where answers go", hint: "The Reply-To of such a reply, unless the member picks another. Their address: answers go to the address it was sent from and come back to the ticket from there. The ticket's address: answers go to the team's address like any email.") {
                        AccountSegmented(options: ["address", "mailbox"], selection: $store.draft.collabTicketReplyTo) {
                            $0 == "mailbox" ? "The ticket's address" : "Their address"
                        }
                    }
                }
            }
            AccountDivider(tiles: false)
            Button { env.router.accountPath.append(.setting(.assignment)) } label: {
                AccountRow(title: "Assignment", subtitle: assignModeHint(info.autoAssign)) {
                    AccountDisclosure(value: WSAssignModes.title(info.autoAssign))
                }
            }
            .buttonStyle(RowPressStyle())
            AccountDivider(tiles: false)
            AccountRow(title: "Brand colour", subtitle: store.draft.brandColorValid ? "Used by the chat widget and the buttons in outgoing email." : "Use a hex colour like #0A0A0A.") {
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color(hex: store.draft.brandColorValid && !store.draft.brandColor.isEmpty ? store.draft.brandColor : "#0a0a0a"))
                        .frame(width: 24, height: 24)
                        .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
                    TextField("#0A0A0A", text: Binding(
                        get: { store.draft.brandColor },
                        set: { value in
                            let trimmed = value.trimmingCharacters(in: .whitespaces)
                            store.draft.brandColor = String((!trimmed.isEmpty && !trimmed.hasPrefix("#") ? "#" + trimmed : trimmed).prefix(7))
                        }
                    ))
                    .font(ODFont.mono(14))
                    .foregroundStyle(store.draft.brandColorValid ? Theme.fg2 : Tone.red.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .frame(width: 86)
                    .disabled(!admin)
                }
            }
        }
    }

    private func assignModeHint(_ mode: String) -> String {
        switch mode {
        case "round_robin": "Round robin. Online teammates take turns."
        case "load_balanced": "Load balanced. New tickets go to whoever has the fewest open."
        default: "Off. New tickets wait in Unassigned until someone takes them."
        }
    }

    private func segmentedRow<Control: View>(_ title: String, hint: String, @ViewBuilder control: () -> Control) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(ODFont.sans(15.5)).foregroundStyle(Theme.fg)
            Text(hint).font(ODFont.footnote).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
            control()
                .disabled(!admin)
                .opacity(admin ? 1 : 0.6)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    // MARK: Pictures, reports, display

    private var pictures: some View {
        AccountSection(title: "Contact and company pictures", footer: "Pictures make the inbox easier to scan. Uploaded pictures always win.") {
            AccountToggleRow(title: "Gravatar pictures", subtitle: "Sends a hash of contact email addresses to Gravatar to look up their pictures.", isOn: $store.draft.gravatar, disabled: !admin)
            AccountDivider(tiles: false)
            AccountToggleRow(title: "Company logos", subtitle: "Fetches each company's logo from its website.", isOn: $store.draft.domainLogos, disabled: !admin)
        }
    }

    private var reports: some View {
        AccountSection(title: "Reports") {
            AccountToggleRow(
                title: "Agents' online time",
                subtitle: store.draft.agentOnlineTime
                    ? "Records the time each member has opendesk open with their status set to Online, for Reports \u{2192} Agents. Turn it off where recording it needs your team's consent or a works council's agreement."
                    : "No online time is recorded or shown in Reports. Saving with it off deletes the online time recorded so far.",
                isOn: $store.draft.agentOnlineTime, disabled: !admin
            )
        }
    }

    private var display: some View {
        let finish = StatusDisplay(WorkspaceSettings(statusLabels: store.draft.statusLabels)).sendAndFinish(note: false)
        let renamed = store.draft.statusLabels.values.filter { !($0.label ?? "").isEmpty || $0.color != nil || $0.hidden == true }.count
            + store.draft.priorityLabels.values.filter { !($0.label ?? "").isEmpty || $0.color != nil }.count
        return AccountSection(title: "Statuses and priorities", footer: "Rename or recolour them for your team, and hide the statuses you don't use from the menus agents pick from. A ticket already in a hidden status keeps it; filters, automations and the API keep working as before.") {
            Button { editingDisplay = true } label: {
                AccountRow(title: "Names and colours", subtitle: renamed == 0 ? "The standard names" : wsPlural(renamed, "1 changed", "\(renamed) changed")) {
                    AccountDisclosure()
                }
            }
            .buttonStyle(RowPressStyle())
            AccountDivider(tiles: false)
            AccountToggleRow(
                title: "\(finish) button",
                subtitle: "Show a button next to Send in the reply box that sends and solves the ticket in one click, not only in the menu beside it. It uses the workspace\u{2019}s finish label and always sets the status to solved.",
                isOn: $store.draft.sendAndFinishButton, disabled: !admin
            )
            AccountDivider(tiles: false)
            AccountToggleRow(
                title: "Severity",
                subtitle: store.draft.severityEnabled
                    ? "Tickets have a severity, Sev 1 to Sev 4, beside their priority. Turn it off if priority is enough for your team."
                    : "Severity is left out of tickets, lists, filters, views, bulk changes, automations, triage and reports, and Ollie no longer sets or suggests it. Tickets keep the severity they have; the API still reads and writes it.",
                isOn: $store.draft.severityEnabled, disabled: !admin
            )
        }
    }

    // MARK: Danger zone

    private func danger(_ info: WSWorkspaceInfo) -> some View {
        let candidates = env.directory.members.filter { $0.id != env.session.user?.id && $0.role != .viewer }
            .sorted { $0.user.name.localizedCaseInsensitiveCompare($1.user.name) == .orderedAscending }
        return AccountSection(title: "Danger zone") {
            Menu {
                ForEach(candidates) { member in
                    Button("\(member.user.name) (\(member.role.title))") { askTransfer(member) }
                }
            } label: {
                AccountRow(symbol: "person.badge.key", tone: .red, title: "Transfer ownership", subtitle: "Make another member the owner. You become an admin.") {
                    Text("Transfer").font(ODFont.sans(14.5, weight: .medium)).foregroundStyle(Tone.red.text)
                }
            }
            .buttonStyle(RowPressStyle())
            .disabled(candidates.isEmpty)
            AccountDivider()
            Button { deleting = true } label: {
                AccountRow(symbol: "trash", tone: .red, title: "Delete workspace", subtitle: "Removes every ticket, contact, article and setting. This can't be undone.", titleColor: Tone.red.text)
            }
            .buttonStyle(RowPressStyle())
        }
    }

    private func askTransfer(_ member: Member) {
        confirm = AccountConfirm(
            title: "Make \(member.user.name) the owner?",
            message: "They get full control, including deleting the workspace. You stay on as an admin.",
            confirmTitle: "Transfer ownership"
        ) {
            await transfer(member)
        }
    }

    private func transfer(_ member: Member) async {
        do {
            try await store.transfer(to: member.id)
            Haptics.success()
            env.toasts.show("Ownership transferred", kind: .success)
            try? await env.session.loadMe()
        } catch let failure where failure.wsNeedsReauth {
            reauth = AccountStore.ReauthPrompt(needsMFA: failure.wsNeedsMFA) {
                try await store.transfer(to: member.id)
                env.toasts.show("Ownership transferred", kind: .success)
                try? await env.session.loadMe()
            }
        } catch {
            env.toasts.error(error)
        }
    }

    // MARK: Actions

    private func save() {
        Task {
            do {
                try await store.save()
                Haptics.success()
                env.toasts.show("Workspace saved", kind: .success)
                try? await env.session.loadMe()
            } catch {
                Haptics.error()
                env.toasts.error(error)
            }
        }
    }

    private func upload(_ item: PhotosPickerItem, slot: String) {
        Task {
            defer {
                photo = nil
                photoSlot = nil
            }
            do {
                guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data),
                      let jpeg = image.wsScaled(maxSide: slot == "help_center_logo" ? 1200 : 512).jpegData(compressionQuality: 0.88) else {
                    env.toasts.show("That image couldn't be read. Try another one.", kind: .error)
                    return
                }
                try await store.upload(jpeg, slot: slot)
                Haptics.success()
                env.toasts.show("Image updated", kind: .success)
                if slot == "logo" { try? await env.session.loadMe() }
            } catch {
                env.toasts.error(error)
            }
        }
    }

    private func remove(_ slot: String) {
        Task {
            do {
                try await store.remove(slot: slot)
                env.toasts.show("Image removed", kind: .success)
                if slot == "logo" { try? await env.session.loadMe() }
            } catch {
                env.toasts.error(error)
            }
        }
    }

    struct Detail: View {
        let id: String

        var body: some View {
            GeneralSettings()
        }
    }
}

// MARK: - Store

@MainActor
@Observable
final class GeneralSettingsStore {
    private(set) var info: WSWorkspaceInfo?
    var draft = WSGeneralValues()
    private(set) var error: String?
    private(set) var saving = false
    private(set) var uploading: String?
    private(set) var helpURL: String?

    @ObservationIgnored private var api: APIClient?

    func attach(_ api: APIClient) { self.api = api }

    var dirty: Bool { info.map { $0.values != draft } ?? false }
    var valid: Bool { !draft.name.trimmingCharacters(in: .whitespaces).isEmpty && draft.brandColorValid && draft.helpCenterTitle.count <= 80 }

    func load() async {
        guard let api else { return }
        do {
            let fresh: WSWorkspaceInfo = try await api.get("v1/workspace")
            adopt(fresh)
            error = nil
            if let brands: WSList<WSBrandHelp> = try? await api.get("v1/brands"),
               let brand = brands.data.first(where: \.isDefault) ?? brands.data.first, !brand.url.isEmpty {
                helpURL = brand.url
            } else {
                helpURL = api.instance.webURL(path: "/help/\(fresh.slug)")?.absoluteString
            }
        } catch {
            if !error.isCancellation, info == nil { self.error = error.userMessage }
        }
    }

    private func adopt(_ fresh: WSWorkspaceInfo) {
        info = fresh
        draft = fresh.values
    }

    func discard() {
        if let info { draft = info.values }
    }

    /// Sends the name and only the settings that changed (the server merges them).
    func save() async throws {
        guard let api, let base = info?.values else { return }
        saving = true
        defer { saving = false }
        let d = draft
        var settings: [String: JSONValue] = [:]
        func put<T: Equatable & Encodable>(_ key: String, _ value: T, _ old: T) {
            if value != old { settings[key] = (try? JSONValue.from(value)) ?? .null }
        }
        put("tickets_enabled", d.ticketsEnabled, base.ticketsEnabled)
        put("mail_enabled", d.mailEnabled, base.mailEnabled)
        put("pages_enabled", d.pagesEnabled, base.pagesEnabled)
        put("timezone", d.timezone, base.timezone)
        put("locale", d.locale, base.locale)
        put("locale_fixed", d.localeFixed, base.localeFixed)
        put("help_center_enabled", d.helpCenterEnabled, base.helpCenterEnabled)
        put("help_center_title", d.helpCenterTitle.trimmingCharacters(in: .whitespaces), base.helpCenterTitle)
        put("csat_enabled", d.csatEnabled, base.csatEnabled)
        put("undo_send_seconds", d.undoSendSeconds, base.undoSendSeconds)
        put("undo_send_chat_seconds", d.undoSendChatSeconds, base.undoSendChatSeconds)
        if !WSSnoozePreset.same(d.snoozePresets, base.snoozePresets) {
            // The defaults are stored as an empty list, so the workspace follows them if they change.
            let list = WSSnoozePreset.same(d.snoozePresets, WSSnoozePreset.defaults) ? [] : d.snoozePresets.map(\.cleaned)
            settings["snooze_presets"] = (try? JSONValue.from(list)) ?? .array([])
        }
        put("message_delete", d.messageDelete, base.messageDelete)
        put("collab_ticket_replies", d.collabTicketReplies, base.collabTicketReplies)
        put("collab_ticket_reply_to", d.collabTicketReplyTo, base.collabTicketReplyTo)
        put("brand_color", d.brandColor, base.brandColor)
        put("gravatar", d.gravatar, base.gravatar)
        put("domain_logos", d.domainLogos, base.domainLogos)
        put("agent_online_time", d.agentOnlineTime, base.agentOnlineTime)
        put("status_labels", d.statusLabels, base.statusLabels)
        put("priority_labels", d.priorityLabels, base.priorityLabels)
        put("send_and_finish_button", d.sendAndFinishButton, base.sendAndFinishButton)
        put("severity_enabled", d.severityEnabled, base.severityEnabled)
        var body: [String: JSONValue] = [:]
        let name = d.name.trimmingCharacters(in: .whitespacesAndNewlines)
        if name != base.name { body["name"] = .string(name) }
        if !settings.isEmpty { body["settings"] = .object(settings) }
        guard !body.isEmpty else { return }
        let saved: WSWorkspaceInfo = try await api.patch("v1/workspace", body: JSONValue.object(body))
        adopt(saved)
    }

    func upload(_ data: Data, slot: String) async throws {
        guard let api else { return }
        uploading = slot
        defer { uploading = nil }
        let saved: WSWorkspaceInfo = try await api.send(WSUpload.image(data, path: "v1/workspace/images/\(slot)"))
        keepDraft(saved)
    }

    func remove(slot: String) async throws {
        guard let api else { return }
        uploading = slot
        defer { uploading = nil }
        let saved: WSWorkspaceInfo = try await api.send(APIRequest(method: "DELETE", path: "v1/workspace/images/\(slot)", body: nil, contentType: nil))
        keepDraft(saved)
    }

    /// New pictures without losing unsaved edits.
    private func keepDraft(_ saved: WSWorkspaceInfo) {
        let edits = draft
        let wasDirty = dirty
        info = saved
        draft = wasDirty ? edits : saved.values
    }

    func transfer(to userID: String) async throws {
        guard let api else { return }
        struct Body: Encodable, Sendable { let user_id: String }
        let _: EmptyBody = try await api.post("v1/workspace/transfer", body: Body(user_id: userID))
    }
}

// MARK: - Pieces

/// A small picture of the workspace's logo or a brand image, or its initials.
struct WSImageThumb: View {
    let url: String?
    let name: String
    var busy = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.active)
            if let url, let resolved = URL(string: url) {
                AsyncImage(url: resolved) { phase in
                    if case let .success(image) = phase { image.resizable().scaledToFit() }
                }
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            } else {
                Text(Format.initials(name)).font(ODFont.sans(13, weight: .semibold)).foregroundStyle(Theme.fg3)
            }
            if busy {
                RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.black.opacity(0.3))
                ProgressView().controlSize(.small).tint(.white)
            }
        }
        .frame(width: 40, height: 40)
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
    }
}

extension UIImage {
    /// The image no larger than `maxSide` on its long side.
    func wsScaled(maxSide: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxSide else { return self }
        let scale = maxSide / longest
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}

extension Color {
    /// `#rrggbb`, black when it isn't one.
    init(hex: String) {
        let raw = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        let value = UInt32(raw, radix: 16) ?? 0
        self.init(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }
}

/// The times a ticket's snooze menu offers, in order (web `SnoozePresetsEditor`).
struct WSSnoozeEditor: View {
    @Binding var presets: [WSSnoozePreset]
    var disabled = false

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(presets.indices, id: \.self) { index in
                        WSSnoozeRow(preset: $presets[index], disabled: disabled)
                            .listRowBackground(Theme.surface)
                    }
                    .onDelete(perform: disabled ? nil : { presets.remove(atOffsets: $0) })
                    .onMove(perform: disabled ? nil : { presets.move(fromOffsets: $0, toOffset: $1) })
                } footer: {
                    Text("The times a ticket\u{2019}s snooze menu offers, in this order, on each agent\u{2019}s own clock. Agents can still pick any other day and time.")
                }
                if !disabled {
                    Section {
                        if presets.count < WSSnoozePreset.max {
                            Button("Add a time", systemImage: "plus") {
                                presets.append(WSSnoozePreset(kind: .days, days: 1, time: "09:00"))
                            }
                        }
                        if !WSSnoozePreset.same(presets, WSSnoozePreset.defaults) {
                            Button("Restore the defaults", systemImage: "arrow.counterclockwise") { presets = WSSnoozePreset.defaults }
                        }
                    }
                    .listRowBackground(Theme.surface)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.chrome)
            .environment(\.editMode, .constant(disabled ? .inactive : .active))
            .navigationTitle("Snooze options")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(.confirm, "Done") { dismiss() }
                        .disabled(presets.isEmpty)
                }
            }
        }
    }
}

private struct WSSnoozeRow: View {
    @Binding var preset: WSSnoozePreset
    var disabled: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(preset.label).font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg)
            HStack(spacing: 10) {
                Menu {
                    Picker("Kind of time", selection: Binding(get: { preset.kind }, set: { kind in
                        preset = WSSnoozePreset(kind: kind, hours: kind == .hours ? 1 : nil, days: kind == .days ? 1 : nil, time: kind == .hours ? nil : (preset.time ?? "09:00"))
                    })) {
                        Text("In \u{2026} hours").tag(WSSnoozePreset.Kind.hours)
                        Text("In \u{2026} days").tag(WSSnoozePreset.Kind.days)
                        Text("Next week (Monday)").tag(WSSnoozePreset.Kind.week)
                    }
                } label: {
                    Text(preset.kind == .hours ? "Hours" : preset.kind == .days ? "Days" : "Next week")
                        .font(ODFont.sans(13.5, weight: .medium))
                }
                .buttonStyle(ChipButtonStyle())
                if preset.kind == .hours {
                    Stepper(value: Binding(get: { preset.hours ?? 1 }, set: { preset.hours = $0 }), in: 1 ... 168) {
                        Text(wsPlural(preset.hours ?? 1, "1 hour", "\(preset.hours ?? 1) hours")).font(ODFont.sans(13.5)).foregroundStyle(Theme.fg2)
                    }
                }
                if preset.kind == .days {
                    Stepper(value: Binding(get: { preset.days ?? 1 }, set: { preset.days = $0 }), in: 1 ... 365) {
                        Text(wsPlural(preset.days ?? 1, "1 day", "\(preset.days ?? 1) days")).font(ODFont.sans(13.5)).foregroundStyle(Theme.fg2)
                    }
                }
                if preset.kind != .hours {
                    Spacer(minLength: 0)
                    WSClockPicker(value: Binding(get: { preset.time ?? "09:00" }, set: { preset.time = $0 }))
                }
            }
            .disabled(disabled)
        }
        .padding(.vertical, 4)
    }
}

/// An "HH:MM" time of day as a compact time picker.
struct WSClockPicker: View {
    @Binding var value: String

    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar
    }()

    private var date: Binding<Date> {
        Binding(
            get: {
                let parts = value.split(separator: ":").compactMap { Int($0) }
                let hour = parts.first ?? 9
                let minute = parts.count > 1 ? parts[1] : 0
                return Self.calendar.date(from: DateComponents(year: 2000, month: 1, day: 1, hour: hour, minute: minute)) ?? .now
            },
            set: { date in
                let parts = Self.calendar.dateComponents([.hour, .minute], from: date)
                value = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
            }
        )
    }

    var body: some View {
        DatePicker("", selection: date, displayedComponents: .hourAndMinute)
            .labelsHidden()
            .environment(\.timeZone, TimeZone(identifier: "UTC") ?? .current)
            .environment(\.locale, Format.locale)
    }
}

/// Names, colours and hidden statuses for the fixed statuses and priorities.
struct WSDisplayEditor: View {
    @Binding var statuses: [String: DisplayOverride]
    @Binding var priorities: [String: DisplayOverride]
    var disabled = false

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("Statuses") {
                    ForEach(TicketStatus.allCases) { status in
                        WSOverrideRow(
                            name: status.title,
                            canHide: status != .open && status != .solved,
                            value: Binding(get: { statuses[status.rawValue] ?? DisplayOverride() }, set: { statuses[status.rawValue] = $0.wsCleaned }),
                            disabled: disabled
                        )
                    }
                }
                .listRowBackground(Theme.surface)
                Section("Priorities") {
                    ForEach(Priority.allCases) { priority in
                        WSOverrideRow(
                            name: priority.title,
                            canHide: false,
                            value: Binding(get: { priorities[priority.rawValue] ?? DisplayOverride() }, set: { priorities[priority.rawValue] = $0.wsCleaned }),
                            disabled: disabled
                        )
                    }
                }
                .listRowBackground(Theme.surface)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.chrome)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Statuses and priorities")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { SheetButton(.confirm, "Done") { dismiss() } }
            }
        }
    }
}

private struct WSOverrideRow: View {
    let name: String
    let canHide: Bool
    @Binding var value: DisplayOverride
    var disabled: Bool

    var body: some View {
        HStack(spacing: 10) {
            Menu {
                Button("Default colour") { value.color = nil }
                ForEach(WSColors.all, id: \.self) { color in
                    Button(color.capitalized) { value.color = color }
                }
            } label: {
                Circle()
                    .fill(value.color.map { Tone(label: $0).solid } ?? Theme.fg4)
                    .frame(width: 14, height: 14)
                    .padding(6)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Colour for \(name)")
            TextField(name, text: Binding(get: { value.label ?? "" }, set: { value.label = String($0.prefix(40)) }))
                .font(ODFont.sans(15.5))
                .foregroundStyle(value.hidden == true ? Theme.fg4 : Theme.fg)
            if canHide {
                Button {
                    value.hidden = value.hidden == true ? nil : true
                } label: {
                    Image(systemName: value.hidden == true ? "eye.slash" : "eye")
                        .font(.system(size: 14))
                        .foregroundStyle(value.hidden == true ? Theme.fg4 : Theme.fg3)
                        .frame(width: 30, height: 30)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(value.hidden == true ? "Show \(name) in the menus" : "Hide \(name) from the menus")
            }
        }
        .disabled(disabled)
    }
}

extension DisplayOverride {
    /// Empty fields left out, as the server stores them.
    var wsCleaned: DisplayOverride {
        let label = label?.isEmpty == true ? nil : label
        return DisplayOverride(label: label, color: color, hidden: hidden == true ? true : nil)
    }
}

/// Deleting the workspace: type its name, sign in again when asked.
struct WSDeleteWorkspaceSheet: View {
    let name: String

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""
    @State private var busy = false
    @State private var error: String?
    @State private var reauth: AccountStore.ReauthPrompt?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                AccountSheetHeader(title: "Delete workspace?", subtitle: "All of \(name)'s data is removed for everyone. Members lose access immediately.") { dismiss() }
                ODTextField(label: "Type \(name) to confirm", text: $typed, prompt: name, submitLabel: .done)
                FormError(text: error)
                Button(action: delete) { ButtonLabel(title: "Delete workspace", busy: busy) }
                    .buttonStyle(AccountDangerButtonStyle())
                    .disabled(typed.trimmingCharacters(in: .whitespaces) != name || busy)
            }
            .padding(22)
            .motion(Motion.snappy, value: error)
        }
        .background(Theme.surface)
        .sheet(item: $reauth) { prompt in
            AccountReauthSheet(prompt: prompt)
                .presentationDetents([.medium])
                .presentationCornerRadius(Theme.Radius.sheet)
        }
    }

    private func delete() {
        busy = true
        error = nil
        Task {
            do {
                try await run()
            } catch let failure where failure.wsNeedsReauth {
                reauth = AccountStore.ReauthPrompt(needsMFA: failure.wsNeedsMFA) { try await run() }
            } catch {
                Haptics.error()
                self.error = error.userMessage
            }
            busy = false
        }
    }

    private func run() async throws {
        struct Body: Encodable, Sendable { let confirm_name: String }
        try await env.session.api.delete("v1/workspace", body: Body(confirm_name: typed.trimmingCharacters(in: .whitespaces)))
        Haptics.success()
        dismiss()
        await env.session.membershipChanged()
    }
}
