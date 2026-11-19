import SwiftUI

/// Adds a database row or changes one's values (contracts/wiki.md "Databases"): its title and
/// each stored property, edited by its type. A new row may start as a copy of one of the
/// database's templates; a form view asks only its questions, the required ones first to answer.
/// Computed values (formulas, rollups, who and when) show as they read.
struct WikiRowSheet: View {
    let databaseID: String
    let schema: WikiDatabase
    let edit: WikiRowEdit
    var templates: [WikiNode] = []
    let onSaved: () -> Void

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var values: [String: JSONValue] = [:]
    @State private var changed: Set<String> = []
    @State private var template: String?
    @State private var saving = false
    @State private var error: String?
    @State private var started = false

    private var store: WikiStore { WikiStore.shared }
    private var row: WikiDbRow? { edit.row }

    /// A form's questions in order, with whether each must be answered and its hint.
    private var questions: [WikiFormQuestion] {
        guard let fields = edit.form?["fields"]?.array else {
            return schema.properties.filter { $0.type != "title" }.map { WikiFormQuestion(property: $0) }
        }
        return fields.compactMap { field in
            guard let property = schema.property(field["property"]?.string), property.stored else { return nil }
            return WikiFormQuestion(property: property, required: field["required"]?.bool ?? false, help: field["help"]?.string ?? "")
        }
    }

    private var missing: [WikiDbProperty] {
        questions.filter { $0.required && isBlank(values[$0.property.id]) }.map(\.property)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let error { Notice(text: error, tone: .red, symbol: "exclamationmark.triangle") }
                    if row == nil, edit.form == nil, !templates.isEmpty { templatePicker }
                    field(label: schema.properties.first { $0.type == "title" }?.name ?? "Name", help: "") {
                        TextField("Untitled", text: $title, axis: .vertical)
                            .font(ODFont.sans(17, weight: .semibold))
                            .foregroundStyle(Theme.fg)
                    }
                    ForEach(questions) { question in
                        field(label: question.property.name + (question.required ? " *" : ""), help: question.help) {
                            editor(question.property)
                        }
                    }
                }
                .padding(16)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Theme.canvas.ignoresSafeArea())
            .navigationTitle(row == nil ? (edit.form == nil ? "New row" : "Fill in the form") : "Edit row")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    SheetButton(row == nil && edit.form != nil ? .send : .confirm, row == nil ? (edit.form == nil ? "Add" : "Send") : "Save", busy: saving) { Task { await save() } }
                    .fontWeight(.semibold)
                    .disabled(saving || !missing.isEmpty || (row != nil && changed.isEmpty && title == row?.node.title))
                }
            }
        }
        .onAppear(perform: start)
    }

    private var templatePicker: some View {
        field(label: "Start from", help: "") {
            Menu {
                Button("A blank row") { template = nil }
                ForEach(templates) { node in
                    Button { template = node.id } label: { Text(node.displayTitle) }
                }
            } label: {
                HStack {
                    Text(template.flatMap { id in templates.first { $0.id == id }?.displayTitle } ?? "A blank row")
                        .font(ODFont.sans(15))
                        .foregroundStyle(Theme.fg)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundStyle(Theme.fg3)
                }
            }
        }
    }

    private func field(label: String, help: String, @ViewBuilder content: () -> some View) -> some View {
        let inner = content()
        return VStack(alignment: .leading, spacing: 6) {
            Text(label).font(ODFont.sans(12.5, weight: .medium)).foregroundStyle(Theme.fg3)
            Panel(padding: 12) { inner }
            if !help.isEmpty {
                Text(help).font(ODFont.footnote).foregroundStyle(Theme.fg3).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Editors

    @ViewBuilder
    private func editor(_ property: WikiDbProperty) -> some View {
        switch property.type {
        case "text", "url", "email", "phone":
            TextField(placeholder(property), text: stringBinding(property), axis: property.type == "text" ? .vertical : .horizontal)
                .font(ODFont.sans(15))
                .keyboardType(property.type == "url" ? .URL : property.type == "email" ? .emailAddress : property.type == "phone" ? .phonePad : .default)
                .textInputAutocapitalization(property.type == "text" ? .sentences : .never)
                .autocorrectionDisabled(property.type != "text")
        case "number":
            TextField("Empty", text: numberBinding(property))
                .font(ODFont.mono(15))
                .keyboardType(.decimalPad)
        case "checkbox":
            Toggle(isOn: Binding(get: { values[property.id]?.bool == true }, set: { set(property, .bool($0)) })) {
                Text(property.name).font(ODFont.sans(15)).foregroundStyle(Theme.fg)
            }
            .tint(Tone.green.solid)
        case "select", "status":
            optionPicker(property)
        case "multi_select":
            optionToggles(property, ids: property.options.map(\.id), title: { id in property.option(id)?.name ?? id }, tone: { id in property.option(id)?.tone ?? .gray })
        case "person":
            optionToggles(property, ids: env.directory.members.map(\.id), title: { id in env.directory.member(id)?.user.name ?? "Someone" }, tone: { _ in .gray })
        case "date":
            dateEditor(property)
        case "relation":
            WikiRelationPicker(property: property, selected: Binding(
                get: { values[property.id]?.array?.compactMap(\.string) ?? [] },
                set: { set(property, $0.isEmpty ? .null : .array($0.map(JSONValue.string))) }
            ))
        default:
            computed(property)
        }
    }

    private func placeholder(_ property: WikiDbProperty) -> String {
        switch property.type {
        case "url": "https://"
        case "email": "name@example.com"
        case "phone": "Phone number"
        default: "Empty"
        }
    }

    private func optionPicker(_ property: WikiDbProperty) -> some View {
        let current = property.option(values[property.id]?.string)
        return Menu {
            Button("None") { set(property, .null) }
            ForEach(property.options) { option in
                Button { set(property, .string(option.id)) } label: {
                    if option.id == current?.id { Label(option.name, systemImage: "checkmark") } else { Text(option.name) }
                }
            }
        } label: {
            HStack {
                if let current {
                    TonePill(text: current.name, tone: current.tone)
                } else {
                    Text("Empty").font(ODFont.sans(15)).foregroundStyle(Theme.fg4)
                }
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundStyle(Theme.fg3)
            }
            .contentShape(Rectangle())
        }
    }

    private func optionToggles(_ property: WikiDbProperty, ids: [String], title: @escaping (String) -> String, tone: @escaping (String) -> Tone) -> some View {
        let on = Set(values[property.id]?.array?.compactMap(\.string) ?? [])
        return WikiChipFlow(spacing: 6) {
            ForEach(ids, id: \.self) { id in
                let picked = on.contains(id)
                Button {
                    Haptics.selection()
                    var next = values[property.id]?.array?.compactMap(\.string) ?? []
                    if picked { next.removeAll { $0 == id } } else { next.append(id) }
                    set(property, next.isEmpty ? .null : .array(next.map(JSONValue.string)))
                } label: {
                    Label(title(id), systemImage: picked ? "checkmark" : "plus")
                }
                .buttonStyle(ChipButtonStyle(tone: picked ? Optional(tone(id) == .gray ? Tone.blue : tone(id)) : nil))
                .accessibilityAddTraits(picked ? .isSelected : [])
            }
        }
    }

    @ViewBuilder
    private func dateEditor(_ property: WikiDbProperty) -> some View {
        let time = property.dateTime == true
        let start = WikiDbValue.parse(values[property.id]?["start"]?.string ?? values[property.id]?.string)
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: Binding(get: { start != nil }, set: { on in
                set(property, on ? dateValue(Date(), time: time, keepingEndOf: property) : .null)
            })) {
                Text(start == nil ? "No date" : "Date").font(ODFont.sans(15)).foregroundStyle(Theme.fg)
            }
            .tint(Tone.green.solid)
            if let start {
                DatePicker("Date", selection: Binding(get: { start }, set: { set(property, dateValue($0, time: time, keepingEndOf: property)) }),
                           displayedComponents: time ? [.date, .hourAndMinute] : [.date])
                    .labelsHidden()
            }
        }
    }

    /// `{start, end?}`: a day, or a moment with a time; a range keeps its end.
    private func dateValue(_ date: Date, time: Bool, keepingEndOf property: WikiDbProperty) -> JSONValue {
        var object: [String: JSONValue] = ["start": .string(time ? WikiDbValue.stamp(date) : WikiDbValue.day(date))]
        if let end = values[property.id]?["end"], !end.isNull { object["end"] = end }
        return .object(object)
    }

    @ViewBuilder
    private func computed(_ property: WikiDbProperty) -> some View {
        if let row, let text = WikiDbValue.text(property, row, people: { env.directory.member($0)?.user.name }) {
            Text(text).font(ODFont.sans(15)).foregroundStyle(Theme.fg2)
        } else {
            Text(property.stored ? "Changed on the web." : "Filled in by the app.").font(ODFont.sans(14)).foregroundStyle(Theme.fg4)
        }
    }

    // MARK: Bindings

    private func stringBinding(_ property: WikiDbProperty) -> Binding<String> {
        Binding(get: { values[property.id]?.string ?? "" }, set: { set(property, $0.isEmpty ? .null : .string($0)) })
    }

    private func numberBinding(_ property: WikiDbProperty) -> Binding<String> {
        Binding(
            get: { values[property.id]?.double.map { $0.rounded() == $0 && abs($0) < 1e15 ? String(Int($0)) : String($0) } ?? "" },
            set: { text in
                let clean = text.replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespaces)
                if clean.isEmpty { set(property, .null) } else if let number = Double(clean) { set(property, .number(number)) }
            }
        )
    }

    private func set(_ property: WikiDbProperty, _ value: JSONValue) {
        values[property.id] = value
        changed.insert(property.id)
    }

    private func isBlank(_ value: JSONValue?) -> Bool {
        guard let value, !value.isNull else { return true }
        if let text = value.string { return text.trimmingCharacters(in: .whitespaces).isEmpty }
        if let list = value.array { return list.isEmpty }
        return false
    }

    // MARK: Saving

    private func start() {
        guard !started else { return }
        started = true
        title = row?.node.title ?? ""
        values = row?.props ?? edit.prefill
        if row == nil { changed = Set(edit.prefill.keys) }
    }

    private func save() async {
        if edit.form != nil, title.trimmingCharacters(in: .whitespaces).isEmpty {
            error = "Give it a name first."
            return
        }
        saving = true
        defer { saving = false }
        let props = values.filter { changed.contains($0.key) }
        do {
            if let row {
                if !props.isEmpty { _ = try await store.setLook(row.id, WikiLookPatch(props: props)) }
                if title != row.node.title {
                    _ = try await store.update(row.id, WikiPagePatch(title: String(title.prefix(WikiText.maxTitle)), version: row.node.version), workspaceID: nil)
                }
            } else if let template {
                let copy = try await store.duplicate(template, WikiDuplicate(parentID: databaseID, title: title, template: false))
                if !props.isEmpty { _ = try await store.setLook(copy.id, WikiLookPatch(props: props)) }
            } else {
                _ = try await store.addRow(to: databaseID, title: String(title.prefix(WikiText.maxTitle)), props: props.filter { !$0.value.isNull })
            }
            Haptics.success()
            if edit.form != nil {
                let thanks = edit.form?["submitted"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? "Thanks, your answers are in."
                env.toasts.show(thanks, kind: .success)
            }
            onSaved()
            dismiss()
        } catch {
            Haptics.error()
            self.error = error.userMessage
        }
    }
}

/// One question of a form view, or one property of the row.
struct WikiFormQuestion: Identifiable {
    let property: WikiDbProperty
    var required = false
    var help = ""
    var id: String { property.id }
}

/// Picks rows of a relation's database, by title.
struct WikiRelationPicker: View {
    let property: WikiDbProperty
    @Binding var selected: [String]

    @State private var rows: [WikiDbRow] = []
    @State private var loaded = false
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !loaded {
                ProgressView().frame(maxWidth: .infinity)
            } else if rows.isEmpty {
                Text("The related database has no rows you can see.").font(ODFont.sans(14)).foregroundStyle(Theme.fg4)
            } else {
                if rows.count > 8 { ODSearchLine(text: $query, prompt: "Search rows") }
                ForEach(rows.filter { query.isEmpty || $0.node.displayTitle.localizedCaseInsensitiveContains(query) }.prefix(40)) { row in
                    let on = selected.contains(row.id)
                    Button {
                        Haptics.selection()
                        if on { selected.removeAll { $0 == row.id } } else { selected.append(row.id) }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(on ? Tone.blue.solid : Theme.fg4)
                            WikiPageIcon(icon: row.node.icon, size: 14)
                            Text(row.node.displayTitle).font(ODFont.sans(14.5)).foregroundStyle(Theme.fg).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: 34)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
        .task {
            guard let database = property.databaseID else {
                loaded = true
                return
            }
            rows = (try? await WikiStore.shared.database(rows: database).data) ?? []
            loaded = true
        }
    }
}
