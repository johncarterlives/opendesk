import SwiftUI

/// The header every list screen shares: a glass menu button, the scope as a
/// title with one line under it, and a search button that morphs into the
/// field. `trailing` holds the screen's own glass buttons. Beside a side column
/// (`SideColumn`) the buttons stand in it and the title has the row.
struct GlassHeaderBar<Trailing: View>: View {
    let title: String
    var subtitle: Text?
    @Binding var query: String
    var searchPrompt: String
    var searchFocused: FocusState<Bool>.Binding
    var menuSymbol = "line.3.horizontal"
    var menuLabel = "Open menu"
    var searchable = true
    let onMenu: (() -> Void)?
    @ViewBuilder var trailing: () -> Trailing

    @State private var searchOpen = false
    @Namespace private var glass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.sideColumn) private var column

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                if searchOpen {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(Theme.fg2)
                        TextField(text: $query) {
                            Text(searchPrompt).foregroundStyle(Theme.fg4)
                        }
                        .font(ODFont.sans(16))
                        .foregroundStyle(Theme.fg)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .focused(searchFocused)
                        if !query.isEmpty {
                            Button {
                                query = ""
                            } label: {
                                Image(systemName: "xmark.circle.fill").font(.system(size: 16)).foregroundStyle(Theme.fg4)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Clear search")
                        }
                    }
                    .padding(.horizontal, 15)
                    .frame(height: 44)
                    .glassEffect(.regular.interactive(), in: Capsule())
                    .glassEffectID("search", in: glass)

                    GlassCircleButton(symbol: "xmark", label: "Close search") { close() }
                        .glassEffectID("menu", in: glass)
                } else {
                    if column == nil { menuButton }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(title)
                            .font(ODFont.sans(19, weight: .semibold))
                            .tracking(-0.4)
                            .foregroundStyle(Theme.fg)
                            .lineLimit(1)
                            .contentTransition(.opacity)
                        if let subtitle {
                            subtitle
                                .font(ODFont.sans(13))
                                .foregroundStyle(Theme.fg3)
                                .monospacedDigit()
                                .lineLimit(1)
                                .contentTransition(.numericText())
                        }
                    }
                    .padding(.leading, onMenu == nil || column != nil ? 4 : 2)

                    Spacer(minLength: 6)
                    if column == nil {
                        searchButton
                        trailing()
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .sideColumnActions {
            if !searchOpen {
                menuButton
                searchButton
                trailing()
            }
        }
        .onAppear {
            if !query.isEmpty { searchOpen = true }
        }
    }

    @ViewBuilder private var menuButton: some View {
        if let onMenu {
            GlassCircleButton(symbol: menuSymbol, label: menuLabel, action: onMenu)
                .glassEffectID("menu", in: glass)
        }
    }

    @ViewBuilder private var searchButton: some View {
        if searchable {
            GlassCircleButton(symbol: "magnifyingglass", label: "Search") { open() }
                .glassEffectID("search", in: glass)
        }
    }

    private var spring: Animation? { reduceMotion ? nil : Motion.smooth }

    private func open() {
        withAnimation(spring) { searchOpen = true }
        Task {
            try? await Task.sleep(for: .milliseconds(120))
            searchFocused.wrappedValue = true
        }
    }

    private func close() {
        query = ""
        searchFocused.wrappedValue = false
        withAnimation(spring) { searchOpen = false }
    }
}

extension GlassHeaderBar where Trailing == EmptyView {
    init(
        title: String,
        subtitle: Text? = nil,
        query: Binding<String>,
        searchPrompt: String,
        searchFocused: FocusState<Bool>.Binding,
        searchable: Bool = true,
        onMenu: (() -> Void)?
    ) {
        self.init(title: title, subtitle: subtitle, query: query, searchPrompt: searchPrompt, searchFocused: searchFocused, searchable: searchable, onMenu: onMenu, trailing: { EmptyView() })
    }
}

/// A plain title header for screens without search (account, settings pages).
struct TitleHeader<Trailing: View>: View {
    let title: String
    var subtitle: String?
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(ODFont.sans(26, weight: .semibold))
                    .tracking(-0.6)
                    .foregroundStyle(Theme.fg)
                if let subtitle {
                    Text(subtitle).font(ODFont.subheadline).foregroundStyle(Theme.fg3)
                }
            }
            Spacer()
            trailing()
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 6)
    }
}

extension TitleHeader where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil) {
        self.init(title: title, subtitle: subtitle, trailing: { EmptyView() })
    }
}
