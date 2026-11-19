import SwiftUI

/// A page's comments (contracts/wiki.md "Comments"): its open threads, oldest first, each
/// with the text it was made on and its comments; resolved ones on request. Agents and
/// admins reply, resolve and reopen, and comment on the page from the field pinned under
/// the threads; comments on a run of the text are started on the web.
struct WikiCommentsSheet: View {
    let pageID: String
    @Binding var comments: WikiComments?
    /// A thread to scroll to and mark (the one a notification is about).
    var focus: String?
    let canWrite: Bool

    @Environment(AppEnvironment.self) private var env
    @Environment(\.dismiss) private var dismiss
    @State private var showResolved = false
    @State private var error: String?
    @State private var text = ""
    @State private var replyTo: WikiThread?
    @State private var sending = false
    @State private var busy: String?
    @FocusState private var focused: Bool

    private var store: WikiStore { WikiStore.shared }

    private var threads: [WikiThread] {
        let all = comments?.data ?? []
        return showResolved ? all : all.filter { !$0.resolved || $0.id == focus }
    }

    private var resolvedCount: Int { (comments?.data ?? []).filter(\.resolved).count }

    private var canSend: Bool { !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        NavigationStack {
            content
                .background(Theme.surface.ignoresSafeArea())
                .navigationTitle("Comments")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) { SheetButton(.confirm, "Done") { dismiss() } }
                }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if canWrite, comments != nil { composer }
                }
        }
        .onAppear { text = store.unsentComments[pageID] ?? "" }
        .onChange(of: text) { _, value in store.unsentComments[pageID] = value.isEmpty ? nil : value }
        .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        if comments == nil, let error {
            ErrorState(title: "Couldn't load the comments", message: error) { Task { await load() } }
                .frame(maxHeight: .infinity)
        } else if comments == nil {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if threads.isEmpty {
            ScrollView {
                EmptyState(
                    symbol: "text.bubble",
                    title: resolvedCount > 0 ? "No open comments" : "No comments yet",
                    message: canWrite
                        ? "Comment on this page to discuss it with your team. People who follow it hear about new comments."
                        : "Comments your team leaves on this page show up here.",
                    actionTitle: resolvedCount > 0 ? "Show \(Format.plural(resolvedCount, "resolved thread"))" : nil
                ) { withAnimation(Motion.snappy) { showResolved = true } }
                    .padding(.top, 40)
            }
            .refreshable { await load() }
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(threads) { thread in
                            card(thread).id(thread.id)
                        }
                        if resolvedCount > 0 {
                            Button(showResolved ? "Hide resolved threads" : "Show \(Format.plural(resolvedCount, "resolved thread"))") {
                                withAnimation(Motion.snappy) { showResolved.toggle() }
                            }
                            .font(ODFont.sans(13.5, weight: .medium))
                            .foregroundStyle(Theme.fg3)
                            .buttonStyle(.plain)
                            .frame(maxWidth: .infinity, minHeight: 44)
                        }
                    }
                    .padding(16)
                }
                .scrollDismissesKeyboard(.interactively)
                .refreshable { await load() }
                .onAppear {
                    guard let focus else { return }
                    Task {
                        try? await Task.sleep(for: .milliseconds(300))
                        withAnimation(Motion.snappy) { proxy.scrollTo(focus, anchor: .top) }
                    }
                }
            }
        }
    }

    private func card(_ thread: WikiThread) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if !thread.quote.isEmpty {
                Text(thread.quote)
                    .font(ODFont.sans(13))
                    .foregroundStyle(Theme.fg2)
                    .lineLimit(3)
                    .padding(.leading, 10)
                    .overlay(alignment: .leading) { Capsule().fill(Tone.amber.solid).frame(width: 3) }
                    .accessibilityLabel("On the text: \(thread.quote)")
            }
            ForEach(thread.comments) { comment in commentRow(comment) }
            HStack(spacing: 16) {
                if thread.resolved {
                    Label(thread.resolvedBy.map { "Resolved by \($0.displayName)" } ?? "Resolved", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(Tone.green.text)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if canWrite {
                    Button { startReply(thread) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                    Button { resolve(thread) } label: {
                        if busy == thread.id {
                            ProgressView().controlSize(.small)
                        } else {
                            Label(thread.resolved ? "Reopen" : "Resolve", systemImage: thread.resolved ? "arrow.uturn.backward.circle" : "checkmark.circle")
                        }
                    }
                    .disabled(busy != nil)
                }
            }
            .font(ODFont.sans(13, weight: .medium))
            .foregroundStyle(Theme.fg3)
            .buttonStyle(.plain)
            .frame(minHeight: 32)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(thread.id == focus ? Tone.amber.soft : Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.card, style: .continuous).strokeBorder(replyTo?.id == thread.id ? Tone.blue.line : Theme.line, lineWidth: 1))
        .opacity(thread.resolved ? 0.8 : 1)
    }

    private func commentRow(_ comment: WikiComment) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Avatar(name: comment.author?.displayName ?? "A former teammate", url: comment.author?.avatarURL, seed: comment.author?.id ?? comment.id, size: 26)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(comment.author?.displayName ?? "A former teammate")
                        .font(ODFont.sans(13.5, weight: .semibold))
                        .foregroundStyle(Theme.fg)
                        .lineLimit(1)
                    Text(Format.relShort(comment.createdAt)).font(ODFont.sans(12)).foregroundStyle(Theme.fg3)
                    if comment.editedAt != nil { Text("edited").font(ODFont.sans(11.5)).foregroundStyle(Theme.fg4) }
                }
                Text(HTMLText.plain(from: comment.bodyHTML).trimmingCharacters(in: .whitespacesAndNewlines))
                    .font(ODFont.sans(14))
                    .foregroundStyle(Theme.fg)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    /// Pinned under the threads: a comment on the page, or a reply in the thread picked.
    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let replyTo {
                HStack(spacing: 6) {
                    Image(systemName: "arrowshape.turn.up.left").font(.system(size: 11, weight: .bold))
                    Text("Replying to \(replyTo.comments.first?.author?.displayName ?? "the thread")")
                        .font(ODFont.sans(12.5, weight: .medium))
                        .lineLimit(1)
                    Spacer()
                    Button("Cancel") { self.replyTo = nil }
                        .font(ODFont.sans(12.5, weight: .semibold))
                        .buttonStyle(.plain)
                }
                .foregroundStyle(Theme.fg3)
                .padding(.horizontal, 8)
            }
            HStack(alignment: .bottom, spacing: 6) {
                TextField(text: $text, axis: .vertical) {
                    Text(replyTo == nil ? "Comment on this page" : "Reply").foregroundStyle(Theme.fg4)
                }
                .font(ODFont.sans(15))
                .foregroundStyle(Theme.fg)
                .lineLimit(1...6)
                .focused($focused)
                .padding(.vertical, 9)
                Button { Task { await send() } } label: {
                    Group {
                        if sending {
                            ProgressView().controlSize(.small).tint(Theme.inverseFg)
                        } else {
                            Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
                        }
                    }
                    .foregroundStyle(Theme.inverseFg)
                    .frame(width: 32, height: 32)
                    .background(canSend ? Theme.inverse : Theme.fg4, in: Circle())
                }
                .buttonStyle(TapScaleStyle(scale: 0.9))
                .disabled(!canSend)
                .padding(.bottom, 3)
                .accessibilityLabel(replyTo == nil ? "Comment" : "Reply")
            }
            .padding(.leading, 14)
            .padding(.trailing, 4)
            .frame(minHeight: 44)
            .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .motion(Motion.snappy, value: replyTo?.id)
    }

    // MARK: Actions

    private func load() async {
        do {
            comments = try await store.comments(pageID)
            error = nil
        } catch {
            guard !error.isCancellation else { return }
            self.error = error.userMessage
        }
    }

    private func startReply(_ thread: WikiThread) {
        Haptics.selection()
        replyTo = thread
        focused = true
    }

    private func send() async {
        guard canSend else { return }
        sending = true
        defer { sending = false }
        do {
            let thread = try await store.comment(on: pageID, bodyHTML: HTMLText.html(fromPlain: text), thread: replyTo?.id)
            Haptics.success()
            text = ""
            replyTo = nil
            focused = false
            put(thread)
        } catch {
            env.toasts.error(error)
        }
    }

    private func resolve(_ thread: WikiThread) {
        busy = thread.id
        Task {
            defer { busy = nil }
            do {
                let updated = try await store.resolve(thread: thread.id, !thread.resolved)
                Haptics.success()
                put(updated)
            } catch {
                env.toasts.error(error)
            }
        }
    }

    /// Takes a thread as the server answered it: in place, or last.
    private func put(_ thread: WikiThread) {
        guard var current = comments else { return }
        if let index = current.data.firstIndex(where: { $0.id == thread.id }) {
            current.data[index] = thread
        } else {
            current.data.append(thread)
        }
        withAnimation(Motion.snappy) { comments = current }
    }
}
