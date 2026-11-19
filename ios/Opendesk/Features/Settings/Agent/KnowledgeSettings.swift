import SwiftUI
import UniformTypeIdentifiers

/// Settings > AI agent > Knowledge: websites, files and short answers the agent uses besides the
/// help center. Each source syncs on its own and updates live.
struct KnowledgeSettings: View {
    enum Filter: String, CaseIterable { case all, website, file, snippet }

    @Environment(AppEnvironment.self) private var env
    @State private var filter: Filter = .all
    @State private var editing: KnowledgeEdit?
    @State private var importing = false
    @State private var uploading = false
    @State private var confirm: AccountConfirm?

    var body: some View {
        let store = env.agent
        let list = store.knowledge.value
        let shown = filter == .all ? list : list.filter { $0.kind == filter.rawValue }
        AccountPage(title: "Knowledge", spacing: 20) {
            AgentIntro(text: "Websites, files and short answers the agent can use besides your help center. Drafts and copilot use them too.")
            if store.config != nil, !store.behaviour.widgetAnswers { AgentOffNotice() }
            if !store.knowledge.loaded {
                Panel { SkeletonRows(count: 3) }
            } else if let error = store.knowledge.error, list.isEmpty {
                Panel { ErrorState(message: error) { Task { await store.loadKnowledge() } } }
            } else if list.isEmpty {
                empty
            } else {
                summary(list)
                VStack(alignment: .leading, spacing: 8) {
                    AccountSegmented(options: Filter.allCases, selection: $filter, label: { label($0, list) })
                    Panel {
                        if shown.isEmpty {
                            Text("Nothing of this kind yet.").font(ODFont.footnote).foregroundStyle(Theme.fg3).frame(maxWidth: .infinity).padding(.vertical, 28)
                        }
                        ForEach(Array(shown.enumerated()), id: \.element.id) { index, source in
                            if index > 0 { AccountDivider() }
                            KnowledgeRow(source: source)
                                .contextMenu { menu(source, store) }
                        }
                    }
                    .motion(Motion.snappy, value: shown.map(\.id))
                }
            }
            HStack(spacing: 4) {
                Text("Published help center articles are always part of the agent's knowledge.")
                Button("Open the help center") { env.router.show(.kb, []) }
                    .foregroundStyle(Theme.fg2)
                    .underline()
            }
            .font(ODFont.footnote)
            .foregroundStyle(Theme.fg3)
            .padding(.horizontal, 4)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Add a website", systemImage: "globe") { editing = KnowledgeEdit(kind: "website") }
                    Button("Upload a file", systemImage: "doc") { importing = true }
                    Button("Write a Q&A snippet", systemImage: "text.quote") { editing = KnowledgeEdit(kind: "snippet") }
                } label: {
                    if uploading { ProgressView() } else { Image(systemName: "plus") }
                }
                .disabled(uploading)
                .accessibilityLabel("Add knowledge")
            }
        }
        .sheet(item: $editing) { edit in
            KnowledgeEditor(edit: edit).presentationCornerRadius(Theme.Radius.sheet)
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: KnowledgeFiles.types) { result in
            if case let .success(url) = result { Task { await upload(url, store) } }
        }
        .accountConfirm($confirm)
        .refreshable { await store.loadKnowledge() }
        .task {
            if store.config == nil { await store.loadConfig() }
            await store.loadKnowledge()
        }
    }

    private func label(_ filter: Filter, _ list: [KnowledgeSource]) -> String {
        let count = filter == .all ? 0 : list.filter { $0.kind == filter.rawValue }.count
        let title = switch filter {
        case .all: "All"
        case .website: "Websites"
        case .file: "Files"
        case .snippet: "Snippets"
        }
        return count > 0 ? "\(title) \(count)" : title
    }

    private var empty: some View {
        Panel {
            VStack(spacing: 16) {
                EmptyState(symbol: "books.vertical", title: "Teach the agent about your product", message: "Add your docs site, a PDF or a few short answers. The agent answers from them, and from your help center articles.")
                HStack(spacing: 8) {
                    Button { editing = KnowledgeEdit(kind: "website") } label: { Label("Add a website", systemImage: "globe") }
                        .buttonStyle(InkButtonStyle(fullWidth: false, height: 38))
                    Button { importing = true } label: { Label("Upload a file", systemImage: "doc") }
                        .buttonStyle(OutlineButtonStyle(fullWidth: false, height: 38))
                }
                AgentTip(text: "Published help center articles are already included")
                    .padding(.bottom, 20)
            }
        }
    }

    private func summary(_ list: [KnowledgeSource]) -> some View {
        let docs = list.reduce(0) { $0 + $1.docCount }
        let chars = list.reduce(0) { $0 + $1.charCount }
        let busy = list.filter(\.moving).count
        let failing = list.filter { $0.status == "error" }.count
        return AgentStatGrid {
            AgentStat(label: "Sources", value: list.count.formatted(), hint: "Up to 50")
            AgentStat(label: "Documents", value: docs.formatted(), hint: "Up to 5,000")
            AgentStat(label: "Characters", value: AgentText.compact(chars), hint: "\(min(100, Int((Double(chars) / 20_000_000 * 100).rounded())))% of the 20M limit")
            if busy > 0 {
                AgentStat(label: "Syncing", value: busy.formatted(), hint: "Updates live", tone: .violet)
            } else if failing > 0 {
                AgentStat(label: "Need attention", value: failing.formatted(), hint: "Open a source to see why", tone: .red)
            } else {
                AgentStat(label: "Status", value: "Up to date", tone: .green)
            }
        }
    }

    @ViewBuilder
    private func menu(_ source: KnowledgeSource, _ store: AgentStore) -> some View {
        if source.kind != "snippet" {
            Button("Sync now", systemImage: "arrow.triangle.2.circlepath") { Task { await KnowledgeActions.sync(source, env: env) } }
                .disabled(source.moving)
        }
        if source.kind != "file" {
            Button(source.kind == "website" ? "Crawl settings" : "Edit", systemImage: "pencil") { editing = KnowledgeEdit(kind: source.kind, source: source) }
        }
        Button("Delete", systemImage: "trash", role: .destructive) { confirm = KnowledgeActions.delete(source, env: env) }
    }

    private func upload(_ url: URL, _ store: AgentStore) async {
        guard let api = store.api else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            env.toasts.show("Couldn't upload the file", kind: .error)
            return
        }
        if data.count > KnowledgeFiles.maxBytes {
            env.toasts.show("This file is over 20 MB", kind: .error)
            return
        }
        let ext = url.pathExtension.lowercased()
        guard KnowledgeFiles.extensions.contains(ext) else {
            env.toasts.show("Use a PDF, DOCX, TXT, Markdown, HTML or CSV file", kind: .error)
            return
        }
        uploading = true
        defer { uploading = false }
        do {
            let source: KnowledgeSource = try await api.upload("v1/ai/knowledge/files", data: data, filename: url.lastPathComponent, mimeType: UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream")
            store.upsert(source)
            Haptics.success()
            env.toasts.show("File uploaded, reading it now", kind: .success)
        } catch {
            env.toasts.error(error)
        }
    }
}

enum KnowledgeFiles {
    static let maxBytes = 20 * 1024 * 1024
    static let extensions: Set<String> = ["pdf", "docx", "txt", "md", "markdown", "html", "htm", "csv"]
    static var types: [UTType] {
        var out: [UTType] = [.pdf, .plainText, .html, .commaSeparatedText]
        if let docx = UTType(filenameExtension: "docx") { out.append(docx) }
        if let md = UTType(filenameExtension: "md") { out.append(md) }
        return out
    }
}

extension KnowledgeSource {
    var kindTone: Tone { kind == "website" ? .teal : kind == "file" ? .blue : .amber }
    var kindSymbol: String { kind == "website" ? "globe" : kind == "file" ? "doc.text" : "text.quote" }
    var statusTone: Tone {
        switch status {
        case "syncing": .violet
        case "ready": .green
        case "error": .red
        default: .gray
        }
    }

    var statusTitle: String {
        switch status {
        case "pending": "Queued"
        case "syncing": "Syncing"
        case "error": "Failed"
        default: "Ready"
        }
    }

    var docsTitle: String { kind == "snippet" ? "1 answer" : docCount == 1 ? "1 doc" : "\(docCount) docs" }
}

private struct KnowledgeRow: View {
    let source: KnowledgeSource

    @Environment(AppEnvironment.self) private var env

    var body: some View {
        HStack(spacing: 12) {
            SettingsDetailLink(page: .knowledge, id: source.id) {
                HStack(spacing: 12) {
                    AccountIconTile(symbol: source.kindSymbol, tone: source.kindTone)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(source.name.isEmpty ? source.detail : source.name)
                            .font(ODFont.sans(15, weight: .medium))
                            .foregroundStyle(source.enabled ? Theme.fg : Theme.fg3)
                            .lineLimit(1)
                        if !source.name.isEmpty, !source.detail.isEmpty {
                            Text(source.detail).font(ODFont.sans(12.5)).foregroundStyle(Theme.fg3).lineLimit(1)
                        }
                        HStack(spacing: 6) {
                            TonePill(text: source.statusTitle, tone: source.statusTone, height: 18) {
                                if source.moving { ProgressView().controlSize(.mini) }
                            }
                            Text(source.docsTitle).font(ODFont.sans(12)).foregroundStyle(Theme.fg4)
                            if let synced = source.lastSyncedAt {
                                Text("· \(Format.relShort(synced))").font(ODFont.sans(12)).foregroundStyle(Theme.fg4)
                            }
                        }
                    }
                    Spacer(minLength: 4)
                }
                .padding(.leading, 14)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            Toggle("Use \(source.name) for answers", isOn: Binding(get: { source.enabled }, set: { on in Task { await KnowledgeActions.setEnabled(source, on, env: env) } }))
                .labelsHidden()
                .tint(Tone.green.solid)
                .padding(.trailing, 14)
        }
        .opacity(source.enabled ? 1 : 0.75)
    }
}

/// What the list and a source's page both do.
@MainActor
enum KnowledgeActions {
    static func setEnabled(_ source: KnowledgeSource, _ on: Bool, env: AppEnvironment) async {
        let store = env.agent
        guard let api = store.api else { return }
        var optimistic = source
        optimistic.enabled = on
        store.upsert(optimistic)
        do {
            let saved: KnowledgeSource = try await api.patch("v1/ai/knowledge/\(source.id)", body: JSONValue.object(["enabled": .bool(on)]))
            store.upsert(saved)
        } catch {
            store.upsert(source)
            env.toasts.error(error)
        }
    }

    static func sync(_ source: KnowledgeSource, env: AppEnvironment) async {
        guard let api = env.agent.api else { return }
        do {
            let saved: KnowledgeSource = try await api.post("v1/ai/knowledge/\(source.id)/sync")
            env.agent.upsert(saved)
            Haptics.tap()
        } catch {
            env.toasts.error(error)
        }
    }

    static func delete(_ source: KnowledgeSource, env: AppEnvironment, after: @escaping @MainActor () -> Void = {}) -> AccountConfirm {
        let name = source.name.isEmpty ? source.detail : source.name
        return AccountConfirm(title: "Delete this source?", message: "\(name) and all its documents are removed. The agent stops using them right away.", confirmTitle: "Delete source") {
            guard let api = env.agent.api else { return }
            do {
                try await api.delete("v1/ai/knowledge/\(source.id)")
                env.agent.knowledge.value.removeAll { $0.id == source.id }
                Haptics.success()
                after()
            } catch {
                env.toasts.error(error)
            }
        }
    }
}

// MARK: - A source

extension KnowledgeSettings {
    /// One source: its facts, its documents a page at a time, and sync, edit and delete.
    struct Detail: View {
        let id: String

        @Environment(AppEnvironment.self) private var env
        @State private var docs: [KnowledgeDoc] = []
        @State private var cursor: String?
        @State private var docsLoaded = false
        @State private var loadingMore = false
        @State private var editing: KnowledgeEdit?
        @State private var confirm: AccountConfirm?
        @State private var missing = false

        var body: some View {
            let store = env.agent
            Group {
                if let source = store.knowledge.value.first(where: { $0.id == id }) {
                    page(source, store)
                } else if missing {
                    AccountPage(title: "Knowledge") {
                        EmptyState(symbol: "questionmark.circle", title: "This source isn't here any more", message: "It may have been deleted.")
                            .padding(.top, 60)
                    }
                } else {
                    AccountPage(title: "Knowledge") { Panel { SkeletonRows(count: 3) } }
                }
            }
            .task {
                if !store.knowledge.loaded { await store.loadKnowledge() }
                if !store.knowledge.value.contains(where: { $0.id == id }) {
                    if let api = store.api, let source: KnowledgeSource = try? await api.get("v1/ai/knowledge/\(id)") { store.upsert(source) } else { missing = true }
                }
                await loadDocs(reset: true)
            }
            .onChange(of: store.knowledge.value.first { $0.id == id }?.docCount) { _, _ in Task { await loadDocs(reset: true) } }
        }

        private func page(_ source: KnowledgeSource, _ store: AgentStore) -> some View {
            AccountPage(title: source.name.isEmpty ? "Source" : source.name, spacing: 20) {
                HStack(spacing: 12) {
                    AccountIconTile(symbol: source.kindSymbol, tone: source.kindTone, size: 40)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(source.detail).font(ODFont.sans(14)).foregroundStyle(Theme.fg2).lineLimit(2)
                        TonePill(text: source.statusTitle, tone: source.statusTone) {
                            if source.moving { ProgressView().controlSize(.mini) }
                        }
                    }
                    Spacer()
                }
                if let error = source.error, source.status == "error" {
                    Notice(text: error, tone: .red, symbol: "exclamationmark.triangle")
                }
                if source.moving, source.docCount > 0 {
                    Notice(text: "Still answering from the last sync while this runs", tone: .violet, symbol: "arrow.triangle.2.circlepath")
                }
                Panel {
                    AccountToggleRow(symbol: "sparkles", tone: .violet, title: "Use for answers", isOn: Binding(get: { source.enabled }, set: { on in Task { await KnowledgeActions.setEnabled(source, on, env: env) } }))
                }
                AgentStatGrid {
                    AgentStat(label: "Documents", value: source.docCount.formatted())
                    AgentStat(label: "Characters", value: AgentText.compact(source.charCount))
                    AgentStat(label: "Last synced", value: source.lastSyncedAt.map { Format.relShort($0) } ?? "Never")
                    AgentStat(label: "Added", value: source.createdAt.map { Format.shortDate($0) } ?? "")
                }
                if let website = source.website {
                    AccountSection(title: "Crawl settings") {
                        AccountRow(symbol: "doc.on.doc", title: "Up to \(website.maxPages) pages")
                        AccountDivider()
                        AccountRow(symbol: "calendar", title: website.weekly ? "Re-crawled weekly" : "Synced only when you ask")
                        if !website.include.isEmpty {
                            AccountDivider()
                            AccountRow(symbol: "checkmark.circle", title: "Only", subtitle: website.include.joined(separator: ", "))
                        }
                        if !website.exclude.isEmpty {
                            AccountDivider()
                            AccountRow(symbol: "minus.circle", title: "Skip", subtitle: website.exclude.joined(separator: ", "))
                        }
                    }
                }
                if source.kind == "snippet" {
                    AccountSection(title: "Answer") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(source.question ?? "").font(ODFont.sans(15, weight: .semibold)).foregroundStyle(Theme.fg)
                            MarkdownText(text: source.answer ?? "", size: 14.5, color: Theme.fg2)
                        }
                        .padding(14)
                    }
                } else {
                    documents(source)
                }
                HStack(spacing: 8) {
                    if source.kind != "snippet" {
                        Button { Task { await KnowledgeActions.sync(source, env: env) } } label: { Label(source.moving ? "Syncing" : "Sync now", systemImage: "arrow.triangle.2.circlepath") }
                            .buttonStyle(ChipButtonStyle())
                            .disabled(source.moving)
                    }
                    if source.kind != "file" {
                        Button { editing = KnowledgeEdit(kind: source.kind, source: source) } label: { Label(source.kind == "website" ? "Crawl settings" : "Edit", systemImage: "pencil") }
                            .buttonStyle(ChipButtonStyle())
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Button("Delete source", role: .destructive) {
                        confirm = KnowledgeActions.delete(source, env: env) { env.router.accountPath.removeLast() }
                    }
                    .buttonStyle(OutlineButtonStyle(tint: Tone.red.text))
                    Text("Removes its documents from the agent's knowledge right away.").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                }
            }
            .sheet(item: $editing) { edit in KnowledgeEditor(edit: edit).presentationCornerRadius(Theme.Radius.sheet) }
            .accountConfirm($confirm)
            .refreshable { await loadDocs(reset: true) }
        }

        private func documents(_ source: KnowledgeSource) -> some View {
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel("Documents").padding(.horizontal, 4)
                Panel {
                    if !docsLoaded {
                        SkeletonRows(count: 3)
                    } else if docs.isEmpty {
                        Text(source.moving ? "Documents appear here as they are found." : "No documents yet.")
                            .font(ODFont.footnote).foregroundStyle(Theme.fg3).padding(14)
                    } else {
                        ForEach(Array(docs.enumerated()), id: \.element.id) { index, doc in
                            if index > 0 { Hairline(inset: 14) }
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(doc.title.isEmpty ? "Untitled" : doc.title).font(ODFont.sans(14.5)).foregroundStyle(Theme.fg).lineLimit(2)
                                    Text([doc.url, "\(AgentText.compact(doc.chars)) characters"].compactMap { $0 }.joined(separator: " · "))
                                        .font(ODFont.sans(12)).foregroundStyle(Theme.fg3).lineLimit(1)
                                }
                                Spacer(minLength: 6)
                                Button {
                                    confirm = AccountConfirm(title: "Remove this document?", message: source.kind == "website" ? "The agent stops using this page, and future crawls skip it." : "The agent stops using this document.", confirmTitle: "Remove") {
                                        await remove(doc, source)
                                    }
                                } label: {
                                    Image(systemName: "xmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.fg3).frame(width: 30, height: 30)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Remove \(doc.title)")
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .contextMenu {
                                if let link = doc.url.flatMap(URL.init(string:)) { Link(destination: link) { Label("Open page", systemImage: "safari") } }
                            }
                        }
                        if cursor != nil {
                            Hairline()
                            Button { Task { await loadDocs(reset: false) } } label: {
                                ButtonLabel(title: "Show more", busy: loadingMore)
                                    .font(ODFont.sans(14, weight: .medium))
                                    .foregroundStyle(Theme.fg2)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }

        private func loadDocs(reset: Bool) async {
            guard let api = env.agent.api else { return }
            if !reset && (cursor == nil || loadingMore) { return }
            loadingMore = !reset
            defer { loadingMore = false }
            var query = [URLQueryItem(name: "limit", value: "50")]
            if !reset, let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
            do {
                let page: Page<KnowledgeDoc> = try await api.get("v1/ai/knowledge/\(id)/docs", query: query)
                docs = reset ? page.data : docs + page.data.filter { doc in !docs.contains { $0.id == doc.id } }
                cursor = page.nextCursor.flatMap { $0.isEmpty ? nil : $0 }
            } catch {
                if !error.isCancellation, docsLoaded { env.toasts.error(error) }
            }
            docsLoaded = true
        }

        private func remove(_ doc: KnowledgeDoc, _ source: KnowledgeSource) async {
            guard let api = env.agent.api else { return }
            do {
                try await api.delete("v1/ai/knowledge/\(source.id)/docs/\(doc.id)")
                docs.removeAll { $0.id == doc.id }
                Haptics.success()
                env.toasts.show("Document removed", kind: .success)
                env.agent.refresh("knowledge") { await $0.loadKnowledge() }
            } catch {
                env.toasts.error(error)
            }
        }
    }
}

// MARK: - Editors

struct KnowledgeEdit: Identifiable {
    let id = UUID()
    var kind: String
    var source: KnowledgeSource?
}

/// Add or change a website (its crawl) or a Q&A snippet.
struct KnowledgeEditor: View {
    let edit: KnowledgeEdit

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = ""
    @State private var maxPages = 100
    @State private var include: [String] = []
    @State private var exclude: [String] = []
    @State private var weekly = true
    @State private var question = ""
    @State private var answer = ""
    @State private var tried = false
    @State private var busy = false
    @State private var started = false

    private var website: Bool { edit.kind == "website" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(website ? "The agent reads pages on this site, starting from its sitemap, and keeps them in sync." : "A short answer to a question visitors ask, in your words.")
                        .font(ODFont.callout).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
                    if website { websiteFields } else { snippetFields }
                    AgentField(label: "Name", text: $name, prompt: website ? hostPrompt : "", hint: "How it shows in this list.", max: 100)
                }
                .padding(20)
                .padding(.bottom, 40)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.chrome)
            .accountTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(.confirm, edit.source == nil ? (website ? "Add" : "Add") : "Save", busy: busy) { Task { await save() } }
                        .fontWeight(.semibold)
                    .disabled(busy)
                }
            }
        }
        .onAppear {
            guard !started else { return }
            started = true
            guard let source = edit.source else { return }
            name = source.name
            if let site = source.website {
                url = site.url
                maxPages = site.maxPages
                include = site.include
                exclude = site.exclude
                weekly = site.weekly
            }
            question = source.question ?? ""
            answer = source.answer ?? ""
        }
    }

    private var title: String {
        switch (website, edit.source == nil) {
        case (true, true): "Add a website"
        case (true, false): "Crawl settings"
        case (false, true): "Write a Q&A snippet"
        case (false, false): "Edit snippet"
        }
    }

    private var hostPrompt: String { URL(string: url)?.host ?? "help.example.com" }

    private var websiteFields: some View {
        VStack(alignment: .leading, spacing: 18) {
            AgentField(label: "Address", text: $url, prompt: "https://help.example.com", hint: "Pages on the same site are crawled. robots.txt is respected.", problem: tried ? urlProblem : nil, keyboard: .URL)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Pages at most").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                        Text("From 1 to 500.").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                    }
                    Spacer()
                    AgentStepper(value: $maxPages, range: 1 ... 500, step: 10)
                }
            }
            AgentChipEditor(label: "Only these paths", hint: "Leave empty to crawl the whole site.", items: $include, max: 20, prompt: "/docs", empty: "The whole site.", check: pathProblem, mono: true)
            AgentChipEditor(label: "Skip these paths", hint: "Pages under these paths are left out.", items: $exclude, max: 20, prompt: "/blog", empty: "Nothing skipped.", check: pathProblem, mono: true)
            Panel {
                AccountToggleRow(symbol: "calendar", tone: .teal, title: "Re-crawl weekly", subtitle: "Picks up new and changed pages once a week.", isOn: $weekly)
            }
        }
    }

    private var snippetFields: some View {
        VStack(alignment: .leading, spacing: 18) {
            AgentField(label: "Question", text: $question, prompt: "Do you offer student discounts?", problem: tried ? questionProblem : nil)
            AgentField(label: "Answer", text: $answer, prompt: "Yes, 50% off Pro with a valid student email. Apply from Billing in the app.", hint: "Markdown works. Up to 4,000 characters.", max: 4000, multiline: true, problem: tried ? answerProblem : nil)
        }
    }

    private func pathProblem(_ path: String) -> String? {
        path.hasPrefix("/") && !path.contains(" ") && path.count <= 200 ? nil : "Start with /, like /docs"
    }

    private var urlProblem: String? {
        let raw = AgentText.trimmed(url)
        guard let parsed = URL(string: raw.contains("://") ? raw : "https://" + raw), let host = parsed.host, host.contains("."), ["https", "http"].contains(parsed.scheme ?? "") else {
            return "Enter a web address, like https://help.example.com"
        }
        return nil
    }

    private var questionProblem: String? {
        let count = AgentText.trimmed(question).count
        return count < 3 || count > 300 ? "Between 3 and 300 characters" : nil
    }

    private var answerProblem: String? {
        let count = AgentText.trimmed(answer).count
        return count < 1 || count > 4000 ? "Between 1 and 4,000 characters" : nil
    }

    private func save() async {
        tried = true
        let bad = website ? urlProblem != nil : (questionProblem != nil || answerProblem != nil)
        guard !bad, name.count <= 100, let api = env.agent.api else {
            Haptics.error()
            return
        }
        busy = true
        defer { busy = false }
        var body: [String: JSONValue] = [:]
        if website {
            let raw = AgentText.trimmed(url)
            body["website"] = .object([
                "url": .string(raw.contains("://") ? raw : "https://" + raw),
                "max_pages": .number(Double(maxPages)),
                "include": .array(include.map(JSONValue.string)),
                "exclude": .array(exclude.map(JSONValue.string)),
                "recrawl": .string(weekly ? "weekly" : "off"),
            ])
        } else {
            body["snippet"] = .object(["question": .string(AgentText.trimmed(question)), "answer": .string(AgentText.trimmed(answer))])
        }
        let trimmedName = AgentText.trimmed(name)
        if !trimmedName.isEmpty || edit.source != nil { body["name"] = .string(trimmedName) }
        do {
            let saved: KnowledgeSource
            if let source = edit.source {
                saved = try await api.patch("v1/ai/knowledge/\(source.id)", body: JSONValue.object(body))
            } else {
                body["kind"] = .string(edit.kind)
                saved = try await api.post("v1/ai/knowledge", body: JSONValue.object(body))
            }
            env.agent.upsert(saved)
            Haptics.success()
            let message = switch (website, edit.source == nil) {
            case (true, true): "Website added, crawling now"
            case (true, false): "Crawl settings saved"
            case (false, true): "Snippet added"
            case (false, false): "Snippet saved"
            }
            env.toasts.show(message, kind: .success)
            dismiss()
        } catch {
            env.toasts.error(error)
        }
    }
}
