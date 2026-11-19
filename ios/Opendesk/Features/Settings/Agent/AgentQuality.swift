import SwiftUI

// The agent's quality tools (contracts/agent.md "Tests", "Improve an answer"): the test editor,
// the improve-answer sheet, and the pieces the Tests page, the playground and the review queue share.

enum AgentTests {
    static let maxTests = 200
    static let maxMessages = 6
    static let maxExpectations = 10
    static let valueMax = 1000

    /// The playground's last messages as a test conversation, ending with the visitor's.
    static func conversation(_ all: [AgentLine]) -> [AgentLine] {
        guard let end = all.lastIndex(where: { $0.role == "visitor" }) else { return [] }
        let slice = all[...end].suffix(maxMessages)
        return slice.map { AgentLine(role: $0.role, text: String($0.text.prefix(4000))) }
    }
}

extension AgentStore {
    /// Tools the agent may call, by their keys, with readable names.
    var toolOptions: [(value: String, label: String)] {
        servers.value.filter(\.enabled).flatMap { server in
            server.tools.filter(\.enabled).map { (value: server.key($0), label: "\(server.name) · \($0.shownName)") }
        }
    }

    func valueLabel(_ kind: String, _ value: String) -> String {
        switch kind {
        case "uses_tool": toolOptions.first { $0.value == value }?.label ?? value.replacingOccurrences(of: "__", with: " · ")
        case "uses_procedure": procedures.value.first { $0.id == value }?.name ?? value
        default: value
        }
    }

    /// "Mentions: refunds take 5 days", "Hands off to the team".
    func expectationText(_ e: AgentExpectation) -> String {
        guard AgentExpectation.needsValue(e.kind), !e.value.isEmpty else { return AgentExpectation.title(e.kind) }
        return "\(AgentExpectation.title(e.kind)): \(valueLabel(e.kind, e.value))"
    }
}

struct AgentTestStatePill: View {
    let state: AgentTestState

    var body: some View {
        TonePill(text: state.title, tone: state.tone) {
            Image(systemName: state.symbol).font(.system(size: 10, weight: .semibold))
        }
    }
}

/// Each check of a result: passed or failed, with the grader's reason.
struct AgentCheckList: View {
    let checks: [AgentTestCheck]

    @Environment(AppEnvironment.self) private var env

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(checks.enumerated()), id: \.offset) { _, check in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: check.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(check.passed ? Tone.green.solid : Tone.red.solid)
                        .accessibilityLabel(check.passed ? "Passed" : "Failed")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(env.agent.expectationText(AgentExpectation(kind: check.kind, value: check.value)))
                            .font(ODFont.sans(14, weight: .medium))
                            .foregroundStyle(Theme.fg)
                        if !check.reason.isEmpty {
                            Text(check.reason).font(ODFont.footnote).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }
}

// MARK: - Test editor

/// What the editor starts from: a test to edit, or a new one, perhaps prefilled.
struct AgentTestDraft: Identifiable {
    let id = UUID()
    var test: AgentTest?
    var messages: [AgentLine] = []
    var expectations: [AgentExpectation] = []
}

struct AgentTestEditor: View {
    let draft: AgentTestDraft

    private struct Row: Identifiable {
        let id = UUID()
        var role: String
        var text: String
    }

    private struct Check: Identifiable {
        let id = UUID()
        var kind: String
        var value: String
    }

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var rows: [Row] = []
    @State private var checks: [Check] = []
    @State private var verified = false
    @State private var userID = ""
    @State private var email = ""
    @State private var tried = false
    @State private var busy = false
    @State private var started = false

    var body: some View {
        let store = env.agent
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Text("The conversation Ollie answers, and what the answer must do.")
                        .font(ODFont.callout).foregroundStyle(Theme.fg3)
                    AgentField(label: "Name", text: $name, prompt: rows.first { $0.role == "visitor" }.map { String($0.text.prefix(80)) }.flatMap { $0.isEmpty ? nil : $0 } ?? "Refund timing", hint: "Leave it empty to use the visitor's first message.", max: 100)
                    conversation
                    expectations(store)
                    visitor
                    if tried, let problem = formProblem {
                        FormError(text: problem)
                    }
                }
                .padding(20)
                .padding(.bottom, 40)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.chrome)
            .accountTitle(draft.test == nil ? "New test" : "Edit test")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(.confirm, draft.test == nil ? "Create" : "Save", busy: busy) { Task { await save() } }
                        .fontWeight(.semibold)
                    .disabled(busy)
                }
            }
        }
        .task {
            guard !started else { return }
            started = true
            let source = draft.test
            name = source?.name ?? ""
            let messages = source?.messages ?? draft.messages
            rows = (messages.isEmpty ? [AgentLine(role: "visitor", text: "")] : Array(messages.suffix(AgentTests.maxMessages))).map { Row(role: $0.role, text: $0.text) }
            checks = (source?.expectations ?? draft.expectations).map { Check(kind: $0.kind, value: $0.value) }
            verified = source?.visitor.verified ?? false
            userID = source?.visitor.userID ?? ""
            email = source?.visitor.email ?? ""
            if !store.servers.loaded { await store.loadServers() }
            if !store.procedures.loaded { await store.loadProcedures() }
        }
    }

    private var conversation: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Conversation").font(ODFont.sans(14.5, weight: .semibold)).foregroundStyle(Theme.fg)
                Spacer()
                Text("Up to \(AgentTests.maxMessages) messages, ending with the visitor's").font(ODFont.sans(11.5)).foregroundStyle(Theme.fg4)
            }
            ForEach($rows) { $row in
                let index = rows.firstIndex { $0.id == row.id } ?? 0
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        AccountSegmented(options: ["visitor", "agent"], selection: $row.role, label: { $0 == "visitor" ? "Visitor" : "Ollie" }, height: 30)
                            .frame(width: 170)
                        Spacer()
                        Button {
                            withAnimation(Motion.snappy) { rows.removeAll { $0.id == row.id } }
                        } label: {
                            Image(systemName: "minus.circle").font(.system(size: 16)).foregroundStyle(Theme.fg3)
                        }
                        .buttonStyle(.plain)
                        .disabled(rows.count == 1)
                        .accessibilityLabel("Remove message")
                    }
                    AgentField(label: "Message \(index + 1)", text: $row.text, prompt: row.role == "visitor" ? "What the visitor writes" : "What Ollie said before", max: 4000, multiline: true, problem: tried ? rowProblem(row) : nil)
                }
                .padding(12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
            }
            Button {
                withAnimation(Motion.snappy) { rows.append(Row(role: rows.last?.role == "visitor" ? "agent" : "visitor", text: "")) }
            } label: {
                Label("Add message", systemImage: "plus")
            }
            .buttonStyle(ChipButtonStyle())
            .disabled(rows.count >= AgentTests.maxMessages)
            if tried, rows.last?.role != "visitor" {
                FormError(text: "The last message must be the visitor's.")
            }
        }
    }

    private func expectations(_ store: AgentStore) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Checks").font(ODFont.sans(14.5, weight: .semibold)).foregroundStyle(Theme.fg)
                Spacer()
                Text("Up to \(AgentTests.maxExpectations)").font(ODFont.sans(11.5)).foregroundStyle(Theme.fg4)
            }
            if checks.isEmpty {
                Text("Add at least one check, like what the answer must mention.")
                    .font(ODFont.footnote)
                    .foregroundStyle(tried ? Tone.red.text : Theme.fg3)
            }
            ForEach($checks) { $check in
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Menu {
                            Picker("Check", selection: $check.kind) {
                                ForEach(AgentExpectation.kinds, id: \.self) { kind in
                                    Text(AgentExpectation.title(kind)).tag(kind)
                                }
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Text(AgentExpectation.title(check.kind)).font(ODFont.sans(14.5, weight: .medium)).foregroundStyle(Theme.fg)
                                Image(systemName: "chevron.up.chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.fg3)
                            }
                        }
                        .onChange(of: check.kind) { _, kind in check.value = defaultValue(kind, store) }
                        Spacer()
                        Button {
                            withAnimation(Motion.snappy) { checks.removeAll { $0.id == check.id } }
                        } label: {
                            Image(systemName: "minus.circle").font(.system(size: 16)).foregroundStyle(Theme.fg3)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove check")
                    }
                    Text(AgentExpectation.hint(check.kind)).font(ODFont.footnote).foregroundStyle(Theme.fg3)
                    valueField($check, store)
                    if tried, let problem = checkProblem(check) { FormError(text: problem) }
                }
                .padding(12)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
            }
            Menu {
                ForEach(AgentExpectation.kinds, id: \.self) { kind in
                    Button(AgentExpectation.title(kind)) {
                        withAnimation(Motion.snappy) { checks.append(Check(kind: kind, value: defaultValue(kind, store))) }
                    }
                }
            } label: {
                Label("Add check", systemImage: "plus")
            }
            .buttonStyle(ChipButtonStyle())
            .disabled(checks.count >= AgentTests.maxExpectations)
            if tried, conflict {
                FormError(text: "A test can't expect a handoff and no handoff.")
            }
        }
    }

    @ViewBuilder
    private func valueField(_ check: Binding<Check>, _ store: AgentStore) -> some View {
        switch check.wrappedValue.kind {
        case "mentions", "not_mentions":
            AgentField(label: "Text", text: check.value, prompt: check.wrappedValue.kind == "mentions" ? "Refunds take 5 to 10 business days" : "Phone support", max: AgentTests.valueMax)
        case "uses_tool":
            let options = store.toolOptions
            if options.isEmpty {
                Text("Connect a tool on the Tools page first.").font(ODFont.footnote).foregroundStyle(Theme.fg3)
            } else {
                pickMenu(title: check.wrappedValue.value.isEmpty ? "Choose a tool" : store.valueLabel("uses_tool", check.wrappedValue.value), options: options, value: check.value)
            }
        case "uses_procedure":
            let options = store.procedures.value.map { (value: $0.id, label: $0.name) }
            if options.isEmpty {
                Text("Write a procedure on the Procedures page first.").font(ODFont.footnote).foregroundStyle(Theme.fg3)
            } else {
                pickMenu(title: check.wrappedValue.value.isEmpty ? "Choose a procedure" : store.valueLabel("uses_procedure", check.wrappedValue.value), options: options, value: check.value)
            }
        default:
            EmptyView()
        }
    }

    private func pickMenu(title: String, options: [(value: String, label: String)], value: Binding<String>) -> some View {
        Menu {
            ForEach(options, id: \.value) { option in
                Button {
                    value.wrappedValue = option.value
                } label: {
                    if value.wrappedValue == option.value { Label(option.label, systemImage: "checkmark") } else { Text(option.label) }
                }
            }
        } label: {
            HStack {
                Text(title).font(ODFont.sans(14.5)).foregroundStyle(value.wrappedValue.isEmpty ? Theme.fg4 : Theme.fg).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.fg3)
            }
            .padding(.horizontal, 12)
            .frame(height: 42)
            .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
        }
    }

    private var visitor: some View {
        VStack(alignment: .leading, spacing: 10) {
            Panel {
                AccountToggleRow(symbol: "person.badge.shield.checkmark", tone: .teal, title: "Signed-in visitor", subtitle: "Tools only for verified visitors are offered, with this identity.", isOn: $verified)
            }
            if verified {
                AgentField(label: "User ID", text: $userID, prompt: "usr_123", mono: true)
                AgentField(label: "Email", text: $email, prompt: "ada@example.com", keyboard: .emailAddress)
            }
        }
        .motion(Motion.snappy, value: verified)
    }

    private func defaultValue(_ kind: String, _ store: AgentStore) -> String {
        switch kind {
        case "uses_tool": store.toolOptions.count == 1 ? store.toolOptions[0].value : ""
        case "uses_procedure": store.procedures.value.count == 1 ? store.procedures.value[0].id : ""
        default: ""
        }
    }

    private func rowProblem(_ row: Row) -> String? {
        if AgentText.trimmed(row.text).isEmpty { return "Write the message." }
        if row.text.count > 4000 { return "A message can be at most 4,000 characters." }
        return nil
    }

    private func checkProblem(_ check: Check) -> String? {
        switch check.kind {
        case "uses_tool": return check.value.isEmpty ? "Choose a tool" : nil
        case "uses_procedure": return check.value.isEmpty ? "Choose a procedure" : nil
        case "mentions", "not_mentions":
            if AgentText.trimmed(check.value).isEmpty { return "Describe what to look for." }
            return check.value.count > AgentTests.valueMax ? "Keep it under 1,000 characters." : nil
        default: return nil
        }
    }

    private var conflict: Bool {
        let kinds = Set(checks.map(\.kind))
        return kinds.contains("handoff") && kinds.contains("no_handoff")
    }

    private var formProblem: String? {
        if rows.contains(where: { rowProblem($0) != nil }) || rows.last?.role != "visitor" { return "Check the conversation above." }
        if checks.isEmpty || checks.contains(where: { checkProblem($0) != nil }) || conflict { return "Check the checks above." }
        if name.count > 100 { return "Keep the name under 100 characters." }
        return nil
    }

    private func save() async {
        tried = true
        guard formProblem == nil, let api = env.agent.api else {
            Haptics.error()
            return
        }
        busy = true
        defer { busy = false }
        var body: [String: JSONValue] = [
            "messages": .array(rows.map { AgentLine(role: $0.role, text: AgentText.trimmed($0.text)).json }),
            "expectations": .array(checks.map { AgentExpectation(kind: $0.kind, value: AgentText.trimmed($0.value)).json }),
        ]
        let trimmedName = AgentText.trimmed(name)
        if !trimmedName.isEmpty || draft.test != nil { body["name"] = .string(trimmedName) }
        var person: [String: JSONValue] = [:]
        if verified {
            person["verified"] = .bool(true)
            if !AgentText.trimmed(userID).isEmpty { person["user_id"] = .string(AgentText.trimmed(userID)) }
            if !AgentText.trimmed(email).isEmpty { person["email"] = .string(AgentText.trimmed(email)) }
        }
        if verified || draft.test != nil { body["visitor"] = .object(person) }
        do {
            let saved: AgentTest
            if let test = draft.test {
                saved = try await api.patch("v1/ai/agent/tests/\(test.id)", body: JSONValue.object(body))
            } else {
                saved = try await api.post("v1/ai/agent/tests", body: JSONValue.object(body))
            }
            env.agent.upsert(saved)
            Haptics.success()
            env.toasts.show(draft.test == nil ? "Test created" : "Test saved", kind: .success)
            dismiss()
        } catch {
            env.toasts.error(error)
        }
    }
}

// MARK: - Improve an answer

struct AgentImproveDraft: Identifiable {
    let id = UUID()
    var question: String
    var answer: String
    var messageID: String?
    var ratedDown = false
}

/// "Improve this answer": a better answer saved as a Q&A snippet, and perhaps a test.
struct AgentImproveSheet: View {
    let draft: AgentImproveDraft

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var question = ""
    @State private var better = ""
    @State private var saveTest = true
    @State private var tried = false
    @State private var busy = false
    @State private var started = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text(draft.ratedDown ? "The visitor rated this not helpful. Write a better answer Ollie will use." : "Your answer is saved as a Q&A snippet, and Ollie answers from it at once.")
                        .font(ODFont.callout)
                        .foregroundStyle(Theme.fg3)
                        .fixedSize(horizontal: false, vertical: true)
                    AgentField(label: "Visitor's question", text: $question, hint: "Ollie uses your answer when visitors ask something like this.", multiline: true, problem: tried ? questionProblem : nil)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Ollie's answer").font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                        Group {
                            if AgentText.trimmed(draft.answer).isEmpty {
                                Text("Ollie didn't write an answer.").font(ODFont.callout).foregroundStyle(Theme.fg4)
                            } else {
                                MarkdownText(text: draft.answer, size: 14.5, color: Theme.fg2)
                            }
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.sunken, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                        if !AgentText.trimmed(draft.answer).isEmpty {
                            Button("Start from Ollie's answer") { better = draft.answer }
                                .buttonStyle(ChipButtonStyle(tone: .violet))
                        }
                    }
                    AgentField(label: "Better answer", text: $better, prompt: "What Ollie should have said", hint: "Markdown works: bold, lists and links.", multiline: true, problem: tried ? answerProblem : nil)
                    Panel {
                        AccountToggleRow(symbol: "checklist", tone: .violet, title: "Also save as a test", subtitle: "A test that checks Ollie's answer mentions this, so it stays fixed.", isOn: $saveTest)
                    }
                }
                .padding(20)
                .padding(.bottom, 40)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.chrome)
            .accountTitle("Improve this answer")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(.confirm, "Save", busy: busy) { Task { await save() } }
                        .fontWeight(.semibold)
                    .disabled(busy)
                }
            }
        }
        .onAppear {
            guard !started else { return }
            started = true
            question = draft.question
        }
    }

    private var questionProblem: String? {
        let count = AgentText.trimmed(question).count
        return count < 3 || count > 4000 ? "The question needs 3 to 4,000 characters." : nil
    }

    private var answerProblem: String? {
        let count = AgentText.trimmed(better).count
        return count < 1 || count > 4000 ? "Write an answer of up to 4,000 characters." : nil
    }

    private func save() async {
        tried = true
        guard questionProblem == nil, answerProblem == nil, let api = env.agent.api else {
            Haptics.error()
            return
        }
        busy = true
        defer { busy = false }
        var body: [String: JSONValue] = [
            "question": .string(AgentText.trimmed(question)),
            "answer": .string(AgentText.trimmed(better)),
            "save_test": .bool(saveTest),
        ]
        if let id = draft.messageID { body["message_id"] = .string(id) }
        do {
            let result: JSONValue = try await api.post("v1/ai/agent/improve", body: JSONValue.object(body))
            if let test = try? result["test"]?.decode(AgentTest.self), !test.id.isEmpty { env.agent.upsert(test) }
            if let id = draft.messageID { env.agent.review.value.removeAll { $0.id == id } }
            env.agent.refresh("knowledge") { await $0.loadKnowledge() }
            Haptics.success()
            let router = env.router
            env.toasts.show(Toast(
                message: saveTest ? "Answer saved. Ollie answers from it now, and a test checks it." : "Answer saved. Ollie answers from it now.",
                kind: .success,
                actionTitle: saveTest ? "View tests" : nil,
                action: saveTest ? { router.accountPath.append(.setting(.tests)) } : nil
            ))
            dismiss()
        } catch {
            env.toasts.error(error)
        }
    }
}
