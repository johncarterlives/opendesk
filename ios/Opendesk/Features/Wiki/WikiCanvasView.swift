import SwiftUI

/// A canvas page's board (contracts/wiki.md "Canvas"), to read: the cards where they sit,
/// groups under the connections, connections as lines with their arrows and labels. It pans
/// in both directions and zooms with a pinch or the buttons; a page card opens its page, a
/// link or file card its address. A page card names a page from the reader's own tree, and
/// says "A page you can't see" for anything else. Text cards read as plain text.
struct WikiCanvasBoard: View {
    let canvas: WikiCanvas
    /// The board inside the page; the full-screen board fills the screen.
    var height: CGFloat? = 380
    var onFullScreen: (() -> Void)?

    @Environment(AppEnvironment.self) private var env
    @Environment(\.openURL) private var openURL
    @State private var scale: CGFloat = 1
    @State private var pinch: CGFloat = 1
    @State private var fitted = false

    private var store: WikiStore { WikiStore.shared }
    private static let margin: CGFloat = 40

    /// Every card's frame, around the origin.
    private var bounds: CGRect {
        guard let first = canvas.nodes.first?.frame else { return CGRect(x: 0, y: 0, width: 400, height: 300) }
        return canvas.nodes.dropFirst().reduce(first) { $0.union($1.frame) }.insetBy(dx: -Self.margin, dy: -Self.margin)
    }

    private var zoom: CGFloat { min(2.5, max(0.15, scale * pinch)) }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottomTrailing) {
                if canvas.nodes.isEmpty {
                    EmptyState(symbol: "square.on.square.dashed", title: "This canvas is empty", message: "Add cards and connections on the web.")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView([.horizontal, .vertical], showsIndicators: false) {
                        board
                            .scaleEffect(zoom, anchor: .topLeading)
                            .frame(width: bounds.width * zoom, height: bounds.height * zoom, alignment: .topLeading)
                    }
                    .simultaneousGesture(
                        MagnifyGesture()
                            .onChanged { pinch = $0.magnification }
                            .onEnded { value in
                                scale = min(2.5, max(0.15, scale * value.magnification))
                                pinch = 1
                            }
                    )
                    controls(fit: fitScale(in: proxy.size))
                        .padding(10)
                }
            }
            .onAppear {
                guard !fitted, proxy.size.width > 0 else { return }
                fitted = true
                scale = fitScale(in: proxy.size)
            }
        }
        .frame(height: height)
        .frame(maxHeight: height == nil ? CGFloat.infinity : nil)
        .background(Theme.sunken)
        .clipShape(RoundedRectangle(cornerRadius: height == nil ? 0 : Theme.Radius.card, style: .continuous))
        .overlay {
            if height != nil {
                RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.line, lineWidth: 1)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Canvas with \(Format.plural(canvas.nodes.filter { $0.type != "group" }.count, "card"))")
    }

    private func fitScale(in size: CGSize) -> CGFloat {
        guard bounds.width > 0, bounds.height > 0 else { return 1 }
        return min(1, max(0.15, min(size.width / bounds.width, size.height / bounds.height)))
    }

    private func controls(fit: CGFloat) -> some View {
        HStack(spacing: 2) {
            control("minus.magnifyingglass", label: "Zoom out") { scale = max(0.15, scale / 1.25) }
            control("plus.magnifyingglass", label: "Zoom in") { scale = min(2.5, scale * 1.25) }
            control("arrow.down.right.and.arrow.up.left", label: "Fit the canvas") { scale = fit }
            if let onFullScreen {
                control("arrow.up.left.and.arrow.down.right", label: "Open full screen", action: onFullScreen)
            }
        }
        .padding(3)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1))
    }

    private func control(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button {
            Haptics.selection()
            withAnimation(Motion.snappy) { action() }
        } label: {
            Image(systemName: symbol).font(.system(size: 13, weight: .medium)).frame(width: 34, height: 30)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.fg2)
        .accessibilityLabel(label)
    }

    // MARK: Board

    private var board: some View {
        let origin = bounds.origin
        let groups = canvas.nodes.filter { $0.type == "group" }
        let cards = canvas.nodes.filter { $0.type != "group" }
        return ZStack(alignment: .topLeading) {
            ForEach(groups) { node in group(node).offset(x: node.x - origin.x, y: node.y - origin.y) }
            edges(origin: origin)
            ForEach(cards) { node in card(node).offset(x: node.x - origin.x, y: node.y - origin.y) }
        }
        .frame(width: bounds.width, height: bounds.height, alignment: .topLeading)
    }

    private func group(_ node: WikiCanvasNode) -> some View {
        let tone = Self.color(node.color)
        return ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill((tone ?? Theme.fg3).opacity(0.06))
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder((tone ?? Theme.fg3).opacity(0.35), style: StrokeStyle(lineWidth: 1.5, dash: [6, 4]))
            if let label = node.label, !label.isEmpty {
                Text(label)
                    .font(ODFont.sans(15, weight: .semibold))
                    .foregroundStyle(tone ?? Theme.fg2)
                    .padding(10)
            }
        }
        .frame(width: node.width, height: node.height)
    }

    private func card(_ node: WikiCanvasNode) -> some View {
        let tone = Self.color(node.color)
        return Button { open(node) } label: {
            VStack(alignment: .leading, spacing: 6) {
                switch node.type {
                case "page":
                    let page = node.pageID.flatMap { store.node($0) }
                    HStack(spacing: 6) {
                        WikiPageIcon(icon: page?.icon ?? "", size: 15, database: page?.isDatabase ?? false)
                        Text(page?.displayTitle ?? "A page you can't see")
                            .font(ODFont.sans(15, weight: .semibold))
                            .foregroundStyle(page == nil ? Theme.fg3 : Theme.fg)
                    }
                case "link":
                    Label(node.title.flatMap { $0.isEmpty ? nil : $0 } ?? "Link", systemImage: "link")
                        .font(ODFont.sans(14.5, weight: .semibold))
                        .foregroundStyle(Theme.fg)
                    if let about = node.description, !about.isEmpty {
                        Text(about).font(ODFont.sans(12.5)).foregroundStyle(Theme.fg2)
                    }
                    if let url = node.url {
                        Text(url).font(ODFont.sans(11.5)).foregroundStyle(Theme.fg3).lineLimit(1)
                    }
                case "file":
                    Label(node.name.flatMap { $0.isEmpty ? nil : $0 } ?? "File", systemImage: "paperclip")
                        .font(ODFont.sans(14.5, weight: .medium))
                        .foregroundStyle(Theme.fg)
                default:
                    Text(HTMLText.plain(from: node.html ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
                        .font(ODFont.sans(14))
                        .foregroundStyle(Theme.fg)
                }
            }
            .multilineTextAlignment(.leading)
            .padding(12)
            .frame(width: node.width, height: node.height, alignment: .topLeading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(alignment: .topLeading) {
                if let tone {
                    RoundedRectangle(cornerRadius: 10, style: .continuous).fill(tone.opacity(0.08))
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(tone?.opacity(0.6) ?? Theme.line, lineWidth: tone == nil ? 1 : 1.5))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!Self.opens(node))
    }

    private func edges(origin: CGPoint) -> some View {
        let nodes = Dictionary(canvas.nodes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return Canvas { context, _ in
            for edge in canvas.edges {
                guard let from = nodes[edge.fromNode], let to = nodes[edge.toNode] else { continue }
                let sides = Self.sides(from: from.frame, to: to.frame, fromSide: edge.fromSide, toSide: edge.toSide)
                let a = Self.point(of: from.frame, side: sides.0).applying(CGAffineTransform(translationX: -origin.x, y: -origin.y))
                let b = Self.point(of: to.frame, side: sides.1).applying(CGAffineTransform(translationX: -origin.x, y: -origin.y))
                let color = Self.color(edge.color) ?? Theme.fg3
                var path = Path()
                path.move(to: a)
                path.addLine(to: b)
                context.stroke(path, with: .color(color), lineWidth: 2)
                if (edge.toEnd ?? "arrow") == "arrow" { context.fill(Self.arrow(at: b, from: a), with: .color(color)) }
                if edge.fromEnd == "arrow" { context.fill(Self.arrow(at: a, from: b), with: .color(color)) }
                if let label = edge.label, !label.isEmpty {
                    let middle = CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2)
                    let text = context.resolve(Text(label).font(ODFont.sans(12.5, weight: .medium)).foregroundColor(Theme.fg2))
                    let size = text.measure(in: CGSize(width: 220, height: 60))
                    let box = CGRect(x: middle.x - size.width / 2 - 6, y: middle.y - size.height / 2 - 3, width: size.width + 12, height: size.height + 6)
                    context.fill(Path(roundedRect: box, cornerRadius: 6), with: .color(Theme.surface))
                    context.draw(text, in: box.insetBy(dx: 6, dy: 3))
                }
            }
        }
        .frame(width: bounds.width, height: bounds.height)
        .allowsHitTesting(false)
    }

    // MARK: Geometry

    /// The sides a connection leaves and reaches: those it names, else those that face each other.
    static func sides(from a: CGRect, to b: CGRect, fromSide: String?, toSide: String?) -> (String, String) {
        let dx = b.midX - a.midX
        let dy = b.midY - a.midY
        let facing: (String, String) = abs(dx) >= abs(dy) ? (dx >= 0 ? ("right", "left") : ("left", "right")) : (dy >= 0 ? ("bottom", "top") : ("top", "bottom"))
        return (fromSide ?? facing.0, toSide ?? facing.1)
    }

    static func point(of frame: CGRect, side: String) -> CGPoint {
        switch side {
        case "top": CGPoint(x: frame.midX, y: frame.minY)
        case "bottom": CGPoint(x: frame.midX, y: frame.maxY)
        case "left": CGPoint(x: frame.minX, y: frame.midY)
        default: CGPoint(x: frame.maxX, y: frame.midY)
        }
    }

    static func arrow(at tip: CGPoint, from tail: CGPoint) -> Path {
        let angle = atan2(tip.y - tail.y, tip.x - tail.x)
        let length: CGFloat = 11
        let spread: CGFloat = .pi / 7
        var path = Path()
        path.move(to: tip)
        path.addLine(to: CGPoint(x: tip.x - length * cos(angle - spread), y: tip.y - length * sin(angle - spread)))
        path.addLine(to: CGPoint(x: tip.x - length * cos(angle + spread), y: tip.y - length * sin(angle + spread)))
        path.closeSubpath()
        return path
    }

    /// JSON Canvas colours: "1"..."6" (red, orange, yellow, green, cyan, purple) or "#rrggbb".
    static func color(_ raw: String?) -> Color? {
        guard let raw, !raw.isEmpty else { return nil }
        let presets: [String: Tone] = ["1": .red, "2": .orange, "3": .yellow, "4": .green, "5": .cyan, "6": .purple]
        if let tone = presets[raw] { return tone.solid }
        guard raw.hasPrefix("#"), raw.count == 7, let value = UInt32(raw.dropFirst(), radix: 16) else { return nil }
        return Color(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255, blue: Double(value & 0xFF) / 255)
    }

    static func opens(_ node: WikiCanvasNode) -> Bool {
        switch node.type {
        case "page": node.pageID != nil
        case "link": node.url != nil
        case "file": node.src != nil
        default: false
        }
    }

    // MARK: Opening

    private func open(_ node: WikiCanvasNode) {
        switch node.type {
        case "page":
            guard let id = node.pageID else { return }
            if store.node(id) == nil {
                env.toasts.show("You can't see that page.", kind: .info)
                return
            }
            env.router.push(.wikiPage(id))
        case "link":
            if let raw = node.url, let url = URL(string: raw), url.scheme?.lowercased() == "https" { openURL(url) }
        case "file":
            guard let raw = node.src else { return }
            let whole = raw.hasPrefix("/") ? env.session.instance.apiURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + raw : raw
            if let url = URL(string: whole), url.scheme?.lowercased() == "https" || url.scheme?.lowercased() == "http" { openURL(url) }
        default:
            break
        }
    }
}

/// The canvas on the whole screen, with Done.
struct WikiCanvasScreen: View {
    let title: String
    let canvas: WikiCanvas

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            WikiCanvasBoard(canvas: canvas, height: nil)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { SheetButton(.confirm, "Done") { dismiss() } }
                }
        }
    }
}
