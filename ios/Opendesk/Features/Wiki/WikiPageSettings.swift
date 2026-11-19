import SwiftUI

/// A page's look and the names it goes by (contracts/wiki.md "Page settings", "Aliases",
/// "Verified pages"): cover, font, small text, full width, lock, aliases and verification.
/// Each change is saved at once and keeps the page's version, so nothing typed conflicts with it.
struct WikiPageSettingsSheet: View {
    let page: WikiPage
    /// The page as the change left it.
    let onChange: (WikiPage) -> Void

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var current: WikiPage?
    @State private var alias = ""
    @State private var busy = false

    private var store: WikiStore { WikiStore.shared }
    private var shown: WikiPage { current ?? page }
    private var canEdit: Bool { env.session.canWrite && !page.inTrash }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    if !canEdit {
                        Notice(text: "Viewers read a page's look; agents and admins change it.", symbol: "eye")
                    }
                    cover
                    look
                    aliases
                    verification
                }
                .padding(16)
                .disabled(!canEdit || busy)
            }
            .background(Theme.canvas.ignoresSafeArea())
            .navigationTitle("Page settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { SheetButton(.confirm, "Done") { dismiss() }.fontWeight(.semibold) }
            }
        }
    }

    // MARK: Cover

    private var cover: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Cover")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 8)], spacing: 8) {
                swatch(nil)
                ForEach(WikiCover.gradients, id: \.name) { gradient in swatch(gradient.name) }
            }
            if !shown.extras.cover.isEmpty, WikiCover.gradient(shown.extras.cover) == nil {
                Text("This page has a picture as its cover. Change it to a picture on the web.")
                    .font(ODFont.footnote)
                    .foregroundStyle(Theme.fg3)
            }
        }
    }

    private func swatch(_ name: String?) -> some View {
        let value = name.map { "gradient:\($0)" } ?? ""
        let on = shown.extras.cover == value
        return Button { save(WikiLookPatch(cover: value)) } label: {
            ZStack {
                if name != nil {
                    WikiCoverStrip(cover: value, icon: "", height: 46, apiBase: nil)
                } else {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.sunken)
                    Text("None").font(ODFont.sans(12.5, weight: .medium)).foregroundStyle(Theme.fg3)
                }
            }
            .frame(height: 46)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(on ? Theme.fg : Theme.line, lineWidth: on ? 2 : 1))
        }
        .buttonStyle(TapScaleStyle())
        .accessibilityLabel(name.map { "\($0.capitalized) cover" } ?? "No cover")
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // MARK: Look

    private var look: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Text")
            Panel {
                HStack {
                    Text("Font").font(ODFont.sans(15)).foregroundStyle(Theme.fg)
                    Spacer()
                    Picker("Font", selection: Binding(get: { shown.extras.font }, set: { save(WikiLookPatch(font: $0)) })) {
                        Text("Default").tag("default")
                        Text("Serif").tag("serif")
                        Text("Mono").tag("mono")
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 210)
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                Hairline(inset: 14)
                toggle("Small text", subtitle: nil, on: shown.extras.smallText) { save(WikiLookPatch(smallText: $0)) }
                Hairline(inset: 14)
                toggle("Full width", subtitle: "Wider text on a large screen.", on: shown.extras.fullWidth) { save(WikiLookPatch(fullWidth: $0)) }
                Hairline(inset: 14)
                toggle("Lock page", subtitle: "Opens read-only for everyone until someone unlocks it.", on: shown.locked) { save(WikiLookPatch(locked: $0)) }
            }
        }
    }

    private func toggle(_ title: String, subtitle: String?, on: Bool, set: @escaping (Bool) -> Void) -> some View {
        Toggle(isOn: Binding(get: { on }, set: set)) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(ODFont.sans(15)).foregroundStyle(Theme.fg)
                if let subtitle { Text(subtitle).font(ODFont.footnote).foregroundStyle(Theme.fg3) }
            }
        }
        .tint(Tone.green.solid)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(minHeight: 48)
    }

    // MARK: Aliases

    private var aliases: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Also called")
            Panel(padding: 12) {
                VStack(alignment: .leading, spacing: 10) {
                    if shown.extras.aliases.isEmpty {
                        Text("Other names find this page in search and links.").font(ODFont.sans(13.5)).foregroundStyle(Theme.fg3)
                    } else {
                        WikiChipFlow(spacing: 6) {
                            ForEach(shown.extras.aliases, id: \.self) { name in
                                Button { save(WikiLookPatch(aliases: shown.extras.aliases.filter { $0 != name })) } label: {
                                    Label(name, systemImage: "xmark")
                                }
                                .buttonStyle(ChipButtonStyle())
                                .accessibilityLabel("Remove \(name)")
                            }
                        }
                    }
                    if shown.extras.aliases.count < 10 {
                        HStack(spacing: 8) {
                            TextField("Add an alias", text: $alias)
                                .font(ODFont.sans(15))
                                .submitLabel(.done)
                                .onSubmit(addAlias)
                            Button("Add", action: addAlias)
                                .buttonStyle(ChipButtonStyle())
                                .disabled(alias.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }
                }
            }
        }
    }

    private func addAlias() {
        let name = alias.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !name.isEmpty else { return }
        alias = ""
        guard !shown.extras.aliases.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) else { return }
        save(WikiLookPatch(aliases: shown.extras.aliases + [String(name.prefix(100))]))
    }

    // MARK: Verification

    private var verification: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel("Verified")
            Panel(padding: 12) {
                VStack(alignment: .leading, spacing: 10) {
                    if let verified = shown.verification {
                        WikiVerifiedLine(verification: verified)
                        Button("Remove verification") { save(WikiLookPatch(verified: false)) }
                            .buttonStyle(OutlineButtonStyle(fullWidth: false, height: 34))
                    } else {
                        Text("Vouch that this page is right, for a while or until someone changes it.")
                            .font(ODFont.sans(13.5))
                            .foregroundStyle(Theme.fg3)
                    }
                    Menu {
                        Button("Until someone changes it") { save(WikiLookPatch(verified: true)) }
                        ForEach([7, 30, 90, 180, 365], id: \.self) { days in
                            Button("For \(Format.plural(days, "day"))") { save(WikiLookPatch(verified: true, verifiedDays: days)) }
                        }
                    } label: {
                        Text(shown.verification == nil ? "Verify this page" : "Verify again")
                    }
                    .buttonStyle(InkButtonStyle(fullWidth: false, height: 34))
                }
            }
        }
    }

    // MARK: Saving

    private func save(_ patch: WikiLookPatch) {
        busy = true
        Haptics.selection()
        Task {
            defer { busy = false }
            do {
                let fresh = try await store.setLook(page.id, patch)
                current = fresh
                onChange(fresh)
            } catch {
                Haptics.error()
                env.toasts.error(error)
            }
        }
    }
}

/// A page's cover: one of the app's gradients, or a picture, with the page's icon over it.
struct WikiCoverStrip: View {
    let cover: String
    let icon: String
    var height: CGFloat = 120
    /// Makes our attachments' addresses whole.
    let apiBase: URL?

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let gradient = WikiCover.gradient(cover) {
                LinearGradient(colors: [Color(hex: gradient.from), Color(hex: gradient.to)], startPoint: .topLeading, endPoint: .bottomTrailing)
            } else if let url = imageURL {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFill()
                } placeholder: {
                    Theme.sunken
                }
            } else {
                Theme.sunken
                if !icon.isEmpty {
                    Text(icon).font(.system(size: height * 0.4)).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .frame(height: height)
        .frame(maxWidth: .infinity)
        .clipped()
        .accessibilityHidden(true)
    }

    private var imageURL: URL? {
        guard !cover.isEmpty, !cover.hasPrefix("gradient:") else { return nil }
        if cover.hasPrefix("/"), let apiBase {
            let base = apiBase.absoluteString.hasSuffix("/") ? String(apiBase.absoluteString.dropLast()) : apiBase.absoluteString
            return URL(string: base + cover)
        }
        guard let url = URL(string: cover), url.scheme?.lowercased() == "https" else { return nil }
        return url
    }
}
