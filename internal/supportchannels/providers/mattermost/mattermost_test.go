package mattermost

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/useopendesk/opendesk/internal/supportchannels/channel"
)

// fake is the part of Mattermost the adapter talks to.
type fake struct {
	t     *testing.T
	mu    sync.Mutex
	calls []string
	posts []map[string]any
	// events are sent over the websocket once it is open.
	events []string
	// socketStatus, when set, answers the websocket upgrade with it instead.
	socketStatus int
}

func (f *fake) log(s string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, s)
}

func (f *fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer bot-token" {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, `{"id":"api.context.session_expired.app_error"}`)
		return
	}
	body, _ := io.ReadAll(r.Body)
	f.log(r.Method + " " + r.URL.Path)
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.URL.Path == "/api/v4/websocket":
		f.socket(w, r)
	case r.URL.Path == "/api/v4/users/me":
		_, _ = io.WriteString(w, `{"id":"bot1","username":"opendesk","is_bot":true}`)
	case r.URL.Path == "/api/v4/teams/team1":
		_, _ = io.WriteString(w, `{"id":"team1","display_name":"Margin","name":"margin"}`)
	case r.URL.Path == "/api/v4/users/me/teams":
		_, _ = io.WriteString(w, `[{"id":"team1","display_name":"Margin"},{"id":"team2","name":"other"}]`)
	case r.URL.Path == "/api/v4/users/me/teams/team1/channels":
		_, _ = io.WriteString(w, `[{"id":"c1","display_name":"Support","type":"O"},{"id":"c2","display_name":"Secret","type":"P"},{"id":"c3","type":"D"},{"id":"c4","display_name":"Old","type":"O","delete_at":5}]`)
	case r.URL.Path == "/api/v4/teams/team1/members/bot1":
		_, _ = io.WriteString(w, `{}`)
	case r.URL.Path == "/api/v4/posts" && r.Method == http.MethodPost, r.URL.Path == "/api/v4/posts/ephemeral":
		var p map[string]any
		_ = json.Unmarshal(body, &p)
		f.mu.Lock()
		f.posts = append(f.posts, p)
		f.mu.Unlock()
		_, _ = io.WriteString(w, `{"id":"post`+string(rune('0'+len(f.posts)))+`"}`)
	case strings.HasPrefix(r.URL.Path, "/api/v4/posts/") && (r.Method == http.MethodPut || r.Method == http.MethodDelete):
		var p map[string]any
		_ = json.Unmarshal(body, &p)
		f.mu.Lock()
		f.posts = append(f.posts, p)
		f.mu.Unlock()
		_, _ = io.WriteString(w, `{}`)
	case strings.HasPrefix(r.URL.Path, "/api/v4/files/") && strings.HasSuffix(r.URL.Path, "/info"):
		_, _ = io.WriteString(w, `{"id":"f1","name":"screen.png","mime_type":"image/png","size":2048}`)
	case r.URL.Path == "/api/v4/files/f1":
		_, _ = io.WriteString(w, "PNGDATA")
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fake) socket(w http.ResponseWriter, r *http.Request) {
	if f.socketStatus != 0 {
		w.WriteHeader(f.socketStatus)
		return
	}
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ctx := r.Context()
	_ = ws.Write(ctx, websocket.MessageText, []byte(`{"event":"hello","data":{"server_version":"9"}}`))
	for _, e := range f.events {
		_ = ws.Write(ctx, websocket.MessageText, []byte(e))
	}
	// Hold the connection until the client goes.
	_, _, _ = ws.Read(ctx)
}

func creds(url string) map[string]string {
	return map[string]string{"server_url": url, "bot_token": "bot-token", "team_id": "team1", "webhook_token": "btn-secret", "webhook_url": "https://api.test/v1/hooks/1", "channel_id": "c1"}
}

func setup(t *testing.T) (*Adapter, *fake, map[string]string) {
	t.Helper()
	f := &fake{t: t}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return New(true), f, creds(srv.URL)
}

func postedEvent(post, mentions, channelType string) string {
	b, _ := json.Marshal(map[string]any{"event": "posted", "data": map[string]any{"post": post, "mentions": mentions, "team_id": "team1", "channel_type": channelType}, "broadcast": map[string]any{"channel_id": "c1"}})
	return string(b)
}

func TestValidateAndDiscover(t *testing.T) {
	a, _, cr := setup(t)
	ctx := context.Background()
	acc, err := a.Validate(ctx, http.DefaultClient, cr)
	if err != nil || acc.ID != "team1" || acc.Name != "Margin" {
		t.Fatalf("%+v %v", acc, err)
	}
	for name, mutate := range map[string]func(map[string]string){
		"no team":     func(c map[string]string) { delete(c, "team_id") },
		"wrong token": func(c map[string]string) { c["bot_token"] = "nope" },
		"https only":  func(c map[string]string) { c["server_url"] = "http://chat.example.com" },
	} {
		bad := map[string]string{}
		for k, v := range cr {
			bad[k] = v
		}
		mutate(bad)
		if _, err := a.Validate(ctx, http.DefaultClient, bad); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	teams, err := a.DiscoverAccounts(ctx, http.DefaultClient, cr)
	if err != nil || len(teams) != 2 || teams[1].Name != "other" {
		t.Fatalf("%+v %v", teams, err)
	}
	dest, err := a.Discover(ctx, http.DefaultClient, cr)
	if err != nil || len(dest) != 2 || dest[0] != (channel.Destination{ID: "c1", Name: "Support", Kind: "channel", Available: true}) || dest[1].Kind != "private" {
		t.Fatalf("%+v %v", dest, err)
	}
	h, err := a.Health(ctx, http.DefaultClient, cr, channel.Setup{})
	if err != nil || h.Status != "healthy" {
		t.Fatalf("%+v %v", h, err)
	}
}

func TestProductionRefusesPrivateServers(t *testing.T) {
	a := New(false)
	for _, u := range []string{"http://chat.example.com", "https://127.0.0.1", "https://10.0.0.5"} {
		if _, err := a.Validate(context.Background(), http.DefaultClient, creds(u)); err == nil {
			t.Errorf("%s was accepted", u)
		}
	}
}

func TestNonBotTokenRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"id":"u1","username":"ann","is_bot":false}`)
	}))
	defer srv.Close()
	cr := creds(srv.URL)
	if _, err := New(true).Validate(context.Background(), http.DefaultClient, cr); err == nil || !strings.Contains(err.Error(), "bot account") {
		t.Fatalf("a person's token: %v", err)
	}
}

func TestThreadCardsAndPosts(t *testing.T) {
	a, f, cr := setup(t)
	ctx := context.Background()
	th, err := a.CreateThread(ctx, http.DefaultClient, cr, "c1", channel.Ticket{Number: 42, Subject: "Where is my @here order?", Customer: "Ada @all", Assignee: "Unassigned", Status: "on_hold", Priority: "high", URL: "https://app.test/inbox/all/1"})
	if err != nil || th.ID != "post1" || th.RootID != "post1" || th.ChannelID != "c1" {
		t.Fatalf("%+v %v", th, err)
	}
	card := f.posts[0]
	if card["channel_id"] != "c1" || strings.Contains(card["message"].(string), "@here") || !strings.Contains(card["message"].(string), "#42") {
		t.Fatalf("post %v", card)
	}
	att := card["props"].(map[string]any)["attachments"].([]any)[0].(map[string]any)
	actions := att["actions"].([]any)
	if len(actions) != 3 || att["title_link"] != "https://app.test/inbox/all/1" {
		t.Fatalf("card %v", att)
	}
	first := actions[0].(map[string]any)["integration"].(map[string]any)
	ctxMap := first["context"].(map[string]any)
	if first["url"] != "https://api.test/v1/hooks/1" || ctxMap["action"] != "assign_self" || ctxMap["token"] != "btn-secret" {
		t.Fatalf("integration %v", first)
	}
	if strings.Contains(string(mustJSON(att["fields"])), "@all") {
		t.Fatalf("a broadcast mention reached the card: %v", att["fields"])
	}
	if err := a.Post(ctx, http.DefaultClient, cr, "post1", "hello @channel and ada@example.com"); err != nil {
		t.Fatal(err)
	}
	p := f.posts[1]
	if p["root_id"] != "post1" || strings.Contains(p["message"].(string), "@channel") || !strings.Contains(p["message"].(string), "ada@example.com") {
		t.Fatalf("post %v", p)
	}
	ref, err := a.PostInteractive(ctx, http.DefaultClient, cr, "post1", channel.Message{Text: "Send this?", Actions: []channel.Action{{Command: "confirm", Value: "n1", Label: "Send", Style: "primary"}, {Command: "cancel", Value: "n1", Label: "Cancel"}}})
	if err != nil || ref.ID == "" {
		t.Fatalf("%+v %v", ref, err)
	}
	btn := f.posts[2]["props"].(map[string]any)["attachments"].([]any)[0].(map[string]any)["actions"].([]any)[0].(map[string]any)
	c2 := btn["integration"].(map[string]any)["context"].(map[string]any)
	if c2["action"] != "confirm" || c2["value"] != "n1" || c2["thread"] != "post1" {
		t.Fatalf("button %v", btn)
	}
	if err := a.ClearActions(ctx, http.DefaultClient, cr, channel.Inbound{SourceMessageID: "post3"}); err != nil {
		t.Fatal(err)
	}
	if err := a.Respond(ctx, http.DefaultClient, cr, "u9/c1/post1", "Not allowed"); err != nil {
		t.Fatal(err)
	}
	if last := f.posts[len(f.posts)-1]; last["user_id"] != "u9" || last["post"].(map[string]any)["message"] != "Not allowed" {
		t.Fatalf("ephemeral %v", last)
	}
	if err := a.Respond(ctx, http.DefaultClient, cr, "bad", "x"); err != nil {
		t.Fatalf("a malformed handle is dropped: %v", err)
	}
	if err := a.DeleteRich(ctx, http.DefaultClient, cr, "post1", "post2"); err != nil {
		t.Fatal(err)
	}
	body, err := a.DownloadAttachment(ctx, http.DefaultClient, cr, channel.Attachment{ID: "f1"})
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := io.ReadAll(body); string(b) != "PNGDATA" {
		t.Fatalf("file %q", b)
	}
	if _, err := a.DownloadAttachment(ctx, http.DefaultClient, cr, channel.Attachment{ID: "../x"}); err == nil {
		t.Fatal("a path in a file id was followed")
	}
}

func TestButtonsAreVerifiedAndParsed(t *testing.T) {
	a := New(true)
	cr := map[string]string{"webhook_token": "btn-secret"}
	good := `{"user_id":"u1","channel_id":"c1","team_id":"team1","post_id":"p9","trigger_id":"t1","context":{"action":"status","token":"btn-secret","selected_option":"solved"}}`
	if err := a.Verify(nil, []byte(good), cr); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`{"context":{"token":"other"}}`, `{"context":{}}`, `{}`, `nope`} {
		if err := a.Verify(nil, []byte(bad), cr); err == nil {
			t.Errorf("%s verified", bad)
		}
	}
	if a.Verify(nil, []byte(`{"context":{"token":""}}`), map[string]string{}) == nil {
		t.Fatal("an empty token verified against an empty secret")
	}
	res, err := a.Parse(nil, []byte(good))
	if err != nil || !res.Control || len(res.Events) != 1 {
		t.Fatalf("%+v %v", res, err)
	}
	in := res.Events[0]
	if in.Command != "status" || in.Value != "solved" || in.ExternalThreadID != "p9" || in.SourceMessageID != "p9" || in.ExternalUserID != "u1" || in.AccountID != "team1" || in.Respond != "u1/c1/p9" || !in.Directed {
		t.Fatalf("%+v", in)
	}
	res, _ = a.Parse(nil, []byte(`{"user_id":"u1","post_id":"p9","context":{"action":"confirm","value":"n1","thread":"p1"}}`))
	if res.Events[0].Text != "confirm" || res.Events[0].Value != "n1" || res.Events[0].ExternalThreadID != "p1" {
		t.Fatalf("%+v", res.Events)
	}
	res, _ = a.Parse(nil, []byte(`{"user_id":"u1","post_id":"p9","context":{"action":"rm -rf"}}`))
	if len(res.Events) != 0 || res.Status != 200 {
		t.Fatalf("an unknown action became an event: %+v", res)
	}
}

func TestSubscribeDeliversPostsToTheBot(t *testing.T) {
	a, f, cr := setup(t)
	post := func(m map[string]any) string { b, _ := json.Marshal(m); return string(b) }
	f.events = []string{
		postedEvent(post(map[string]any{"id": "m0", "user_id": "bot1", "channel_id": "c1", "message": "my own post"}), "[]", "O"),
		postedEvent(post(map[string]any{"id": "m1", "user_id": "u1", "channel_id": "c1", "root_id": "root1", "message": "!reply Hi Ada"}), "[]", "O"),
		postedEvent(post(map[string]any{"id": "m2", "user_id": "u1", "channel_id": "c1", "message": "@opendesk what is this?"}), `["bot1"]`, "O"),
		postedEvent(post(map[string]any{"id": "m3", "user_id": "u1", "channel_id": "c1", "message": "a system join", "type": "system_join_channel"}), "[]", "O"),
		postedEvent(post(map[string]any{"id": "m4", "user_id": "u2", "channel_id": "c1", "message": "a dm"}), "[]", "D"),
		postedEvent(post(map[string]any{"id": "m5", "user_id": "u3", "channel_id": "c1", "message": "another bot", "props": map[string]any{"from_bot": "true"}}), "[]", "O"),
		postedEvent(post(map[string]any{"id": "m6", "user_id": "u1", "channel_id": "c1", "root_id": "root1", "message": "@ada can you look at this?", "file_ids": []string{"f2"}}), `["u2"]`, "O"),
		postedEvent(post(map[string]any{"id": "m7", "user_id": "u1", "channel_id": "c1", "root_id": "root1", "message": "!bogus nothing"}), "[]", "O"),
		postedEvent(post(map[string]any{"id": "m8", "user_id": "u1", "channel_id": "c1", "root_id": "root1", "message": "@opendesk !bogus nothing", "file_ids": []string{"f1"}}), `["bot1"]`, "O"),
	}
	got := make(chan channel.Inbound, 10)
	connected := make(chan struct{}, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- a.Subscribe(ctx, http.DefaultClient, cr, channel.Stream{
			Emit: func(_ context.Context, in []channel.Inbound) error {
				for _, x := range in {
					got <- x
				}
				return nil
			},
			Connected: func() { connected <- struct{}{} },
		})
	}()
	select {
	case <-connected:
	case <-time.After(3 * time.Second):
		t.Fatal("never connected")
	}
	var in []channel.Inbound
	for len(in) < 3 {
		select {
		case x := <-got:
			in = append(in, x)
		case <-time.After(3 * time.Second):
			t.Fatalf("only %d posts arrived: %+v", len(in), in)
		}
	}
	cancel()
	<-done
	a1, a2, a3 := in[0], in[1], in[2]
	if a1.Command != "reply" || a1.Text != "Hi Ada" || a1.ExternalThreadID != "root1" || a1.ExternalChannelID != "c1" || a1.AccountID != "team1" || a1.Directed || a1.EventID != "m1" {
		t.Fatalf("typed command: %+v", a1)
	}
	if a2.Command != "chat" || a2.Text != "what is this?" || !a2.Directed || a2.ExternalThreadID != "m2" {
		t.Fatalf("a mention: %+v", a2)
	}
	if a3.EventID != "m8" || a3.Command != "chat" || a3.Text != "!bogus nothing" || !a3.Directed || len(a3.Files) != 1 || a3.Files[0] != (channel.Attachment{ID: "f1", Name: "screen.png", ContentType: "image/png", SizeBytes: 2048}) {
		t.Fatalf("an unknown ! word said to the bot is chat, with its file: %+v", a3)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, call := range f.calls {
		if strings.Contains(call, "/files/f2") {
			t.Fatalf("a post not said to the bot had its files looked up: %v", f.calls)
		}
	}
}

func TestSubscribeRefusedTokenIsFatal(t *testing.T) {
	a, f, cr := setup(t)
	f.socketStatus = http.StatusUnauthorized
	err := a.Subscribe(context.Background(), http.DefaultClient, cr, channel.Stream{})
	var fatal *channel.FatalError
	if err == nil || errors.As(err, &fatal) == false && !strings.Contains(err.Error(), "could not connect") {
		t.Fatalf("%v", err)
	}
	cr["bot_token"] = "wrong"
	err = a.Subscribe(context.Background(), http.DefaultClient, cr, channel.Stream{})
	if !errors.As(err, &fatal) {
		t.Fatalf("a refused token should end the subscription for good: %v", err)
	}
}

func TestRateLimit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Ratelimit-Reset", "7")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer srv.Close()
	err := New(true).Post(context.Background(), http.DefaultClient, creds(srv.URL), "t", "x")
	var rl *channel.RateLimited
	if !errors.As(err, &rl) || rl.RetryAfter != 7*time.Second {
		t.Fatalf("%v", err)
	}
	if strings.Contains(err.Error(), srv.URL) {
		t.Fatalf("the server address is in the error: %v", err)
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func TestQuietStopsEveryMention(t *testing.T) {
	for _, s := range []string{"@channel", "**@all**", "[@here]", "hi,@channel", "hi.@channel", "+@all", "x-@here", "(@here)", "say:@all", "`@ada`"} {
		got := quiet(s)
		if strings.Contains(got, "@channel") || strings.Contains(got, "@all") || strings.Contains(got, "@here") || strings.Contains(got, "@ada") {
			t.Errorf("quiet(%q) = %q still notifies", s, got)
		}
	}
	for _, s := range []string{"ada@example.com", "ada.lovelace+support@example.co.uk", "a_b%c@x.io"} {
		if got := quiet(s); got != s {
			t.Errorf("quiet(%q) = %q changed an email address", s, got)
		}
	}
	text := richText(channel.RichMessage{Text: "see file", Attachments: []channel.Attachment{
		{Name: "@channel.pdf", URL: "https://app.test/a/1", SizeBytes: 3},
		{Name: "[@here].png", URL: "https://app.test/a/2", Preview: true},
	}})
	if strings.Contains(text, "@channel") || strings.Contains(text, "@here") {
		t.Fatalf("an attachment name notifies: %q", text)
	}
}

func TestButtonsNeedTheWebhookAddress(t *testing.T) {
	a, f, cr := setup(t)
	delete(cr, "webhook_url")
	ctx := context.Background()
	if _, err := a.CreateThread(ctx, http.DefaultClient, cr, "c1", channel.Ticket{Number: 1, Subject: "x"}); err == nil {
		t.Fatal("a card was posted with buttons that post nowhere")
	}
	if err := a.Update(ctx, http.DefaultClient, cr, "post1", channel.Ticket{Number: 1, Subject: "x"}); err == nil {
		t.Fatal("a card was updated with buttons that post nowhere")
	}
	if _, err := a.PostInteractive(ctx, http.DefaultClient, cr, "post1", channel.Message{Text: "Send?", Actions: []channel.Action{{Command: "confirm", Label: "Send"}}}); err == nil {
		t.Fatal("a confirmation was posted with buttons that post nowhere")
	}
	if len(f.posts) != 0 {
		t.Fatalf("posted %v", f.posts)
	}
	if _, err := a.PostInteractive(ctx, http.DefaultClient, cr, "post1", channel.Message{Text: "No buttons"}); err != nil {
		t.Fatalf("a message without buttons needs no address: %v", err)
	}
}
