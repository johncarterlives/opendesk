import SwiftUI

enum AppTab: String, Hashable, CaseIterable {
    case inbox, notifications, account
}

/// Screens that need the whole height hide the tab bar through this, keyed
/// per screen so one can't unhide another's.
@MainActor
@Observable
final class TabBarState {
    private(set) var hiddenBy: Set<String> = []
    private(set) var keyboardVisible = false

    var isHidden: Bool { !hiddenBy.isEmpty || keyboardVisible }

    func set(_ hidden: Bool, by key: String) {
        if hidden { hiddenBy.insert(key) } else { hiddenBy.remove(key) }
    }

    func setKeyboard(_ visible: Bool) { keyboardVisible = visible }
}

private struct TabBarHiddenModifier: ViewModifier {
    @Environment(TabBarState.self) private var state: TabBarState?
    /// Beside a list the tab bar is under the list, out of this screen's way.
    @Environment(\.inDetailColumn) private var inDetailColumn
    let hidden: Bool
    @State private var key = UUID().uuidString

    func body(content: Content) -> some View {
        content
            .onAppear { apply(hidden) }
            .onChange(of: hidden) { _, value in apply(value) }
            .onChange(of: inDetailColumn) { apply(hidden) }
            .onDisappear { apply(false) }
    }

    private func apply(_ value: Bool) {
        withAnimation(Motion.snappy) { state?.set(value && !inDetailColumn, by: key) }
    }
}

extension View {
    /// Hides the app's tab bar while `hidden` is true and this view is on screen.
    func tabBarHidden(_ hidden: Bool = true) -> some View {
        modifier(TabBarHiddenModifier(hidden: hidden))
    }
}

struct TabItem: Identifiable {
    let tab: AppTab
    let title: String
    let symbol: String
    var badge = 0
    var id: AppTab { tab }
}

/// The app's own tab bar on Liquid Glass: a compact capsule floating off the
/// bottom edge, icon-only and monochrome, the active tab on a soft tile that
/// slides between items, and Ollie's round button beside it. Standing up
/// (`.vertical`) it runs down a side column instead, Ollie's button under it.
struct ODTabBar: View {
    /// The room the bar takes above the bottom safe area, for a column it floats over.
    static let height: CGFloat = 60

    var axis: Axis = .horizontal
    let items: [TabItem]
    @Binding var selection: AppTab
    var ollie: (() -> Void)?
    var onReselect: (AppTab) -> Void = { _ in }
    /// What a long press on a tab opens (the account switcher on Account).
    var onLongPress: [AppTab: () -> Void] = [:]

    /// A long press just fired, so the tap that ends it doesn't also select the tab.
    @State private var longPressedAt: Date?
    @Namespace private var activeNS
    @Namespace private var glassNS
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let outer = stack(spacing: 10), tabs = stack(spacing: 2)
        GlassEffectContainer(spacing: 14) {
            outer {
                tabs {
                    ForEach(items) { item in button(item) }
                }
                .padding(5)
                .glassEffect(.regular.tint(Theme.glassTint).interactive(), in: Capsule())
                .glassEffectID("bar", in: glassNS)

                if let ollie {
                    Button(action: ollie) {
                        OllieMark(size: 28)
                            .frame(width: 56, height: 56)
                            .contentShape(Circle())
                    }
                    .buttonStyle(TapScaleStyle(scale: 0.9))
                    .glassEffect(.regular.tint(Theme.glassTint).interactive(), in: Circle())
                    .glassEffectID("ollie", in: glassNS)
                    .accessibilityLabel("Ask Ollie")
                }
            }
        }
        .padding(.horizontal, vertical ? 0 : 18)
        .padding(.bottom, 4)
        .sensoryFeedback(.selection, trigger: selection)
    }

    private var vertical: Bool { axis == .vertical }

    private func stack(spacing: CGFloat) -> AnyLayout {
        vertical ? AnyLayout(VStackLayout(spacing: spacing)) : AnyLayout(HStackLayout(spacing: spacing))
    }

    private func button(_ item: TabItem) -> some View {
        let selected = item.tab == selection
        let longPress = onLongPress[item.tab]
        return Button {
            if let at = longPressedAt, Date.now.timeIntervalSince(at) < 1 {
                longPressedAt = nil
                return
            }
            if selected {
                onReselect(item.tab)
            } else {
                withAnimation(reduceMotion ? nil : Motion.snappy) { selection = item.tab }
            }
        } label: {
            Image(systemName: selected ? "\(item.symbol).fill" : item.symbol)
                .font(.system(size: 18, weight: selected ? .medium : .regular))
                .foregroundStyle(selected ? Theme.fg : Theme.fg3)
                .contentTransition(.symbolEffect(.replace))
                .frame(maxWidth: vertical ? 46 : .infinity)
                .frame(height: vertical ? 54 : 46)
                .background {
                    if selected {
                        Capsule().fill(Theme.fg.opacity(0.08)).matchedGeometryEffect(id: "active", in: activeNS)
                    }
                }
                .overlay(alignment: .top) { badge(item.badge) }
                .contentShape(Capsule())
        }
        .buttonStyle(TapScaleStyle(scale: 0.92))
        .simultaneousGesture(
            LongPressGesture(minimumDuration: 0.45).onEnded { _ in
                longPressedAt = .now
                Haptics.tap()
                longPress?()
            },
            including: longPress == nil ? .subviews : .all
        )
        .frame(width: vertical ? 46 : 74)
        .accessibilityLabel(item.title)
        .accessibilityValue(item.badge > 0 ? "\(item.badge) unread" : "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder
    private func badge(_ count: Int) -> some View {
        if count > 0 {
            Text(count > 99 ? "99+" : "\(count)")
                .font(ODFont.mono(9.5, weight: .medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 4.5)
                .frame(minWidth: 16, minHeight: 16)
                .background(Tone.blue.solid, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.surface, lineWidth: 1.5))
                .offset(x: 13, y: 4)
                .contentTransition(.numericText())
                .transition(.scale.combined(with: .opacity))
        }
    }
}
