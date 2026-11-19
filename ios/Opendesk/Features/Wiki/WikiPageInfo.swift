import SwiftUI

/// The page's panel (contracts/wiki.md "Links and tags", "Page analytics", "Favorites, recent
/// pages and readers"), as Obsidian shows one: its outline, the pages linking to it and those
/// naming it without a link, the pages it links to, its local graph, its tags, what it holds,
/// and how it was read. A page tapped here opens in place of the sheet.
struct WikiPageInfoSheet: View {
    let page: WikiPage
    /// The page's text as it is now (unsent typing included).
    let body_: String
    /// Opens a page behind the sheet once it closes.
    let onOpen: (String) -> Void
    let onTag: (String) -> Void

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var backlinks: [WikiSearchHit]?
    @State private var mentions: [WikiSearchHit]?
    @State private var links: [WikiGraphLink] = []
    @State private var analytics: WikiPageAnalytics?
    @State private var readers: WikiPageReaders?
    @State private var showReaders = false

    private var store: WikiStore { WikiStore.shared }

    init(page: WikiPage, body: String, onOpen: @escaping (String) -> Void, onTag: @escaping (String) -> Void) {
        self.page = page
        body_ = body
        self.onOpen = onOpen
        self.onTag = onTag
    }

    /// Pages it links to, and pages linking to it, from the graph.
    private var outgoing: [WikiNode] {
        var seen: [String] = []
        for link in links where link.from == page.id && link.to != page.id && !seen.contains(link.to) { seen.append(link.to) }
        return seen.compactMap { store.node($0) }
    }

    private var incoming: [WikiNode] {
        var seen: [String] = []
        for link in links where link.to == page.id && link.from != page.id && !seen.contains(link.from) { seen.append(link.from) }
        return seen.compactMap { store.node($0) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    holds
                    if !outline.isEmpty { outlineSection }
                    if !incoming.isEmpty || !outgoing.isEmpty { graphSection }
                    pages("Linked mentions", backlinks, empty: "No page links here yet.")
                    pages("Unlinked mentions", mentions, empty: "No other page names this one without a link.")
                    if !outgoing.isEmpty { nodes("Links to", outgoing) }
                    if !page.extras.tags.isEmpty { tagsSection }
                    readsSection
                }
                .padding(16)
            }
            .background(Theme.canvas.ignoresSafeArea())
            .navigationTitle("About this page")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { SheetButton(.confirm, "Done") { dismiss() }.fontWeight(.semibold) }
            }
            .sheet(isPresented: $showReaders) {
                if let readers { WikiReadersSheet(readers: readers) }
            }
        }
        .task { await load() }
    }

    // MARK: What it holds

    private var words: Int {
        HTMLText.plain(from: body_).split { $0.isWhitespace || $0.isNewline }.count
    }

    private var holds: some View {
        Panel {
            fact("Words", "\(words)")
            Hairline(inset: 14)
            fact("Reading time", words < 200 ? "Under a minute" : Format.plural(Int((Double(words) / 200).rounded()), "minute"))
            Hairline(inset: 14)
            fact("Created", [page.createdBy?.displayName, Format.fullDate(page.createdAt)].compactMap { $0 }.joined(separator: ", "))
            Hairline(inset: 14)
            fact("Last edited", [page.updatedBy?.displayName, Format.relLong(page.updatedAt)].compactMap { $0 }.joined(separator: ", "))
            if !page.extras.aliases.isEmpty {
                Hairline(inset: 14)
                fact("Also called", page.extras.aliases.joined(separator: ", "))
            }
        }
    }

    private func fact(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(ODFont.sans(14)).foregroundStyle(Theme.fg3)
            Spacer(minLength: 12)
            Text(value).font(ODFont.sans(14)).foregroundStyle(Theme.fg).multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 42)
        .accessibilityElement(children: .combine)
    }

    // MARK: Outline

    /// The page's headings, in order, with their level.
    private var outline: [(level: Int, text: String)] {
        guard let regex = try? NSRegularExpression(pattern: "<h([1-3])[^>]*>(.*?)</h\\1>", options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return [] }
        let range = NSRange(body_.startIndex..., in: body_)
        return regex.matches(in: body_, range: range).compactMap { match in
            guard let level = Range(match.range(at: 1), in: body_).flatMap({ Int(body_[$0]) }),
                  let inner = Range(match.range(at: 2), in: body_) else { return nil }
            let text = HTMLText.plain(from: String(body_[inner])).trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : (level, text)
        }
    }

    private var outlineSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel("Outline")
            Panel(padding: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(outline.enumerated()), id: \.offset) { _, heading in
                        Text(heading.text)
                            .font(ODFont.sans(heading.level == 1 ? 15 : 14, weight: heading.level == 1 ? .semibold : .regular))
                            .foregroundStyle(heading.level == 1 ? Theme.fg : Theme.fg2)
                            .padding(.leading, CGFloat(heading.level - 1) * 14)
                    }
                }
            }
        }
    }

    // MARK: Graph

    private var graphSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel("Local graph")
            WikiLocalGraph(center: page.node, neighbours: Array((incoming + outgoing.filter { node in !incoming.contains { $0.id == node.id } }).prefix(12))) { id in
                open(id)
            }
            .frame(height: 260)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        }
    }

    // MARK: Lists

    @ViewBuilder
    private func pages(_ title: String, _ hits: [WikiSearchHit]?, empty: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                SectionLabel(title)
                if let hits, !hits.isEmpty { Text("\(hits.count)").font(ODFont.mono(11.5)).foregroundStyle(Theme.fg4) }
            }
            Panel {
                if let hits {
                    if hits.isEmpty {
                        Text(empty).font(ODFont.sans(14)).foregroundStyle(Theme.fg3).padding(12)
                    } else {
                        ForEach(Array(hits.enumerated()), id: \.element.id) { index, hit in
                            if index > 0 { Hairline(inset: 44) }
                            Button { open(hit.id) } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    WikiPageIcon(icon: hit.icon, size: 16)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(hit.displayTitle).font(ODFont.sans(15)).foregroundStyle(Theme.fg).lineLimit(1)
                                        if !hit.snippet.isEmpty {
                                            Text(hit.snippet).font(ODFont.sans(12.5)).foregroundStyle(Theme.fg3).lineLimit(2)
                                        }
                                    }
                                    Spacer(minLength: 6)
                                    Chevron()
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(RowPressStyle())
                        }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 14)
                }
            }
        }
    }

    private func nodes(_ title: String, _ list: [WikiNode]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(title)
            Panel {
                ForEach(Array(list.enumerated()), id: \.element.id) { index, node in
                    if index > 0 { Hairline(inset: 44) }
                    Button { open(node.id) } label: {
                        HStack(spacing: 10) {
                            WikiPageIcon(icon: node.icon, size: 16, database: node.isDatabase)
                            Text(node.displayTitle).font(ODFont.sans(15)).foregroundStyle(Theme.fg).lineLimit(1)
                            Spacer(minLength: 6)
                            Chevron()
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(RowPressStyle())
                }
            }
        }
    }

    private var tagsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel("Tags")
            WikiChipFlow(spacing: 6) {
                ForEach(page.extras.tags, id: \.self) { tag in
                    Button("#\(tag)") {
                        dismiss()
                        onTag(tag)
                    }
                    .buttonStyle(ChipButtonStyle(tone: .blue))
                }
            }
        }
    }

    // MARK: Reads

    @ViewBuilder
    private var readsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel("Views in the last 28 days")
            Panel(padding: 12) {
                if let analytics {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("\(Format.plural(analytics.totalViews, "view")) by \(Format.plural(analytics.totalViewers, "person", "people"))")
                            .font(ODFont.sans(15, weight: .medium))
                            .foregroundStyle(Theme.fg)
                        WikiViewBars(days: analytics.days)
                            .frame(height: 54)
                        if let readers, !readers.readers.isEmpty {
                            Button("See who read it") { showReaders = true }
                                .buttonStyle(OutlineButtonStyle(fullWidth: false, height: 32))
                        }
                    }
                } else {
                    Text("Counting views…").font(ODFont.sans(14)).foregroundStyle(Theme.fg3)
                }
            }
        }
    }

    // MARK: Loading

    private func open(_ id: String) {
        dismiss()
        onOpen(id)
    }

    private func load() async {
        async let back = try? store.backlinks(page.id)
        async let named = try? store.unlinkedMentions(page.id)
        async let graph = try? store.graph()
        async let read = try? store.analytics(page.id)
        async let who = try? store.readers(page.id)
        backlinks = await back ?? []
        mentions = await named ?? []
        links = await graph ?? []
        analytics = await read
        readers = await who
    }
}

/// A bar per day, today last; each day reads out its count.
struct WikiViewBars: View {
    let days: [WikiPageAnalytics.Day]

    var body: some View {
        let most = max(1, days.map(\.views).max() ?? 1)
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(days) { day in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(day.views == 0 ? Theme.lineSoft : Tone.blue.solid)
                    .frame(maxWidth: .infinity)
                    .frame(height: max(3, 54 * CGFloat(day.views) / CGFloat(most)))
                    .accessibilityLabel("\(day.date): \(Format.plural(day.views, "view"))")
            }
        }
    }
}

/// The latest readers of a page and how often each came back.
struct WikiReadersSheet: View {
    let readers: WikiPageReaders
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(readers.readers) { reader in
                HStack(spacing: 10) {
                    Avatar(name: reader.user.displayName, url: reader.user.avatarURL, seed: reader.user.id, size: 30)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(reader.user.displayName).font(ODFont.sans(15)).foregroundStyle(Theme.fg)
                        Text("\(Format.plural(reader.visits, "visit")), last \(Format.relLong(reader.lastAt))")
                            .font(ODFont.footnote)
                            .foregroundStyle(Theme.fg3)
                    }
                }
                .listRowBackground(Theme.surface)
            }
            .listStyle(.plain)
            .navigationTitle("Readers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { SheetButton(.confirm, "Done") { dismiss() } }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// A page and the pages linked with it, around it, joined by lines; each opens on a tap.
struct WikiLocalGraph: View {
    let center: WikiNode
    let neighbours: [WikiNode]
    let onOpen: (String) -> Void

    var body: some View {
        GeometryReader { proxy in
            let middle = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
            let radius = min(proxy.size.width, proxy.size.height) / 2 - 34
            let points = neighbours.indices.map { index -> CGPoint in
                let angle = Double(index) / Double(max(1, neighbours.count)) * 2 * .pi - .pi / 2
                return CGPoint(x: middle.x + radius * cos(angle), y: middle.y + radius * sin(angle))
            }
            ZStack {
                Path { path in
                    for point in points {
                        path.move(to: middle)
                        path.addLine(to: point)
                    }
                }
                .stroke(Theme.lineStrong, lineWidth: 1)
                ForEach(Array(neighbours.enumerated()), id: \.element.id) { index, node in
                    Button { onOpen(node.id) } label: { dot(node, main: false) }
                        .buttonStyle(.plain)
                        .position(points[index])
                }
                dot(center, main: true).position(middle)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pages linked with \(center.displayTitle)")
    }

    private func dot(_ node: WikiNode, main: Bool) -> some View {
        VStack(spacing: 3) {
            Circle()
                .fill(main ? Tone.violet.solid : Theme.fg3)
                .frame(width: main ? 14 : 10, height: main ? 14 : 10)
            Text(node.displayTitle)
                .font(ODFont.sans(main ? 12.5 : 11.5, weight: main ? .semibold : .regular))
                .foregroundStyle(main ? Theme.fg : Theme.fg2)
                .lineLimit(1)
                .frame(maxWidth: 110)
        }
    }
}

