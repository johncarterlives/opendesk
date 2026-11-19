import SwiftUI
import UIKit

// MARK: - Publish

/// Publish to help center (contracts/wiki.md "Publishing"): a draft article copied from the
/// page, with a title, a collection and, with several brands, a brand; then a link to the draft.
/// Nothing stays linked: later edits of the page never reach the article.
struct WikiPublishSheet: View {
    let page: WikiPage

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var collections: [KBCollection] = []
    @State private var brands: [WikiPublishBrand] = []
    @State private var collectionID: String?
    @State private var brandID: String?
    @State private var busy = false
    @State private var error: String?
    @State private var published: WikiPublished?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let published {
                        done(published)
                    } else {
                        form
                    }
                }
                .padding(16)
            }
            .background(Theme.canvas.ignoresSafeArea())
            .navigationTitle("Publish to help center")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, published == nil ? "Cancel" : "Close") { dismiss() } }
                if published == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        SheetButton(.confirm, "Make a draft", busy: busy) { Task { await publish() } }
                        .fontWeight(.semibold)
                        .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .task { await load() }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("The page becomes a draft article you can edit before it goes live. Files, databases and links to other pages stay in the wiki.")
                .font(ODFont.sans(13.5))
                .foregroundStyle(Theme.fg3)
                .fixedSize(horizontal: false, vertical: true)
            if let error { Notice(text: error, tone: .red, symbol: "exclamationmark.triangle") }
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel("Title")
                Panel(padding: 12) {
                    TextField("Article title", text: $title).font(ODFont.sans(15))
                }
            }
            picker("Collection", none: "No collection", selection: $collectionID, items: collections.map { ($0.id, $0.name) })
            if brands.count > 1 {
                picker("Brand", none: "Every brand", selection: $brandID, items: brands.map { ($0.id, $0.name) })
            }
        }
    }

    private func picker(_ label: String, none: String, selection: Binding<String?>, items: [(String, String)]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(label)
            Panel(padding: 12) {
                Menu {
                    Button(none) { selection.wrappedValue = nil }
                    ForEach(items, id: \.0) { item in
                        Button(item.1) { selection.wrappedValue = item.0 }
                    }
                } label: {
                    HStack {
                        Text(items.first { $0.0 == selection.wrappedValue }?.1 ?? none).font(ODFont.sans(15)).foregroundStyle(Theme.fg)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundStyle(Theme.fg3)
                    }
                    .contentShape(Rectangle())
                }
            }
        }
    }

    private func done(_ published: WikiPublished) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("The draft is ready", systemImage: "checkmark.circle.fill")
                .font(ODFont.sans(17, weight: .semibold))
                .foregroundStyle(Tone.green.text)
            if published.leftOut > 0 {
                Notice(text: "\(Format.plural(published.leftOut, "part")) stayed in the wiki: files, databases, ticket lists or subpage links.", tone: .amber)
            }
            Button {
                dismiss()
                env.router.push(.article(published.article.id))
            } label: {
                Text("Open the draft")
            }
            .buttonStyle(InkButtonStyle(fullWidth: false, height: 38))
        }
    }

    private func load() async {
        if title.isEmpty { title = page.title }
        let api = env.session.api
        async let list: Page<KBCollection>? = try? api.get("v1/kb/collections", query: [URLQueryItem(name: "limit", value: "100")])
        async let marks: Page<WikiPublishBrand>? = try? api.get("v1/brands")
        collections = (await list)?.data ?? []
        brands = (await marks)?.data ?? []
    }

    private func publish() async {
        busy = true
        defer { busy = false }
        do {
            let answer = try await WikiStore.shared.publish(WikiPublish(pageID: page.id, title: title.trimmingCharacters(in: .whitespaces), collectionID: collectionID, brandID: brandID))
            Haptics.success()
            withAnimation(Motion.snappy) { published = answer }
        } catch {
            Haptics.error()
            self.error = error.userMessage
        }
    }
}

// MARK: - Ollie writing

/// Ollie writing on a page (contracts/wiki.md "Ollie writing"): a mode, or a free ask, over the
/// page's text. Ollie's answer streams in, then shows as it will read; the member replaces the
/// text with it, adds it below, tries again or drops it. Nothing is saved until they choose.
struct WikiWriteSheet: View {
    let title: String
    /// The page's text now.
    let bodyHTML: String
    /// Ollie's answer and whether it takes the text's place.
    let onApply: (String, Bool) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var mode: WikiWriteMode?
    @State private var ask = ""
    @State private var streamed = ""
    @State private var answer: String?
    @State private var error: String?
    @State private var running: Task<Void, Never>?
    @State private var height: CGFloat = 160

    private var blank: Bool { WikiBody.isBlank(bodyHTML) }
    /// What a blank page can ask for: Ollie writes from the title.
    private var modes: [WikiWriteMode] { blank ? [.keepWriting, .custom] : WikiWriteMode.allCases.filter { $0 != .custom } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let error { Notice(text: error, tone: .red, symbol: "exclamationmark.triangle") }
                    if mode == nil {
                        picker
                    } else {
                        result
                    }
                }
                .padding(16)
            }
            .background(Theme.canvas.ignoresSafeArea())
            .navigationTitle("Ask Ollie")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    SheetButton(.cancel, "Cancel") {
                        running?.cancel()
                        dismiss()
                    }
                }
            }
        }
        .onDisappear { running?.cancel() }
    }

    private var picker: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                OllieMark(size: 26)
                Text(blank ? "Ollie writes from the page's title." : "Ollie works on the whole page.").font(ODFont.sans(13.5)).foregroundStyle(Theme.fg3)
            }
            Panel(padding: 12) {
                HStack(spacing: 8) {
                    TextField("Ask Ollie to write anything", text: $ask, axis: .vertical)
                        .font(ODFont.sans(15))
                        .submitLabel(.send)
                        .onSubmit { if !ask.trimmingCharacters(in: .whitespaces).isEmpty { run(.custom) } }
                    Button { run(.custom) } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 24)) }
                        .buttonStyle(.plain)
                        .foregroundStyle(ask.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.fg4 : Tone.violet.solid)
                        .disabled(ask.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityLabel("Ask")
                }
            }
            Panel {
                ForEach(Array(modes.enumerated()), id: \.element.id) { index, item in
                    if index > 0 { Hairline(inset: 44) }
                    Button { run(item) } label: {
                        PanelRow(title: item.title, symbol: item.symbol, tint: Theme.fg)
                    }
                    .buttonStyle(RowPressStyle())
                }
            }
        }
    }

    @ViewBuilder
    private var result: some View {
        HStack(spacing: 8) {
            OllieMark(size: 22, state: answer == nil && error == nil ? .thinking : .done)
            Text(mode?.title ?? "Ollie").font(ODFont.sans(14, weight: .semibold)).foregroundStyle(Theme.fg)
        }
        Panel(padding: 12) {
            if let answer {
                KBArticleWebView(html: answer, height: $height, fontSize: 15, extraCSS: WikiBody.css(dark: scheme == .dark))
                    .frame(height: height)
            } else {
                Text(streamed.isEmpty ? "Writing…" : streamed)
                    .font(ODFont.sans(14.5))
                    .foregroundStyle(streamed.isEmpty ? Theme.fg3 : Theme.fg2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        if let answer, let mode {
            VStack(spacing: 8) {
                if !blank, mode.replaces {
                    Button("Replace the page text") { apply(answer, replace: true) }.buttonStyle(InkButtonStyle())
                    Button("Add below") { apply(answer, replace: false) }.buttonStyle(OutlineButtonStyle())
                } else {
                    Button(blank ? "Add to the page" : "Add below") { apply(answer, replace: false) }.buttonStyle(InkButtonStyle())
                    if !blank {
                        Button("Replace the page text") { apply(answer, replace: true) }.buttonStyle(OutlineButtonStyle())
                    }
                }
                HStack(spacing: 8) {
                    Button("Try again") { run(mode) }.buttonStyle(OutlineButtonStyle(height: 38))
                    Button("Discard") {
                        self.answer = nil
                        self.mode = nil
                        streamed = ""
                    }
                    .buttonStyle(OutlineButtonStyle(height: 38))
                }
            }
        }
    }

    private func apply(_ html: String, replace: Bool) {
        Haptics.success()
        onApply(html, replace)
        dismiss()
    }

    private func run(_ next: WikiWriteMode) {
        running?.cancel()
        mode = next
        answer = nil
        error = nil
        streamed = ""
        let edits = next.replaces || [.summarize, .actionItems, .explain].contains(next)
        let request = WikiWriteRequest(
            mode: next.rawValue,
            html: edits && !blank ? bodyHTML : nil,
            contextHTML: edits ? nil : (blank ? nil : bodyHTML),
            title: title.isEmpty ? nil : title,
            instructions: next == .custom ? ask.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        )
        running = Task {
            do {
                let stream = try await WikiStore.shared.write(request)
                for try await event in stream {
                    switch event.event {
                    case "delta":
                        streamed += event.json()?["text"]?.string ?? ""
                    case "done", "result":
                        if let html = event.json()?["html"]?.string { answer = html }
                    case "error":
                        error = event.json()?["detail"]?.string ?? "Ollie couldn't write this. Try again."
                    default:
                        break
                    }
                }
                if answer == nil, error == nil { error = "Ollie couldn't write this. Try again." }
            } catch {
                guard !error.isCancellation else { return }
                self.error = error.userMessage
            }
        }
    }
}

// MARK: - Export

/// A page exported to a file, offered to the share sheet (contracts/wiki.md "Export").
struct WikiExportFile: Identifiable {
    let id = UUID()
    let url: URL
}

@MainActor
enum WikiExport {
    /// Downloads the export into a fresh temporary folder, named as the API names it.
    static func file(page: WikiPage, format: String, subpages: Bool, env: AppEnvironment) async -> WikiExportFile? {
        do {
            let answer = try await WikiStore.shared.export(page.id, format: format, subpages: subpages)
            let fallback = WikiText.title(page.title) + (subpages ? ".zip" : page.isCanvas && format == "markdown" ? ".canvas" : format == "html" ? ".html" : ".md")
            let name = (answer.filename ?? fallback).replacingOccurrences(of: "/", with: "-")
            let folder = FileManager.default.temporaryDirectory.appending(path: "wiki-export-\(UUID().uuidString)", directoryHint: .isDirectory)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appending(path: name)
            try answer.data.write(to: url, options: .atomic)
            return WikiExportFile(url: url)
        } catch {
            guard !error.isCancellation else { return nil }
            Haptics.error()
            env.toasts.error(error)
            return nil
        }
    }
}

/// The system share sheet for a file.
struct WikiShareSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - Random page

@MainActor
enum WikiRandom {
    /// A page of the area's tree picked at random, never a template, a row or the page at hand.
    static func pick(in area: WikiArea, besides id: String?) -> WikiNode? {
        let store = WikiStore.shared
        let rows = Set(store.nodes.filter(\.isDatabase).map(\.id))
        return store.nodes(in: area).filter { !$0.template && $0.id != id && !rows.contains($0.parentID ?? "") }.randomElement()
    }
}
