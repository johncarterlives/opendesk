import SwiftUI

/// Settings › Brands and widgets (contracts/teams.md): what customers see. Each brand has its
/// addresses, chat widgets and help center; one is the default. `Detail` opens a brand by id,
/// or a widget as `widget/<id>`.
struct BrandsSettings: View {
    @Environment(AppEnvironment.self) private var env
    @State private var store = BrandsStore()
    @State private var creating = false

    var body: some View {
        AccountPage(title: "Brands") {
            Text("What customers see: a name, colour and logo, the addresses that belong to it, its chat widgets and its help center.")
                .font(ODFont.callout)
                .foregroundStyle(Theme.fg3)
                .padding(.horizontal, 4)
            if !env.session.isAdmin {
                EmptyState(symbol: "lock", title: "Only admins can see brands", message: "Ask a workspace admin to change brands, chat widgets and help centers.")
                    .padding(.top, 20)
            } else {
                ChannelLoading(loaded: store.loaded, error: store.brands.isEmpty ? store.error : nil, retry: reload) {
                    if store.brands.count == 1 {
                        Notice(text: "You have one brand. Add another when you support a second product, and brand pickers appear across opendesk.", tone: .blue)
                    }
                    AccountSection(title: ChannelFormat.plural(store.brands.count, "brand")) {
                        ForEach(Array(store.sortedBrands.enumerated()), id: \.element.id) { index, brand in
                            if index > 0 { AccountDivider() }
                            SettingsDetailLink(page: .brands, id: brand.id) { BrandRow(brand: brand) }
                        }
                    }
                }
            }
        }
        .toolbar {
            if env.session.isAdmin {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { creating = true } label: { Image(systemName: "plus") }.accessibilityLabel("New brand")
                }
            }
        }
        .sheet(isPresented: $creating) {
            BrandNewSheet(store: store) { brand in env.router.openSetting(.brands, id: brand.id) }
        }
        .refreshable { await store.load() }
        .onAppear {
            store.attach(env.session.api)
            if env.session.isAdmin { reload() }
        }
    }

    private func reload() { Task { await store.load() } }

    struct Detail: View {
        let id: String

        var body: some View {
            if id.hasPrefix("widget/") {
                WidgetDetailView(widgetID: String(id.dropFirst(7)))
            } else {
                BrandDetailView(brandID: id)
            }
        }
    }
}

/// A brand's mark: its first letter on its colour.
struct ChannelBrandMark: View {
    let name: String
    let color: String
    var size: CGFloat = 30

    var body: some View {
        let fill = ChannelColor.color(color) ?? Theme.fg
        Text(name.first.map { String($0).uppercased() } ?? "?")
            .font(ODFont.sans(size * 0.45, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(fill, in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
            .accessibilityHidden(true)
    }
}

private struct BrandRow: View {
    let brand: SettingsBrand

    var body: some View {
        HStack(spacing: 12) {
            ChannelBrandMark(name: brand.name, color: brand.color)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(brand.name).font(ODFont.sans(15.5, weight: .medium)).foregroundStyle(Theme.fg).lineLimit(1)
                    if brand.isDefault { TonePill(text: "Default", tone: .blue, height: 19) }
                }
                Text(brand.shortURL).font(ODFont.mono(11.5)).foregroundStyle(Theme.fg3).lineLimit(1)
                Text([ChannelFormat.plural(brand.mailboxCount, "address", "addresses"), ChannelFormat.plural(brand.widgetCount, "widget"), brand.helpEnabled ? "Help center on" : "Help center off"].joined(separator: " · "))
                    .font(ODFont.sans(12)).foregroundStyle(Theme.fg3).lineLimit(1)
            }
            Spacer(minLength: 4)
            Chevron()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}

/// "New brand": a name, its help center address and a colour.
private struct BrandNewSheet: View {
    let store: BrandsStore
    let created: (SettingsBrand) -> Void

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var slug = ""
    @State private var slugTouched = false
    @State private var color = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        let shown = slugTouched ? slug : BrandsStore.slugify(name)
        let slugBad = !shown.isEmpty && !ChannelValidate.slug(shown)
        ChannelSheet(title: "New brand", subtitle: "A brand is a product or company you support from this workspace.") {
            ODTextField(label: "Name", text: Binding(get: { name }, set: { name = String($0.prefix(60)) }), prompt: "Pressroom")
            VStack(alignment: .leading, spacing: 6) {
                ODTextField(label: "Help center address", text: Binding(get: { shown }, set: { slugTouched = true; slug = String($0.lowercased().prefix(40)) }), prompt: "pressroom")
                if slugBad {
                    FormError(text: "Use 3 to 40 lowercase letters, numbers and dashes.")
                } else {
                    ChannelHint("Its help center lives at \(BrandsStore.withSlug(store.brands.first, shown.isEmpty ? "your-brand" : shown)).")
                }
            }
            ChannelColorField(label: "Colour", hex: $color, hint: "Used by its widgets, help center and emails unless they set their own.", fallback: env.session.workspace?.workspace.settings?.brandColor)
            FormError(text: error)
            Button(action: create) { ButtonLabel(title: "Create brand", busy: saving) }
                .buttonStyle(InkButtonStyle())
                .disabled(saving || slugBad)
        }
    }

    private func create() {
        let shown = slugTouched ? slug : BrandsStore.slugify(name)
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { error = "Give the brand a name."; return }
        guard ChannelValidate.slug(shown) else { error = "Use 3 to 40 lowercase letters, numbers and dashes."; return }
        saving = true
        error = nil
        Task {
            do {
                let brand = try await store.createBrand(["name": .string(name.trimmingCharacters(in: .whitespaces)), "slug": .string(shown), "color": .string(color)])
                Haptics.success()
                env.toasts.show("\(brand.name) created", kind: .success)
                dismiss()
                created(brand)
            } catch {
                Haptics.error()
                self.error = (error as? APIError)?.detail ?? error.userMessage
            }
            saving = false
        }
    }
}

// MARK: - Store

@MainActor
@Observable
final class BrandsStore {
    private(set) var brands: [SettingsBrand] = []
    private(set) var mailboxes: [SettingsMailbox] = []
    private(set) var widgets: [ChatWidget] = []
    private(set) var bots: [ChannelBotOption] = []
    private(set) var loaded = false
    private(set) var error: String?

    @ObservationIgnored private var api: APIClient?

    func attach(_ api: APIClient) { self.api = api }

    var sortedBrands: [SettingsBrand] {
        brands.sorted { a, b in a.isDefault != b.isDefault ? a.isDefault : a.position < b.position }
    }

    func brand(_ id: String) -> SettingsBrand? { brands.first { $0.id == id } }
    func widget(_ id: String) -> ChatWidget? { widgets.first { $0.id == id } }
    func widgets(of brandID: String) -> [ChatWidget] { widgets.filter { $0.brandID == brandID }.sorted { $0.position < $1.position } }
    func mailboxes(of brandID: String) -> [SettingsMailbox] { mailboxes.filter { $0.brandID == brandID } }

    func load() async {
        guard let api else { return }
        let limit = [URLQueryItem(name: "limit", value: "100")]
        do {
            let page: ChannelList<SettingsBrand> = try await api.get("v1/brands", query: limit)
            brands = page.data
            async let boxes: ChannelList<SettingsMailbox>? = try? api.get("v1/mailboxes", query: limit)
            async let widgetPage: ChannelList<ChatWidget>? = try? api.get("v1/widgets", query: limit)
            async let botPage: ChannelList<ChannelBotOption>? = try? api.get("v1/bots")
            if let page = await boxes { mailboxes = page.data }
            if let page = await widgetPage { widgets = page.data }
            if let page = await botPage { bots = page.data }
            error = nil
        } catch {
            if !error.isCancellation { self.error = error.userMessage }
        }
        loaded = true
    }

    private func upsert(_ brand: SettingsBrand) {
        if let index = brands.firstIndex(where: { $0.id == brand.id }) { brands[index] = brand } else { brands.append(brand) }
    }

    private func upsert(_ widget: ChatWidget) {
        if let index = widgets.firstIndex(where: { $0.id == widget.id }) { widgets[index] = widget } else { widgets.append(widget) }
    }

    private func refreshBrands() async {
        guard let api else { return }
        if let page: ChannelList<SettingsBrand> = try? await api.get("v1/brands", query: [URLQueryItem(name: "limit", value: "100")]) { brands = page.data }
    }

    // MARK: Brands

    func createBrand(_ body: ChannelBody) async throws -> SettingsBrand {
        guard let api else { throw CancellationError() }
        let brand: SettingsBrand = try await api.post("v1/brands", body: body, idempotencyKey: UUID().uuidString)
        upsert(brand)
        return brand
    }

    func patchBrand(_ id: String, _ body: ChannelBody) async throws -> SettingsBrand {
        guard let api else { throw CancellationError() }
        let brand: SettingsBrand = try await api.patch("v1/brands/\(id)", body: body)
        upsert(brand)
        return brand
    }

    func makeDefault(_ id: String) async throws {
        guard let api else { return }
        let _: SettingsBrand = try await api.post("v1/brands/\(id)/default")
        await refreshBrands()
    }

    func deleteBrand(_ id: String) async throws {
        guard let api else { return }
        try await api.delete("v1/brands/\(id)")
        brands.removeAll { $0.id == id }
        widgets.removeAll { $0.brandID == id }
    }

    func setDomain(_ id: String, hostname: String) async throws -> SettingsBrand {
        guard let api else { throw CancellationError() }
        let brand: SettingsBrand = try await api.send(APIRequest(method: "PUT", path: "v1/brands/\(id)/help-domain", body: try APICoding.encoder.encode(["hostname": hostname]), timeout: 60))
        upsert(brand)
        return brand
    }

    func checkDomain(_ id: String) async throws -> SettingsBrand {
        guard let api else { throw CancellationError() }
        let brand: SettingsBrand = try await api.post("v1/brands/\(id)/help-domain/check")
        upsert(brand)
        return brand
    }

    func removeDomain(_ id: String) async throws {
        guard let api else { return }
        try await api.delete("v1/brands/\(id)/help-domain")
        await refreshBrands()
    }

    // MARK: Widgets

    func createWidget(_ body: ChannelBody) async throws -> ChatWidget {
        guard let api else { throw CancellationError() }
        let widget: ChatWidget = try await api.post("v1/widgets", body: body, idempotencyKey: UUID().uuidString)
        upsert(widget)
        await refreshBrands()
        return widget
    }

    func patchWidget(_ id: String, _ body: ChannelBody) async throws -> ChatWidget {
        guard let api else { throw CancellationError() }
        let widget: ChatWidget = try await api.patch("v1/widgets/\(id)", body: body)
        upsert(widget)
        return widget
    }

    func deleteWidget(_ id: String) async throws {
        guard let api else { return }
        try await api.delete("v1/widgets/\(id)")
        widgets.removeAll { $0.id == id }
        await refreshBrands()
    }

    func rotateSecret(_ id: String) async throws -> String {
        guard let api else { throw CancellationError() }
        let answer: JSONValue = try await api.post("v1/widgets/\(id)/secret/rotate")
        return answer["secret"]?.string ?? ""
    }

    // MARK: Helpers

    nonisolated static func slugify(_ text: String) -> String {
        let folded = text.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).lowercased()
        var out = ""
        var dash = false
        for scalar in folded.unicodeScalars {
            if ("a" ... "z").contains(scalar) || ("0" ... "9").contains(scalar) {
                out.unicodeScalars.append(scalar)
                dash = false
            } else if !dash, !out.isEmpty {
                out.append("-")
                dash = true
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return String(out.prefix(40))
    }

    /// An address without its scheme, for display.
    nonisolated static func bare(_ url: String) -> String {
        var out = url.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
        while out.hasSuffix("/") { out.removeLast() }
        return out
    }

    /// A brand's default address with another slug, as the server will build it.
    nonisolated static func withSlug(_ brand: SettingsBrand?, _ slug: String) -> String {
        guard let brand, !brand.helpDefaultURL.isEmpty else { return "help/\(slug)" }
        let url = brand.helpDefaultURL
        let host = URL(string: url)?.host() ?? ""
        if host.hasPrefix("\(brand.slug).") { return bare(url.replacingOccurrences(of: "//\(brand.slug).", with: "//\(slug).")) }
        if let range = url.range(of: "/help/\(brand.slug)", options: .backwards) { return bare(url.replacingCharacters(in: range, with: "/help/\(slug)")) }
        return bare(url)
    }

    /// Whether the slug sits before the host (`<slug>.help.example`) or after `/help/`.
    nonisolated static func slugIsSubdomain(_ brand: SettingsBrand) -> Bool {
        (URL(string: brand.helpDefaultURL)?.host() ?? "").hasPrefix("\(brand.slug).")
    }

    nonisolated static let locales: [(String, String)] = [
        ("en", "English"), ("es", "Español"), ("fr", "Français"), ("de", "Deutsch"), ("pt", "Português"), ("it", "Italiano"),
        ("nl", "Nederlands"), ("pl", "Polski"), ("cs", "Čeština"), ("ja", "日本語"), ("zh-CN", "简体中文"), ("ko", "한국어"), ("tr", "Türkçe"), ("az", "Azərbaycanca"), ("ar", "العربية"),
    ]
}
