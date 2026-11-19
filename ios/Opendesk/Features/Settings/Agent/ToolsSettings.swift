import SwiftUI

/// Settings > AI agent > Tools: the workspace's own MCP servers, whose tools the agent may use to
/// look things up and act for visitors, and how AI clients connect to opendesk's MCP server.
struct ToolsSettings: View {
    static let maxServers = 10

    @Environment(AppEnvironment.self) private var env
    @State private var editing: McpServerEdit?
    @State private var confirm: AccountConfirm?
    @State private var web: AccountWebPage?

    var body: some View {
        let store = env.agent
        let list = store.servers.value
        AccountPage(title: "Tools", spacing: 20) {
            AgentIntro(text: "Connect your own MCP servers so the agent can look things up and take actions for visitors, like finding an order or updating an address.")
            if store.config != nil, !store.behaviour.widgetAnswers { AgentOffNotice() }
            if !store.servers.loaded {
                Panel { SkeletonRows(count: 2) }
            } else if let error = store.servers.error, list.isEmpty {
                Panel { ErrorState(message: error) { Task { await store.loadServers() } } }
            } else if list.isEmpty {
                Panel {
                    VStack(spacing: 10) {
                        EmptyState(symbol: "wrench.and.screwdriver", title: "Give the agent tools", message: "Connect an MCP server from your own systems. Its tools show up here, and you decide which ones the agent may use.", actionTitle: "Connect a server") {
                            editing = McpServerEdit()
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            AgentTip(text: "Tools that change things ask the visitor first by default")
                            AgentTip(text: "Limit tools to visitors whose identity your site verified")
                        }
                        .padding(.bottom, 20)
                    }
                }
            } else {
                AccountSection(title: list.count == 1 ? "1 server" : "\(list.count) servers", footer: "\(list.reduce(0) { $0 + $1.toolsOn }) of 64 tools on") {
                    ForEach(Array(list.enumerated()), id: \.element.id) { index, server in
                        if index > 0 { AccountDivider() }
                        McpServerRow(server: server)
                            .contextMenu { menu(server) }
                    }
                }
                .motion(Motion.snappy, value: list.map(\.id))
            }
            McpClientsCard()
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { editing = McpServerEdit() } label: { Image(systemName: "plus") }
                    .disabled(list.count >= Self.maxServers)
                    .accessibilityLabel("Connect a server")
            }
        }
        .sheet(item: $editing) { edit in
            McpServerEditor(edit: edit) { url in web = AccountWebPage(url: url) }
                .presentationCornerRadius(Theme.Radius.sheet)
        }
        .sheet(item: $web, onDismiss: { Task { await store.loadServers() } }) { page in
            AccountSafariView(url: page.url).ignoresSafeArea()
        }
        .accountConfirm($confirm)
        .refreshable { await store.loadServers() }
        .task {
            if store.config == nil { await store.loadConfig() }
            await store.loadServers()
        }
    }

    @ViewBuilder
    private func menu(_ server: McpServer) -> some View {
        if server.status == "needs_auth" || (server.authKind == "oauth" && !server.oauthConnected) {
            Button("Connect", systemImage: "person.badge.key") { Task { if let url = await McpActions.oauth(server, env: env) { web = AccountWebPage(url: url) } } }
        }
        Button("Sync", systemImage: "arrow.triangle.2.circlepath") { Task { await McpActions.sync(server, env: env) } }
        Button("Edit connection", systemImage: "pencil") { editing = McpServerEdit(server: server) }
        Button("Delete", systemImage: "trash", role: .destructive) { confirm = McpActions.delete(server, env: env) }
    }
}

extension McpServer {
    var statusKey: String { enabled ? status : "off" }

    var statusTitle: String {
        switch statusKey {
        case "needs_auth": "Needs sign-in"
        case "error": "Error"
        case "connecting": "Connecting"
        case "off": "Off"
        default: "Connected"
        }
    }

    var statusTone: Tone {
        switch statusKey {
        case "needs_auth": .amber
        case "error": .red
        case "connecting": .violet
        case "off": .gray
        default: .green
        }
    }
}

private struct McpServerRow: View {
    let server: McpServer

    @Environment(AppEnvironment.self) private var env

    var body: some View {
        HStack(spacing: 10) {
            SettingsDetailLink(page: .tools, id: server.id) {
                HStack(spacing: 12) {
                    AccountIconTile(symbol: "server.rack", tone: .indigo)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(server.name).font(ODFont.sans(15.5, weight: .medium)).foregroundStyle(server.enabled ? Theme.fg : Theme.fg3).lineLimit(1)
                        Text(server.url).font(ODFont.mono(11.5)).foregroundStyle(Theme.fg3).lineLimit(1)
                        HStack(spacing: 6) {
                            TonePill(text: server.statusTitle, tone: server.statusTone, height: 18)
                            Text(server.tools.isEmpty ? "Tools appear after you connect" : "\(server.toolsOn) of \(server.tools.count) on")
                                .font(ODFont.sans(12)).foregroundStyle(Theme.fg4).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 4)
                }
                .padding(.leading, 14)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            Toggle("Use \(server.name)", isOn: Binding(get: { server.enabled }, set: { on in Task { await McpActions.patch(server, ["enabled": .bool(on)], env: env) } }))
                .labelsHidden()
                .tint(Tone.green.solid)
                .padding(.trailing, 14)
        }
    }
}

@MainActor
enum McpActions {
    @discardableResult
    static func patch(_ server: McpServer, _ body: [String: JSONValue], env: AppEnvironment) async -> McpServer? {
        guard let api = env.agent.api else { return nil }
        do {
            let saved: McpServer = try await api.patch("v1/ai/mcp-servers/\(server.id)", body: JSONValue.object(body))
            env.agent.upsert(saved)
            return saved
        } catch {
            env.agent.upsert(server)
            env.toasts.error(error)
            return nil
        }
    }

    /// One tool's setting, applied at once and put back if the server refuses it.
    static func setTool(_ server: McpServer, _ tool: McpTool, _ change: [String: JSONValue], env: AppEnvironment) async {
        var optimistic = server
        if let index = optimistic.tools.firstIndex(where: { $0.name == tool.name }) {
            if let enabled = change["enabled"]?.bool { optimistic.tools[index].enabled = enabled }
            if let policy = change["policy"]?.string { optimistic.tools[index].policy = policy }
            if let verified = change["verified_only"]?.bool { optimistic.tools[index].verifiedOnly = verified }
        }
        env.agent.upsert(optimistic)
        await patch(server, ["tools": .object([tool.name: .object(change)])], env: env)
    }

    static func sync(_ server: McpServer, env: AppEnvironment) async {
        guard let api = env.agent.api else { return }
        do {
            let saved: McpServer = try await api.post("v1/ai/mcp-servers/\(server.id)/sync")
            env.agent.upsert(saved)
            Haptics.success()
            env.toasts.show(saved.tools.count == 1 ? "Synced, 1 tool" : "Synced, \(saved.tools.count) tools", kind: .success)
        } catch {
            env.toasts.error(error)
        }
    }

    /// Where to send the browser to sign in to the server.
    static func oauth(_ server: McpServer, env: AppEnvironment) async -> URL? {
        guard let api = env.agent.api else { return nil }
        do {
            let answer: JSONValue = try await api.post("v1/ai/mcp-servers/\(server.id)/oauth/start")
            guard let raw = answer["url"]?.string, let url = URL(string: raw), url.scheme == "https" || url.scheme == "http" else {
                env.toasts.show("Couldn't start the sign-in", kind: .error)
                return nil
            }
            return url
        } catch {
            env.toasts.error(error)
            return nil
        }
    }

    static func delete(_ server: McpServer, env: AppEnvironment, after: @escaping @MainActor () -> Void = {}) -> AccountConfirm {
        AccountConfirm(title: "Delete this server?", message: "The agent loses access to the tools of \(server.name). Stored credentials are removed and revoked where the server supports it.", confirmTitle: "Delete server") {
            guard let api = env.agent.api else { return }
            do {
                try await api.delete("v1/ai/mcp-servers/\(server.id)")
                env.agent.servers.value.removeAll { $0.id == server.id }
                Haptics.success()
                after()
            } catch {
                env.toasts.error(error)
            }
        }
    }
}

/// "Connect AI clients to opendesk": opendesk is an MCP server too.
private struct McpClientsCard: View {
    @Environment(AppEnvironment.self) private var env
    @State private var copied = false

    private var endpoint: String {
        let api = env.session.instance.apiURL
        var components = URLComponents()
        components.scheme = api.scheme
        components.host = api.host
        components.port = api.port
        components.path = "/mcp"
        return components.string ?? "/mcp"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            AgentGroupTitle(title: "Connect AI clients to opendesk", hint: "opendesk is an MCP server too. Claude, Cursor, VS Code or any MCP client can search tickets, reply and update them, with the scopes of an API key.")
            Panel(padding: 14) {
                VStack(alignment: .leading, spacing: 12) {
                    Button {
                        UIPasteboard.general.string = endpoint
                        Haptics.success()
                        copied = true
                        Task {
                            try? await Task.sleep(for: .seconds(1.6))
                            copied = false
                        }
                    } label: {
                        HStack {
                            Text(endpoint).font(ODFont.mono(13)).foregroundStyle(Theme.fg).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 13)).foregroundStyle(copied ? Tone.green.solid : Theme.fg3)
                        }
                        .padding(.horizontal, 12)
                        .frame(height: 40)
                        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Copy \(endpoint)")
                    Text("Send the key as Authorization: Bearer. The client gets exactly the key's scopes.")
                        .font(ODFont.footnote).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Button("Create an API key") { env.router.accountPath.append(.setting(.apiKeys)) }
                            .buttonStyle(ChipButtonStyle())
                        if let docs = URL(string: "https://docs.opendesk.sh/api/mcp/") {
                            Link(destination: docs) { Label("Setup guide", systemImage: "arrow.up.right") }
                                .buttonStyle(ChipButtonStyle())
                        }
                    }
                }
            }
        }
    }
}

// MARK: - A server

extension ToolsSettings {
    /// One server: its connection, and each tool with whether the agent may use it, how, and a test run.
    struct Detail: View {
        let id: String

        @Environment(AppEnvironment.self) private var env
        @State private var editing: McpServerEdit?
        @State private var confirm: AccountConfirm?
        @State private var web: AccountWebPage?
        @State private var testing: McpTool?
        @State private var syncing = false

        var body: some View {
            let store = env.agent
            Group {
                if let server = store.servers.value.first(where: { $0.id == id }) {
                    page(server)
                } else if store.servers.loaded {
                    AccountPage(title: "Tools") {
                        EmptyState(symbol: "questionmark.circle", title: "This server isn't here any more", message: "It may have been deleted.").padding(.top, 60)
                    }
                } else {
                    AccountPage(title: "Tools") { Panel { SkeletonRows(count: 3) } }
                }
            }
            .task { if !store.servers.loaded { await store.loadServers() } }
            .sheet(item: $editing) { edit in
                McpServerEditor(edit: edit) { url in web = AccountWebPage(url: url) }.presentationCornerRadius(Theme.Radius.sheet)
            }
            .sheet(item: $web, onDismiss: { Task { await store.loadServers() } }) { page in
                AccountSafariView(url: page.url).ignoresSafeArea()
            }
            .sheet(item: $testing) { tool in
                if let server = store.servers.value.first(where: { $0.id == id }) {
                    McpToolTest(server: server, tool: tool).presentationCornerRadius(Theme.Radius.sheet)
                }
            }
            .accountConfirm($confirm)
        }

        private func page(_ server: McpServer) -> some View {
            AccountPage(title: server.name, spacing: 20) {
                HStack(spacing: 12) {
                    AccountIconTile(symbol: "server.rack", tone: .indigo, size: 40)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(server.url).font(ODFont.mono(12)).foregroundStyle(Theme.fg2).lineLimit(2)
                        HStack(spacing: 6) {
                            TonePill(text: server.statusTitle, tone: server.statusTone)
                            if let info = server.serverInfo { Text(info).font(ODFont.sans(12)).foregroundStyle(Theme.fg4) }
                        }
                    }
                    Spacer()
                }
                if let error = server.error, server.status == "error" {
                    Notice(text: error, tone: .red, symbol: "exclamationmark.triangle")
                }
                if server.status == "needs_auth" || (server.authKind == "oauth" && !server.oauthConnected) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Sign in to this server").font(ODFont.sans(14.5, weight: .semibold)).foregroundStyle(Theme.fg)
                        Text("It uses OAuth. You'll be sent to the server to approve access, then back here.").font(ODFont.footnote).foregroundStyle(Theme.fg2)
                        Button("Connect") { Task { if let url = await McpActions.oauth(server, env: env) { web = AccountWebPage(url: url) } } }
                            .buttonStyle(InkButtonStyle(fullWidth: false, height: 38))
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Tone.amber.soft, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                }
                Panel {
                    AccountToggleRow(symbol: "power", tone: .green, title: "Use \(server.name)", isOn: Binding(get: { server.enabled }, set: { on in Task { await McpActions.patch(server, ["enabled": .bool(on)], env: env) } }))
                    AccountDivider()
                    AccountRow(symbol: "key", tone: .gray, title: server.authText, subtitle: server.lastSyncedAt.map { "Synced \(Format.relLong($0))" })
                }
                HStack(spacing: 8) {
                    Button {
                        Task {
                            syncing = true
                            await McpActions.sync(server, env: env)
                            syncing = false
                        }
                    } label: {
                        if syncing { ProgressView().controlSize(.small) } else { Label("Sync", systemImage: "arrow.triangle.2.circlepath") }
                    }
                    .buttonStyle(ChipButtonStyle())
                    .disabled(syncing)
                    Button { editing = McpServerEdit(server: server) } label: { Label("Edit connection", systemImage: "pencil") }
                        .buttonStyle(ChipButtonStyle())
                }
                VStack(alignment: .leading, spacing: 8) {
                    SectionLabel("Tools").padding(.horizontal, 4)
                    if server.tools.isEmpty {
                        Panel {
                            Text(server.status == "connected" ? "This server doesn't offer any tools." : "Tools appear after you connect")
                                .font(ODFont.footnote).foregroundStyle(Theme.fg3).padding(14)
                        }
                    }
                    ForEach(server.tools) { tool in
                        McpToolCard(server: server, tool: tool) { testing = tool }
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Button("Delete server", role: .destructive) {
                        confirm = McpActions.delete(server, env: env) { env.router.accountPath.removeLast() }
                    }
                    .buttonStyle(OutlineButtonStyle(tint: Tone.red.text))
                    Text("The agent stops using its tools. Stored credentials are removed.").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                }
            }
            .refreshable { await env.agent.loadServers() }
        }
    }
}

private struct McpToolCard: View {
    let server: McpServer
    let tool: McpTool
    let test: () -> Void

    @Environment(AppEnvironment.self) private var env
    @State private var more = false

    var body: some View {
        Panel {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(tool.shownName).font(ODFont.sans(15, weight: .semibold)).foregroundStyle(Theme.fg)
                        if tool.title != nil, tool.title != tool.name {
                            Text(tool.name).font(ODFont.mono(11.5)).foregroundStyle(Theme.fg4)
                        }
                        HStack(spacing: 6) {
                            if tool.readOnly {
                                TonePill(text: "Read-only", tone: .teal, height: 18)
                            } else if tool.destructive {
                                TonePill(text: "Destructive", tone: .red, height: 18)
                            } else {
                                TonePill(text: "Makes changes", tone: .amber, height: 18)
                            }
                        }
                    }
                    Spacer()
                    Toggle("Let the agent use \(tool.shownName)", isOn: Binding(get: { tool.enabled }, set: { on in Task { await McpActions.setTool(server, tool, ["enabled": .bool(on)], env: env) } }))
                        .labelsHidden()
                        .tint(Tone.green.solid)
                }
                if !tool.description.isEmpty {
                    Text(tool.description)
                        .font(ODFont.footnote)
                        .foregroundStyle(Theme.fg2)
                        .lineLimit(more ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                    if tool.description.count > 120 {
                        Button(more ? "Less" : "More") { withAnimation(Motion.snappy) { more.toggle() } }
                            .font(ODFont.sans(12.5, weight: .medium))
                            .foregroundStyle(Theme.fg3)
                    }
                }
                if tool.enabled {
                    if !tool.readOnly {
                        AccountSegmented(options: ["confirm", "auto"], selection: Binding(get: { tool.policy }, set: { policy in Task { await McpActions.setTool(server, tool, ["policy": .string(policy)], env: env) } }), label: { $0 == "auto" ? "Auto" : "Ask visitor to confirm" }, height: 32)
                        if tool.policy == "auto" {
                            Notice(text: "This tool makes changes and runs without asking the visitor.", tone: .amber, symbol: "exclamationmark.triangle")
                        }
                    }
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Verified visitors only").font(ODFont.sans(14)).foregroundStyle(Theme.fg)
                            Text("Offered only when your site verified the visitor's identity in the widget.").font(ODFont.footnote).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer()
                        Toggle("Verified visitors only", isOn: Binding(get: { tool.verifiedOnly }, set: { on in Task { await McpActions.setTool(server, tool, ["verified_only": .bool(on)], env: env) } }))
                            .labelsHidden()
                            .tint(Tone.green.solid)
                    }
                }
                Button(action: test) { Label("Test", systemImage: "play") }
                    .buttonStyle(ChipButtonStyle())
            }
            .padding(14)
        }
        .opacity(tool.enabled ? 1 : 0.8)
        .motion(Motion.snappy, value: tool.enabled)
    }
}

// MARK: - Connect or edit a server

struct McpServerEdit: Identifiable {
    let id = UUID()
    var server: McpServer?
}

/// Add a server or change its connection. Secrets are write-only: stored encrypted, never shown.
private struct McpServerEditor: View {
    let edit: McpServerEdit
    /// Opens the server's sign-in page when it uses OAuth.
    let signIn: (URL) -> Void

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = ""
    @State private var kind = "none"
    @State private var token = ""
    @State private var headerName = ""
    @State private var headerValue = ""
    @State private var replacing = false
    @State private var tried = false
    @State private var busy = false
    @State private var started = false

    private static let badHeaders: Set<String> = ["host", "cookie", "connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]

    private var editingSecret: Bool { edit.server?.hasSecret == true && edit.server?.authKind == kind && !replacing }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("A remote MCP server over HTTPS. opendesk lists its tools and sends who the visitor is with every call.")
                        .font(ODFont.callout).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
                    AgentField(label: "Name", text: $name, prompt: "Orders", hint: "Shown to your team and used in tool names.", max: 60, problem: tried ? nameProblem : nil)
                    AgentField(label: "Server address", text: $url, prompt: "https://api.example.com/mcp", hint: "The MCP endpoint, usually ending in /mcp.", problem: tried ? urlProblem : nil, keyboard: .URL)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Authentication").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                        AccountSegmented(options: ["none", "bearer", "header", "oauth"], selection: $kind, label: { ["none": "None", "bearer": "Bearer", "header": "Header", "oauth": "OAuth"][$0] ?? $0 })
                        Text(authHint).font(ODFont.footnote).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
                    }
                    if kind == "header" {
                        AgentField(label: "Header name", text: $headerName, prompt: "X-Api-Key", problem: tried ? headerProblem : nil, keyboard: .URL)
                    }
                    if kind == "bearer" || kind == "header" { secret }
                }
                .padding(20)
                .padding(.bottom, 40)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.chrome)
            .accountTitle(edit.server == nil ? "Connect an MCP server" : "Edit connection")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(.confirm, edit.server == nil ? (kind == "oauth" ? "Add and sign in" : "Connect") : "Save", busy: busy) { Task { await save() } }
                        .fontWeight(.semibold)
                    .disabled(busy)
                }
            }
        }
        .onAppear {
            guard !started else { return }
            started = true
            guard let server = edit.server else { return }
            name = server.name
            url = server.url
            kind = server.authKind
            headerName = server.headerName
        }
    }

    @ViewBuilder
    private var secret: some View {
        let label = kind == "bearer" ? "Token" : "Header value"
        if editingSecret {
            VStack(alignment: .leading, spacing: 6) {
                Text(label).font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                HStack {
                    Image(systemName: "lock.fill").font(.system(size: 12)).foregroundStyle(Theme.fg3)
                    Text("Set").font(ODFont.sans(15, weight: .medium)).foregroundStyle(Theme.fg)
                    Text("Stored encrypted, never shown").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                    Spacer()
                    Button("Replace") { replacing = true }
                        .buttonStyle(ChipButtonStyle())
                }
                .padding(.horizontal, 13)
                .frame(height: 46)
                .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ODTextField(label: label, text: kind == "bearer" ? $token : $headerValue, secure: true, contentType: .password, keyboard: .asciiCapable)
                Text(replacing ? "The stored value is replaced when you save." : "Stored encrypted. It isn't shown again.")
                    .font(ODFont.footnote).foregroundStyle(Theme.fg3)
                if tried, secretMissing { FormError(text: "Enter a value") }
            }
        }
    }

    private var authHint: String {
        switch kind {
        case "bearer": "Sent as Authorization: Bearer on every request."
        case "header": "A custom header with a key, like X-Api-Key."
        case "oauth": "You'll sign in on the server after adding it."
        default: "For servers that don't need credentials, or that ask you to sign in after connecting."
        }
    }

    private var nameProblem: String? {
        let count = AgentText.trimmed(name).count
        return count < 1 || count > 60 ? "Between 1 and 60 characters" : nil
    }

    private var urlProblem: String? {
        let raw = AgentText.trimmed(url)
        if raw.isEmpty { return "Enter the server address" }
        guard let parsed = URL(string: raw), parsed.scheme == "https", parsed.host != nil else { return "Enter an https address" }
        return nil
    }

    private var headerProblem: String? {
        let raw = AgentText.trimmed(headerName).lowercased()
        let valid = !raw.isEmpty && raw.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" } && raw.allSatisfy(\.isASCII)
        if !valid || Self.badHeaders.contains(raw) || raw.hasPrefix("proxy-") || raw.hasPrefix("content-") {
            return "Use a valid header name. Host, Cookie and Content headers aren't allowed."
        }
        return nil
    }

    private var secretMissing: Bool {
        guard !editingSecret else { return false }
        switch kind {
        case "bearer": return AgentText.trimmed(token).isEmpty
        case "header": return AgentText.trimmed(headerValue).isEmpty
        default: return false
        }
    }

    private var authChanged: Bool {
        guard let server = edit.server else { return true }
        return server.authKind != kind || replacing || (kind == "header" && server.headerName != AgentText.trimmed(headerName))
            || (!server.hasSecret && (kind == "bearer" || kind == "header"))
    }

    private func save() async {
        tried = true
        let bad = nameProblem != nil || urlProblem != nil || (kind == "header" && headerProblem != nil) || (authChanged && secretMissing)
        guard !bad, let api = env.agent.api else {
            Haptics.error()
            return
        }
        busy = true
        defer { busy = false }
        var auth: [String: JSONValue] = ["kind": .string(kind)]
        if kind == "bearer", !AgentText.trimmed(token).isEmpty { auth["token"] = .string(AgentText.trimmed(token)) }
        if kind == "header" {
            auth["header_name"] = .string(AgentText.trimmed(headerName))
            if !AgentText.trimmed(headerValue).isEmpty { auth["header_value"] = .string(AgentText.trimmed(headerValue)) }
        }
        var body: [String: JSONValue] = ["name": .string(AgentText.trimmed(name)), "url": .string(AgentText.trimmed(url))]
        if authChanged { body["auth"] = .object(auth) }
        do {
            let saved: McpServer
            if let server = edit.server {
                saved = try await api.patch("v1/ai/mcp-servers/\(server.id)", body: JSONValue.object(body))
                env.toasts.show("Connection saved", kind: .success)
            } else {
                saved = try await api.post("v1/ai/mcp-servers", body: JSONValue.object(body))
                if saved.status == "needs_auth" || kind == "oauth" {
                    env.toasts.show("\(saved.name) asks you to sign in. Connect to finish.")
                } else {
                    env.toasts.show(saved.tools.count == 1 ? "\(saved.name) connected with 1 tool" : "\(saved.name) connected with \(saved.tools.count) tools", kind: .success)
                }
            }
            env.agent.upsert(saved)
            token = ""
            headerValue = ""
            Haptics.success()
            let needsSignIn = saved.status == "needs_auth" || (saved.authKind == "oauth" && !saved.oauthConnected)
            dismiss()
            if needsSignIn, let url = await McpActions.oauth(saved, env: env) { signIn(url) }
        } catch {
            env.toasts.error(error)
        }
    }
}

// MARK: - Test a tool

/// "Run this tool once": a form for simple inputs, JSON for anything else.
private struct McpToolTest: View {
    let server: McpServer
    let tool: McpTool

    private struct Field: Identifiable {
        var id: String { name }
        let name: String
        let type: String
        let description: String
        let required: Bool
        let options: [String]
    }

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var json = false
    @State private var values: [String: String] = [:]
    @State private var flags: [String: Bool] = [:]
    @State private var raw = "{}"
    @State private var email = ""
    @State private var verified = false
    @State private var result: McpToolResult?
    @State private var busy = false
    @State private var started = false

    private var fields: [Field]? {
        let props = tool.inputSchema["properties"]?.object ?? [:]
        let required = Set(tool.inputSchema["required"]?.array?.compactMap(\.string) ?? [])
        let out = props.keys.sorted().map { name -> Field in
            let prop = props[name] ?? .object([:])
            let type = prop["type"]?.string ?? prop["type"]?.array?.compactMap(\.string).first { $0 != "null" } ?? "string"
            return Field(name: name, type: type, description: prop["description"]?.string ?? "", required: required.contains(name), options: prop["enum"]?.array?.compactMap(\.displayText) ?? [])
        }
        return out.allSatisfy { ["string", "number", "integer", "boolean"].contains($0.type) } ? out : nil
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(tool.shownName).font(ODFont.sans(17, weight: .semibold)).foregroundStyle(Theme.fg)
                    if !tool.readOnly {
                        Notice(text: "This runs for real, whatever the policy.", tone: .amber, symbol: "exclamationmark.triangle")
                    }
                    if fields != nil {
                        AccountSegmented(options: [false, true], selection: $json, label: { $0 ? "JSON" : "Form" }, height: 30)
                            .frame(width: 180)
                    } else {
                        Text("This tool takes structured input, so write its arguments as JSON.").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                    }
                    if let fields, !json {
                        if fields.isEmpty {
                            Text("This tool takes no arguments.").font(ODFont.footnote).foregroundStyle(Theme.fg3)
                        }
                        ForEach(fields) { field in fieldView(field) }
                    } else {
                        AccountTextEditor(label: "Arguments", text: $raw, prompt: "{}", minHeight: 140, mono: true)
                        if let problem = jsonProblem { FormError(text: problem) }
                    }
                    AgentField(label: "Visitor email (optional)", text: $email, prompt: "ada@example.com", keyboard: .emailAddress)
                    Panel {
                        AccountToggleRow(title: "Verified", isOn: $verified)
                    }
                    Button { Task { await run() } } label: { ButtonLabel(title: "Run", busy: busy, symbol: "play.fill") }
                        .buttonStyle(InkButtonStyle())
                        .disabled(busy || args == nil || !missing.isEmpty)
                    if let result {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(result.isError ? "The tool answered with an error" : "Result")
                                    .font(ODFont.sans(13, weight: .semibold))
                                    .foregroundStyle(result.isError ? Tone.red.text : Theme.fg)
                                Spacer()
                                Text("\(result.ms) ms").font(ODFont.mono(11)).foregroundStyle(Theme.fg4)
                            }
                            ScrollView(.horizontal) {
                                Text(Self.pretty(result.content))
                                    .font(ODFont.mono(12))
                                    .foregroundStyle(Theme.fg2)
                                    .textSelection(.enabled)
                                    .padding(12)
                            }
                            .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                        }
                    }
                }
                .padding(20)
                .padding(.bottom, 40)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.chrome)
            .accountTitle("Run this tool once")
            .toolbar { ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Close") { dismiss() } } }
        }
        .onAppear {
            guard !started else { return }
            started = true
            json = fields == nil
            if fields == nil { raw = Self.example(tool.inputSchema) }
        }
    }

    @ViewBuilder
    private func fieldView(_ field: Field) -> some View {
        let label = field.required ? "\(field.name) *" : field.name
        if field.type == "boolean" {
            Panel {
                AccountToggleRow(title: label, subtitle: field.description.isEmpty ? nil : field.description, isOn: Binding(get: { flags[field.name] ?? false }, set: { flags[field.name] = $0 }))
            }
        } else if !field.options.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(label).font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                Menu {
                    ForEach(field.options, id: \.self) { option in
                        Button(option) { values[field.name] = option }
                    }
                } label: {
                    HStack {
                        Text(values[field.name] ?? "Choose").font(ODFont.sans(15)).foregroundStyle(values[field.name] == nil ? Theme.fg4 : Theme.fg)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.fg3)
                    }
                    .padding(.horizontal, 13)
                    .frame(height: 44)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
                }
                if !field.description.isEmpty { Text(field.description).font(ODFont.footnote).foregroundStyle(Theme.fg3) }
            }
        } else {
            AgentField(label: label, text: Binding(get: { values[field.name] ?? "" }, set: { values[field.name] = $0 }), hint: field.description.isEmpty ? nil : field.description, keyboard: field.type == "string" ? .default : .numbersAndPunctuation)
        }
    }

    private var jsonProblem: String? {
        guard let parsed = try? JSONValue.parse(Data((raw.isEmpty ? "{}" : raw).utf8)) else { return "This isn't valid JSON" }
        return parsed.object == nil ? "Arguments are a JSON object, like {}" : nil
    }

    private var args: [String: JSONValue]? {
        if let fields, !json {
            var out: [String: JSONValue] = [:]
            for field in fields {
                if field.type == "boolean" {
                    if let flag = flags[field.name] { out[field.name] = .bool(flag) }
                } else if let value = values[field.name], !AgentText.trimmed(value).isEmpty {
                    if field.type == "number" || field.type == "integer" {
                        guard let number = Double(AgentText.trimmed(value)) else { return nil }
                        out[field.name] = .number(number)
                    } else {
                        out[field.name] = .string(value)
                    }
                }
            }
            return out
        }
        return (try? JSONValue.parse(Data((raw.isEmpty ? "{}" : raw).utf8)))?.object
    }

    private var missing: [String] {
        guard let fields, !json, let args else { return [] }
        return fields.filter { $0.required && args[$0.name] == nil }.map(\.name)
    }

    private func run() async {
        guard let api = env.agent.api, let args else { return }
        busy = true
        defer { busy = false }
        var body: [String: JSONValue] = ["arguments": .object(args)]
        if verified || !AgentText.trimmed(email).isEmpty {
            var visitor: [String: JSONValue] = ["verified": .bool(verified)]
            if !AgentText.trimmed(email).isEmpty { visitor["email"] = .string(AgentText.trimmed(email)) }
            body["visitor"] = .object(visitor)
        }
        let name = tool.name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? tool.name
        do {
            result = try await api.post("v1/ai/mcp-servers/\(server.id)/tools/\(name)/test", body: JSONValue.object(body))
            if result?.isError == true { Haptics.error() } else { Haptics.success() }
        } catch {
            env.toasts.error(error)
        }
    }

    private static func pretty(_ text: String) -> String {
        guard let data = text.data(using: .utf8), let object = try? JSONSerialization.jsonObject(with: data),
              let out = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return text }
        return String(decoding: out, as: UTF8.self)
    }

    private static func example(_ schema: JSONValue) -> String {
        let props = schema["properties"]?.object ?? [:]
        var out: [String: Any] = [:]
        for (name, prop) in props {
            let type = prop["type"]?.string ?? "string"
            switch type {
            case "number", "integer": out[name] = 0
            case "boolean": out[name] = false
            case "array": out[name] = [Any]()
            case "object": out[name] = [String: Any]()
            default: out[name] = ""
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: out, options: [.prettyPrinted, .sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
