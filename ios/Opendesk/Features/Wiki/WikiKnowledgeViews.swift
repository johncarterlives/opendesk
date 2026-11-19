import SwiftUI

/// An area's tags, each with its pages (contracts/wiki.md "Links and tags"); `/` nests them.
/// The wiki's `/wiki/tags` and Pages' `/pages/tags`, pushed on the stack or in a sheet.
struct WikiTagsView: View {
    let area: WikiArea
    var tag: String?
    /// Opens a page; nil pushes it on the stack.
    var onOpen: ((String) -> Void)?

    @Environment(AppEnvironment.self) private var env
    @State private var tagged: [WikiTaggedNode] = []
    @State private var loaded = false
    @State private var picked: String?
    @State private var query = ""
    @State private var started = false

    private var counts: [(tag: String, count: Int)] {
        var counts: [String: Int] = [:]
        for page in tagged { for tag in page.tags { counts[tag, default: 0] += 1 } }
        return counts.map { ($0.key, $0.value) }.sorted { $0.tag < $1.tag }
    }

    var body: some View {
        List {
            if let picked {
                let pages = tagged.filter { page in page.tags.contains { $0 == picked || $0.hasPrefix(picked + "/") } }.map(\.node)
                ForEach(pages) { node in
                    Button { open(node.id) } label: {
                        HStack(spacing: 10) {
                            WikiPageIcon(icon: node.icon, size: 16, database: node.isDatabase)
                            Text(node.displayTitle).font(ODFont.sans(15)).foregroundStyle(Theme.fg)
                            Spacer()
                            Chevron()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Theme.surface)
                }
            } else if loaded, counts.isEmpty {
                EmptyState(symbol: "number", title: "No tags yet", message: "Write #something in a page to tag it.")
                    .listRowSeparator(.hidden)
                    .listRowBackground(Theme.surface)
            } else {
                ForEach(counts.filter { query.isEmpty || $0.tag.localizedCaseInsensitiveContains(query) }, id: \.tag) { item in
                    Button { picked = item.tag } label: {
                        HStack {
                            Text("#\(item.tag)")
                                .font(ODFont.sans(15, weight: .medium))
                                .foregroundStyle(Tone.blue.text)
                                .padding(.leading, CGFloat(item.tag.filter { $0 == "/" }.count) * 14)
                            Spacer()
                            Text("\(item.count)").font(ODFont.mono(12)).foregroundStyle(Theme.fg3)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(Theme.surface)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Theme.surface.ignoresSafeArea())
        .overlay { if !loaded { ProgressView() } }
        .searchable(text: $query, prompt: "Search tags")
        .navigationTitle(picked.map { "#\($0)" } ?? "Tags")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.visible, for: .navigationBar)
        .toolbar {
            if picked != nil, tag == nil {
                ToolbarItem(placement: .topBarLeading) { Button("All tags") { picked = nil } }
            }
        }
        .refreshable { await load() }
        .task {
            guard !started else { return }
            started = true
            picked = tag
            await load()
        }
    }

    private func load() async {
        WikiStore.shared.attach(env)
        tagged = (try? await WikiStore.shared.tagged(in: area)) ?? tagged
        loaded = true
    }

    private func open(_ id: String) {
        if let onOpen { onOpen(id) } else { env.router.push(.wikiPage(id)) }
    }
}

/// The tags in a sheet, with Done; a page opens behind it.
struct WikiTagsSheet: View {
    let area: WikiArea
    var tag: String?
    let onOpen: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WikiTagsView(area: area, tag: tag) { id in
                dismiss()
                onOpen(id)
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { SheetButton(.confirm, "Done") { dismiss() } }
            }
        }
    }
}

/// An area's graph (contracts/wiki.md "Links and tags", `/wiki/graph` and `/pages/graph`):
/// every page as a dot, sized by how many links it has, and every link as a line, laid out
/// once so linked pages sit together. It pans and zooms like a canvas; a dot opens its page.
struct WikiGraphView: View {
    let area: WikiArea

    @Environment(AppEnvironment.self) private var env
    @State private var layout: WikiGraphLayout?
    @State private var error: String?
    @State private var scale: CGFloat = 1
    @State private var pinch: CGFloat = 1
    @State private var orphans = true

    private var store: WikiStore { WikiStore.shared }
    private var zoom: CGFloat { min(3, max(0.2, scale * pinch)) }

    var body: some View {
        Group {
            if let layout {
                if layout.nodes.isEmpty {
                    EmptyState(symbol: "point.3.connected.trianglepath.dotted", title: "No pages yet", message: "Pages and the links between them show here.")
                        .frame(maxHeight: .infinity)
                } else {
                    graph(layout)
                }
            } else if let error {
                ErrorState(title: "Couldn't draw the graph", message: error) { Task { await load() } }
                    .frame(maxHeight: .infinity)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.sunken.ignoresSafeArea())
        .navigationTitle("Graph")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Toggle("Pages without links", isOn: $orphans)
                } label: {
                    Image(systemName: "line.3.horizontal.decrease.circle")
                }
                .accessibilityLabel("Filter the graph")
            }
        }
        .onChange(of: orphans) { _, _ in Task { await load() } }
        .task { await load() }
    }

    private func graph(_ layout: WikiGraphLayout) -> some View {
        ScrollView([.horizontal, .vertical], showsIndicators: false) {
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    for link in layout.links {
                        guard let a = layout.points[link.from], let b = layout.points[link.to] else { continue }
                        var path = Path()
                        path.move(to: a)
                        path.addLine(to: b)
                        context.stroke(path, with: .color(Theme.lineStrong), lineWidth: 1)
                    }
                }
                .frame(width: layout.size.width, height: layout.size.height)
                .allowsHitTesting(false)
                ForEach(layout.nodes) { node in
                    let degree = layout.degree[node.id] ?? 0
                    Button { env.router.push(.wikiPage(node.id)) } label: {
                        VStack(spacing: 3) {
                            Circle()
                                .fill(node.isDatabase ? Tone.teal.solid : node.isCanvas ? Tone.amber.solid : Tone.violet.solid)
                                .frame(width: 8 + CGFloat(min(degree, 10)) * 1.6, height: 8 + CGFloat(min(degree, 10)) * 1.6)
                            Text(node.displayTitle)
                                .font(ODFont.sans(11))
                                .foregroundStyle(Theme.fg2)
                                .lineLimit(1)
                                .frame(maxWidth: 120)
                        }
                    }
                    .buttonStyle(.plain)
                    .position(layout.points[node.id] ?? .zero)
                    .accessibilityLabel("\(node.displayTitle), \(Format.plural(degree, "link"))")
                }
            }
            .frame(width: layout.size.width, height: layout.size.height)
            .scaleEffect(zoom, anchor: .topLeading)
            .frame(width: layout.size.width * zoom, height: layout.size.height * zoom, alignment: .topLeading)
        }
        .simultaneousGesture(
            MagnifyGesture()
                .onChanged { pinch = $0.magnification }
                .onEnded { value in
                    scale = min(3, max(0.2, scale * value.magnification))
                    pinch = 1
                }
        )
    }

    private func load() async {
        store.attach(env)
        do {
            let links = try await store.graph()
            let rows = Set(store.nodes.filter(\.isDatabase).map(\.id))
            let nodes = store.nodes(in: area).filter { !$0.template && !rows.contains($0.parentID ?? "") }
            layout = WikiGraphLayout(nodes: nodes, links: links, orphans: orphans)
            error = nil
        } catch {
            guard !error.isCancellation else { return }
            self.error = error.userMessage
        }
    }
}

/// Where each page of a graph sits: a few rounds of pulling linked pages together and
/// pushing every pair apart (Fruchterman and Reingold), from a circle, so a graph lays out
/// the same each time.
struct WikiGraphLayout {
    var nodes: [WikiNode]
    var links: [WikiGraphLink]
    var points: [String: CGPoint] = [:]
    var degree: [String: Int] = [:]
    var size = CGSize(width: 600, height: 600)

    init(nodes all: [WikiNode], links graph: [WikiGraphLink], orphans: Bool) {
        let ids = Set(all.map(\.id))
        let kept = graph.filter { $0.from != $0.to && ids.contains($0.from) && ids.contains($0.to) }
        var counts: [String: Int] = [:]
        for link in kept {
            counts[link.from, default: 0] += 1
            counts[link.to, default: 0] += 1
        }
        links = kept
        degree = counts
        nodes = Array((orphans ? all : all.filter { counts[$0.id] != nil }).prefix(400))
        let count = nodes.count
        guard count > 0 else { return }
        let side = CGFloat(max(600, sqrt(Double(count)) * 140))
        size = CGSize(width: side, height: side)
        let k: CGFloat = sqrt(side * side / CGFloat(count))
        var position = nodes.enumerated().map { index, _ -> CGPoint in
            let angle = CGFloat(index) / CGFloat(count) * 2 * .pi
            return CGPoint(x: side / 2 + cos(angle) * side / 3, y: side / 2 + sin(angle) * side / 3)
        }
        let index = Dictionary(nodes.enumerated().map { ($0.element.id, $0.offset) }, uniquingKeysWith: { first, _ in first })
        let edges = links.compactMap { link -> (Int, Int)? in
            guard let a = index[link.from], let b = index[link.to] else { return nil }
            return (a, b)
        }
        var temperature: CGFloat = side / 10
        let rounds = count > 200 ? 60 : 120
        for _ in 0 ..< rounds {
            var shift = Array(repeating: CGPoint.zero, count: count)
            for i in 0 ..< count {
                for j in (i + 1) ..< count {
                    let dx = position[i].x - position[j].x
                    let dy = position[i].y - position[j].y
                    let distance = max(0.01, sqrt(dx * dx + dy * dy))
                    let force = k * k / distance
                    shift[i].x += dx / distance * force
                    shift[i].y += dy / distance * force
                    shift[j].x -= dx / distance * force
                    shift[j].y -= dy / distance * force
                }
            }
            for (a, b) in edges {
                let dx = position[a].x - position[b].x
                let dy = position[a].y - position[b].y
                let distance = max(0.01, sqrt(dx * dx + dy * dy))
                let force = distance * distance / k
                shift[a].x -= dx / distance * force
                shift[a].y -= dy / distance * force
                shift[b].x += dx / distance * force
                shift[b].y += dy / distance * force
            }
            for i in 0 ..< count {
                let length = max(0.01, sqrt(shift[i].x * shift[i].x + shift[i].y * shift[i].y))
                position[i].x = min(side - 40, max(40, position[i].x + shift[i].x / length * min(length, temperature)))
                position[i].y = min(side - 40, max(40, position[i].y + shift[i].y / length * min(length, temperature)))
            }
            temperature *= 0.95
        }
        for (i, node) in nodes.enumerated() { points[node.id] = position[i] }
    }
}
