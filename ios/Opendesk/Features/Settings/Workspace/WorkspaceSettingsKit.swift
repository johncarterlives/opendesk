import SwiftUI

// Pieces the Workspace settings pages share: colour swatches, a menu row, a searchable time
// zone list, meters and the summary strip.

/// The label colours as a wrap of round swatches, the chosen one ringed.
struct WSColorSwatches: View {
    @Binding var value: String
    var disabled = false

    private let columns = [GridItem(.adaptive(minimum: 34, maximum: 40), spacing: 8)]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 8) {
            ForEach(WSColors.all, id: \.self) { name in
                let chosen = value == name
                Button {
                    guard !disabled else { return }
                    Haptics.selection()
                    value = name
                } label: {
                    Circle()
                        .fill(Tone(label: name).solid)
                        .frame(width: 24, height: 24)
                        .overlay {
                            if chosen {
                                Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(.white)
                            }
                        }
                        .padding(4)
                        .overlay(Circle().strokeBorder(chosen ? Tone(label: name).solid : Color.clear, lineWidth: 2))
                        .frame(width: 34, height: 34)
                        .contentShape(Circle())
                }
                .buttonStyle(TapScaleStyle(scale: 0.9))
                .accessibilityLabel(name.capitalized)
                .accessibilityAddTraits(chosen ? .isSelected : [])
            }
        }
        .opacity(disabled ? 0.5 : 1)
        .motion(Motion.snappy, value: value)
    }
}

/// A row whose value opens a menu of choices.
struct WSMenuRow<Value: Hashable>: View {
    var symbol: String?
    var tone: Tone = .gray
    let title: String
    var subtitle: String?
    let options: [Value]
    @Binding var selection: Value
    let label: (Value) -> String
    var disabled = false

    var body: some View {
        Menu {
            Picker(title, selection: $selection) {
                ForEach(options, id: \.self) { option in
                    Text(label(option)).tag(option)
                }
            }
        } label: {
            AccountRow(symbol: symbol, tone: tone, title: title, subtitle: subtitle) {
                HStack(spacing: 6) {
                    Text(label(selection))
                        .font(ODFont.sans(14.5))
                        .foregroundStyle(Theme.fg3)
                        .lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Theme.fg4)
                }
            }
        }
        .buttonStyle(RowPressStyle())
        .disabled(disabled)
        .opacity(disabled ? 0.55 : 1)
    }
}

/// A row with a short field on the right.
struct WSFieldRow: View {
    var symbol: String?
    var tone: Tone = .gray
    let title: String
    var subtitle: String?
    @Binding var text: String
    var prompt = ""
    var mono = false
    var invalid = false
    var disabled = false

    var body: some View {
        AccountRow(symbol: symbol, tone: tone, title: title, subtitle: subtitle) {
            TextField(text: $text) { Text(prompt).foregroundStyle(Theme.fg4) }
                .font(mono ? ODFont.mono(14) : ODFont.sans(15))
                .foregroundStyle(invalid ? Tone.red.text : Theme.fg2)
                .multilineTextAlignment(.trailing)
                .textInputAutocapitalization(mono ? .never : .sentences)
                .autocorrectionDisabled(mono)
                .frame(maxWidth: 180)
                .disabled(disabled)
        }
    }
}

/// A full-width text field inside a panel, under its label.
struct WSPanelField: View {
    let label: String
    @Binding var text: String
    var prompt = ""
    var axis: Axis = .horizontal
    var mono = false
    var disabled = false
    var counter: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(label).font(ODFont.sans(13, weight: .medium)).foregroundStyle(Theme.fg2)
                Spacer()
                if let counter {
                    Text("\(text.count) / \(counter)")
                        .font(ODFont.mono(11))
                        .foregroundStyle(text.count > counter ? Tone.red.text : Theme.fg4)
                }
            }
            TextField(text: $text, axis: axis) { Text(prompt).foregroundStyle(Theme.fg4) }
                .font(mono ? ODFont.mono(14) : ODFont.sans(15.5))
                .foregroundStyle(Theme.fg)
                .lineLimit(axis == .vertical ? 3 ... 10 : 1 ... 1)
                .textInputAutocapitalization(mono ? .never : .sentences)
                .autocorrectionDisabled(mono)
                .disabled(disabled)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }
}

/// The IANA time zones, searchable.
struct WSTimeZonePicker: View {
    let title: String
    let selection: String
    let pick: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var zones: [String] {
        let all = TimeZone.knownTimeZoneIdentifiers
        let text = query.trimmingCharacters(in: .whitespaces).lowercased().replacingOccurrences(of: " ", with: "_")
        guard !text.isEmpty else { return ["UTC"] + all.filter { $0 != "UTC" } }
        return (["UTC"] + all.filter { $0 != "UTC" }).filter { $0.lowercased().contains(text) }
    }

    var body: some View {
        NavigationStack {
            List(zones, id: \.self) { zone in
                Button {
                    Haptics.selection()
                    pick(zone)
                    dismiss()
                } label: {
                    HStack {
                        Text(zone.replacingOccurrences(of: "_", with: " "))
                            .font(ODFont.sans(15.5))
                            .foregroundStyle(Theme.fg)
                        Spacer()
                        if zone == selection {
                            Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.fg)
                        }
                    }
                }
                .listRowBackground(Theme.surface)
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Theme.chrome)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search time zones")
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { SheetButton(.cancel, "Cancel") { dismiss() } }
            }
        }
    }
}

/// A thin bar of `value` out of `max`, amber near the end and red past it.
struct WSMeter: View {
    let value: Double
    let max: Double
    var tone: Tone = .blue

    private var ratio: Double { max > 0 ? Swift.min(1, value / max) : 0 }
    private var fill: Color {
        if max > 0, value > max { return Tone.red.solid }
        if ratio >= 0.9 { return Tone.amber.solid }
        return tone.solid
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.active)
                Capsule().fill(fill).frame(width: Swift.max(ratio > 0 ? 4 : 0, proxy.size.width * ratio))
            }
        }
        .frame(height: 6)
        .accessibilityValue("\(Int((ratio * 100).rounded())) percent")
    }
}

/// Numbers in a row over the page, like the web's summary strip.
struct WSSummaryStrip: View {
    struct Item: Identifiable {
        var label: String
        var value: String
        var tone: Tone?
        var hint: String?
        var id: String { label }
    }

    let items: [Item]

    var body: some View {
        // Shares the width out when every number fits, and scrolls only when they don't.
        ViewThatFits(in: .horizontal) {
            row(fill: true)
            ScrollView(.horizontal, showsIndicators: false) { row(fill: false) }
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
    }
}

extension WSSummaryStrip {
    fileprivate func row(fill: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) {
                        if let tone = item.tone { Circle().fill(tone.solid).frame(width: 6, height: 6) }
                        Text(item.label)
                            .font(ODFont.sans(11.5, weight: .medium))
                            .foregroundStyle(Theme.fg3)
                            .lineLimit(1)
                    }
                    Text(item.value)
                        .font(ODFont.sans(19, weight: .semibold))
                        .foregroundStyle(Theme.fg)
                        .monospacedDigit()
                    if let hint = item.hint {
                        Text(hint).font(ODFont.sans(11)).foregroundStyle(Theme.fg4).lineLimit(1)
                    }
                }
                .fixedSize()
                .padding(.horizontal, fill ? 7 : 14)
                .padding(.vertical, 11)
                .frame(maxWidth: fill ? .infinity : nil, alignment: .leading)
                if index < items.count - 1 {
                    Rectangle().fill(Theme.lineSoft).frame(width: 1).padding(.vertical, 10)
                }
            }
        }
    }
}

/// A soft rounded tile with a dot in a team's colour.
struct WSTeamTile: View {
    let color: String
    var size: CGFloat = 30

    var body: some View {
        let tone = Tone(label: color)
        RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(tone.soft)
            .overlay(Circle().fill(tone.solid).frame(width: size * 0.3, height: size * 0.3))
            .overlay(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).strokeBorder(tone.line, lineWidth: 0.5))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The page while its first load runs.
struct WSLoading: View {
    var rows = 4

    var body: some View {
        VStack(spacing: 24) {
            Panel { SkeletonRows(count: rows) }
            Panel { SkeletonRows(count: 2) }
        }
    }
}

/// `PUT` multipart image uploads (the workspace's logo and pictures).
enum WSUpload {
    static func image(_ data: Data, path: String) -> APIRequest {
        let boundary = "od-" + UUID().uuidString
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"image.jpg\"\r\n".utf8))
        body.append(Data("Content-Type: image/jpeg\r\n\r\n".utf8))
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = APIRequest(method: "PUT", path: path, body: body, contentType: "multipart/form-data; boundary=\(boundary)")
        request.timeout = 120
        return request
    }
}

extension Error {
    /// The server refuses the change until the person signs in again (and enters a code).
    var wsNeedsReauth: Bool {
        guard let failure = self as? APIError else { return false }
        return ["reauth_required", "mfa_required"].contains(failure.code ?? "")
    }

    var wsNeedsMFA: Bool { (self as? APIError)?.code == "mfa_required" }
}

/// `one` for a single thing, `many` otherwise, each written in full ("1 member", "3 members").
func wsPlural(_ count: Int, _ one: String, _ many: String) -> String {
    count == 1 ? one : many
}
