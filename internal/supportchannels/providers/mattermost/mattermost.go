// Package mattermost is the Mattermost provider of the support channels
// (contracts/support-channels.md "Mattermost"). A bot account mirrors each ticket
// into a thread of a channel; people work it by talking to the bot in the thread
// (a websocket subscription delivers their posts, gateway.go) or by pressing the
// buttons on its messages (Mattermost posts those to opendesk's webhook).
package mattermost

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/useopendesk/opendesk/internal/netsafe"
	"github.com/useopendesk/opendesk/internal/supportchannels/channel"
)

// Adapter is the Mattermost provider. Dev lets a development instance reach a
// Mattermost on loopback; elsewhere the server must be a public https address,
// like every outbound URL.
type Adapter struct {
	Dev    bool
	client *http.Client
}

// New builds the adapter for an instance.
func New(dev bool) *Adapter {
	return &Adapter{Dev: dev, client: netsafe.Client(dev, 15*time.Second)}
}

// RichTextLimit is well under Mattermost's 16,383 characters per post.
func (Adapter) RichTextLimit() int { return 4000 }

const maxPost = 15000

func (Adapter) Describe() channel.Descriptor {
	return channel.Descriptor{Key: "mattermost", Name: "Mattermost", Description: "Mirror email tickets into Mattermost threads and work them by talking to Ollie.", Fields: []channel.Field{
		{Name: "server_url", Label: "Server address", Help: "Where your Mattermost is, like https://chat.example.com. It must be reachable from opendesk, and Mattermost must be allowed to call opendesk (System Console, Developer, Allow untrusted internal connections) when opendesk runs on a private address."},
		{Name: "bot_token", Label: "Bot access token", Secret: true, Help: "Create a bot account (Integrations, Bot Accounts) and a token for it. Add the bot to the team and to the channels tickets go to."},
		{Name: "team_id", Label: "Team", Discovered: true},
		{Name: "webhook_token", Label: "Button token", Secret: true, Generated: true},
	}}
}

// guard is the outbound policy for the admin's server address.
func (a Adapter) guard() netsafe.Guard { return netsafe.Guard{Dev: a.Dev} }

func (a Adapter) http(c *http.Client) *http.Client {
	if a.client != nil {
		return a.client
	}
	return c
}

// base is the server's API root, from the credentials' address.
func base(cr map[string]string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(cr["server_url"]))
	if err != nil || u.Host == "" {
		return "", errors.New("server_url must be the address of your Mattermost")
	}
	return strings.TrimRight(u.Scheme+"://"+u.Host+u.Path, "/") + "/api/v4", nil
}

// statusError is a Mattermost answer outside 2xx, with its own error id.
type statusError struct {
	code int
	id   string
}

func (e *statusError) Error() string {
	if e.id != "" {
		return fmt.Sprintf("mattermost: status %d (%s)", e.code, e.id)
	}
	return fmt.Sprintf("mattermost: status %d", e.code)
}

func (a Adapter) call(ctx context.Context, c *http.Client, cr map[string]string, method, path string, input, out any) error {
	root, err := base(cr)
	if err != nil {
		return err
	}
	var body io.Reader
	if input != nil {
		b, _ := json.Marshal(input)
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, root+path, body)
	if err != nil {
		return errors.New("mattermost request is invalid")
	}
	req.Header.Set("Authorization", "Bearer "+cr["bot_token"])
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.http(c).Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err // never the address: it is the admin's, and a path can carry a secret
		}
		return fmt.Errorf("mattermost request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		var refusal struct {
			ID string `json:"id"`
		}
		_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&refusal)
		_, _ = io.Copy(io.Discard, resp.Body)
		if resp.StatusCode == http.StatusTooManyRequests {
			// X-Ratelimit-Reset is the seconds until the window ends.
			reset, _ := strconv.ParseFloat(resp.Header.Get("X-Ratelimit-Reset"), 64)
			return fmt.Errorf("mattermost: %w", &channel.RateLimited{RetryAfter: channel.RateLimitDelay(resp.Header, reset)})
		}
		return &statusError{code: resp.StatusCode, id: refusal.ID}
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return nil
}

type user struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	IsBot    bool   `json:"is_bot"`
}

func (a Adapter) Validate(ctx context.Context, c *http.Client, cr map[string]string) (channel.Account, error) {
	if cr["server_url"] == "" || cr["bot_token"] == "" || cr["team_id"] == "" || cr["webhook_token"] == "" {
		return channel.Account{}, errors.New("server_url, bot_token and team_id are required")
	}
	if _, err := a.guard().ValidateURL(ctx, cr["server_url"]); err != nil {
		return channel.Account{}, err
	}
	var me user
	if err := a.call(ctx, c, cr, http.MethodGet, "/users/me", nil, &me); err != nil {
		return channel.Account{}, err
	}
	if !me.IsBot {
		// A person's token would act as that person, with everything they can read.
		return channel.Account{}, errors.New("bot_token must belong to a bot account")
	}
	var team struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Name        string `json:"name"`
	}
	if err := a.call(ctx, c, cr, http.MethodGet, "/teams/"+url.PathEscape(cr["team_id"]), nil, &team); err != nil {
		return channel.Account{}, err
	}
	name := team.DisplayName
	if name == "" {
		name = team.Name
	}
	return channel.Account{ID: team.ID, Name: name}, nil
}

func (a Adapter) DiscoverAccounts(ctx context.Context, c *http.Client, cr map[string]string) ([]channel.Account, error) {
	if cr["server_url"] == "" || cr["bot_token"] == "" {
		return nil, errors.New("server_url and bot_token are required")
	}
	if _, err := a.guard().ValidateURL(ctx, cr["server_url"]); err != nil {
		return nil, err
	}
	var teams []struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Name        string `json:"name"`
	}
	if err := a.call(ctx, c, cr, http.MethodGet, "/users/me/teams", nil, &teams); err != nil {
		return nil, err
	}
	out := make([]channel.Account, 0, len(teams))
	for _, t := range teams {
		name := t.DisplayName
		if name == "" {
			name = t.Name
		}
		if t.ID != "" {
			out = append(out, channel.Account{ID: t.ID, Name: name})
		}
	}
	return out, nil
}

// Discover lists the team's public and private channels the bot is a member of.
func (a Adapter) Discover(ctx context.Context, c *http.Client, cr map[string]string) ([]channel.Destination, error) {
	var items []struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Name        string `json:"name"`
		Type        string `json:"type"`
		DeleteAt    int64  `json:"delete_at"`
	}
	if err := a.call(ctx, c, cr, http.MethodGet, "/users/me/teams/"+url.PathEscape(cr["team_id"])+"/channels", nil, &items); err != nil {
		return nil, err
	}
	out := make([]channel.Destination, 0, len(items))
	for _, item := range items {
		if item.DeleteAt != 0 || (item.Type != "O" && item.Type != "P") {
			continue
		}
		name := item.DisplayName
		if name == "" {
			name = item.Name
		}
		kind := "channel"
		if item.Type == "P" {
			kind = "private"
		}
		out = append(out, channel.Destination{ID: item.ID, Name: name, Kind: kind, Available: true})
	}
	return out, nil
}

// Configure has nothing to register: the buttons carry opendesk's address in each
// message, and posts arrive over the bot's own websocket. It checks that the bot can
// work in the team, so the connection's test says so.
func (a Adapter) Configure(ctx context.Context, c *http.Client, cr map[string]string, _ channel.Setup) error {
	h, err := a.Health(ctx, c, cr, channel.Setup{})
	if err != nil {
		return err
	}
	if h.Status != "healthy" {
		return errors.New(h.Detail)
	}
	return nil
}

func (a Adapter) Health(ctx context.Context, c *http.Client, cr map[string]string, _ channel.Setup) (channel.Health, error) {
	var me user
	if err := a.call(ctx, c, cr, http.MethodGet, "/users/me", nil, &me); err != nil {
		var se *statusError
		if errors.As(err, &se) && (se.code == http.StatusUnauthorized || se.code == http.StatusForbidden) {
			return channel.Health{Status: "error", Detail: "Mattermost refused the bot's token. Connect again with a new token."}, nil
		}
		return channel.Health{}, err
	}
	err := a.call(ctx, c, cr, http.MethodGet, "/teams/"+url.PathEscape(cr["team_id"])+"/members/"+url.PathEscape(me.ID), nil, nil)
	var se *statusError
	if errors.As(err, &se) && se.code == http.StatusNotFound {
		return channel.Health{Status: "action_required", Detail: "The bot is not a member of this team. Add it in Mattermost, then test the connection."}, nil
	}
	if err != nil {
		return channel.Health{}, err
	}
	return channel.Health{Status: "healthy", Detail: "Mattermost accepts the bot and it is in the team."}, nil
}

// Verify checks the token opendesk put in every button's context: Mattermost
// signs nothing, so the token is the proof the press came from a message of ours.
func (Adapter) Verify(_ http.Header, body []byte, cr map[string]string) error {
	var x struct {
		Context struct {
			Token string `json:"token"`
		} `json:"context"`
	}
	want := cr["webhook_token"]
	if want == "" || json.Unmarshal(body, &x) != nil || subtle.ConstantTimeCompare([]byte(x.Context.Token), []byte(want)) != 1 {
		return errors.New("invalid mattermost button token")
	}
	return nil
}

// controls are the commands opendesk's own buttons send.
var controls = map[string]bool{"assign_self": true, "status": true, "priority": true, "confirm": true, "cancel": true, "suggest": true, "ask": true}

// Parse reads a press of one of the buttons or selects on opendesk's messages.
func (Adapter) Parse(_ http.Header, body []byte) (channel.WebhookResult, error) {
	var x struct {
		UserID    string `json:"user_id"`
		ChannelID string `json:"channel_id"`
		TeamID    string `json:"team_id"`
		PostID    string `json:"post_id"`
		TriggerID string `json:"trigger_id"`
		Context   struct {
			Action         string `json:"action"`
			Value          string `json:"value"`
			Thread         string `json:"thread"`
			SelectedOption string `json:"selected_option"`
		} `json:"context"`
	}
	if err := json.Unmarshal(body, &x); err != nil {
		return channel.WebhookResult{}, err
	}
	ack := channel.WebhookResult{Status: http.StatusOK, ContentType: "application/json", Body: []byte(`{}`)}
	if !controls[x.Context.Action] || x.PostID == "" || x.UserID == "" {
		return ack, nil
	}
	value := x.Context.Value
	if x.Context.SelectedOption != "" {
		value = x.Context.SelectedOption
	}
	text := value
	if x.Context.Action == "confirm" || x.Context.Action == "cancel" {
		text = x.Context.Action
	}
	thread := x.Context.Thread
	if thread == "" {
		thread = x.PostID // the ticket's card is the thread's first post
	}
	ack.Control = true
	ack.Events = []channel.Inbound{{EventID: x.TriggerID, AccountID: x.TeamID, ExternalChannelID: x.ChannelID, ExternalThreadID: thread, ExternalUserID: x.UserID,
		Command: x.Context.Action, Text: text, Value: value, Directed: true, SourceMessageID: x.PostID, Respond: x.UserID + "/" + x.ChannelID + "/" + thread}}
	return ack, nil
}

// mentionRe is an @name Mattermost would notify: an @ not inside a word, so markdown
// (**@all**, [@here]) and punctuation (hi,@channel, hi.@here) count. Mattermost splits words on
// that punctuation too; a letter, digit or _ before the @ (an email address) is left alone.
var mentionRe = regexp.MustCompile(`(^|[^A-Za-z0-9_])@([A-Za-z0-9._-]+)`)

// quiet stops a customer's words from notifying anyone: Mattermost has no switch for
// it, so every @name gets a zero-width space after its @ (an email address is left alone).
func quiet(s string) string {
	return mentionRe.ReplaceAllString(s, "$1@​$2")
}

func clip(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

type post struct {
	ChannelID string         `json:"channel_id"`
	RootID    string         `json:"root_id,omitempty"`
	Message   string         `json:"message"`
	Props     map[string]any `json:"props,omitempty"`
}

type created struct {
	ID string `json:"id"`
}

func (a Adapter) send(ctx context.Context, c *http.Client, cr map[string]string, p post) (created, error) {
	var out created
	err := a.call(ctx, c, cr, http.MethodPost, "/posts", p, &out)
	return out, err
}

func (a Adapter) CreateThread(ctx context.Context, c *http.Client, cr map[string]string, destination string, t channel.Ticket) (channel.Thread, error) {
	props, err := ticketProps(cr, t)
	if err != nil {
		return channel.Thread{}, err
	}
	root, err := a.send(ctx, c, cr, post{ChannelID: destination, Message: fmt.Sprintf("**#%d %s**", t.Number, clip(quiet(t.Subject), 200)), Props: props})
	if err != nil {
		return channel.Thread{}, err
	}
	return channel.Thread{ID: root.ID, RootID: root.ID, ChannelID: destination}, nil
}

func (a Adapter) Post(ctx context.Context, c *http.Client, cr map[string]string, thread, text string) error {
	_, err := a.send(ctx, c, cr, post{ChannelID: cr["channel_id"], RootID: thread, Message: clip(quiet(text), maxPost)})
	return err
}

// Update refreshes the ticket's card, the thread's first post.
func (a Adapter) Update(ctx context.Context, c *http.Client, cr map[string]string, root string, t channel.Ticket) error {
	props, err := ticketProps(cr, t)
	if err != nil {
		return err
	}
	return a.call(ctx, c, cr, http.MethodPut, "/posts/"+url.PathEscape(root)+"/patch",
		map[string]any{"message": fmt.Sprintf("**#%d %s**", t.Number, clip(quiet(t.Subject), 200)), "props": props}, nil)
}

func (a Adapter) PostInteractive(ctx context.Context, c *http.Client, cr map[string]string, thread string, message channel.Message) (channel.MessageRef, error) {
	p := post{ChannelID: cr["channel_id"], RootID: thread, Message: clip(quiet(message.Text), maxPost)}
	if len(message.Actions) > 0 {
		actions := make([]any, 0, len(message.Actions))
		for _, action := range message.Actions {
			style := "default"
			switch action.Style {
			case "primary":
				style = "primary"
			case "danger":
				style = "danger"
			}
			to, err := integration(cr, action.Command, action.Value, thread)
			if err != nil {
				return channel.MessageRef{}, err
			}
			actions = append(actions, map[string]any{"id": "od" + strings.NewReplacer("_", "", "-", "").Replace(action.Command), "name": action.Label, "style": style, "integration": to})
		}
		p.Props = map[string]any{"attachments": []any{map[string]any{"actions": actions}}}
	}
	out, err := a.send(ctx, c, cr, p)
	return channel.MessageRef{ID: out.ID}, err
}

// ClearActions removes the buttons of the message a press came from and keeps its text.
func (a Adapter) ClearActions(ctx context.Context, c *http.Client, cr map[string]string, in channel.Inbound) error {
	if in.SourceMessageID == "" {
		return nil
	}
	return a.call(ctx, c, cr, http.MethodPut, "/posts/"+url.PathEscape(in.SourceMessageID)+"/patch", map[string]any{"props": map[string]any{"attachments": []any{}}}, nil)
}

// Respond sends the person an ephemeral post only they see.
func (a Adapter) Respond(ctx context.Context, c *http.Client, cr map[string]string, handle, text string) error {
	parts := strings.Split(handle, "/")
	if text == "" || len(parts) != 3 || parts[0] == "" || parts[1] == "" {
		return nil
	}
	return a.call(ctx, c, cr, http.MethodPost, "/posts/ephemeral", map[string]any{"user_id": parts[0],
		"post": map[string]any{"channel_id": parts[1], "root_id": parts[2], "message": clip(text, maxPost)}}, nil)
}

func (a Adapter) PostRich(ctx context.Context, c *http.Client, cr map[string]string, thread string, message channel.RichMessage) (channel.MessageRef, error) {
	out, err := a.send(ctx, c, cr, post{ChannelID: cr["channel_id"], RootID: thread, Message: richText(message)})
	return channel.MessageRef{ID: out.ID}, err
}

func (a Adapter) UpdateRich(ctx context.Context, c *http.Client, cr map[string]string, _, id string, message channel.RichMessage) error {
	return a.call(ctx, c, cr, http.MethodPut, "/posts/"+url.PathEscape(id)+"/patch", map[string]any{"message": richText(message)}, nil)
}

func (a Adapter) DeleteRich(ctx context.Context, c *http.Client, cr map[string]string, _, id string) error {
	err := a.call(ctx, c, cr, http.MethodDelete, "/posts/"+url.PathEscape(id), nil, nil)
	var se *statusError
	if errors.As(err, &se) && se.code == http.StatusNotFound {
		return nil // already gone
	}
	return err
}

func richText(m channel.RichMessage) string {
	text := quiet(m.Text)
	view := ""
	if m.ViewURL != "" {
		view = "\n[View in opendesk](" + m.ViewURL + ")"
	}
	for i, f := range m.Attachments {
		name := quiet(strings.NewReplacer("[", "(", "]", ")").Replace(f.Name))
		line := fmt.Sprintf("\n[%s](%s) · %d bytes", name, f.URL, f.SizeBytes)
		if f.Preview {
			line = fmt.Sprintf("\n![%s](%s)", name, f.URL)
		}
		if len([]rune(text+line+view)) > 3900 {
			text += fmt.Sprintf("\n%d more attachment(s)", len(m.Attachments)-i)
			break
		}
		text += line
	}
	return clip(text+view, maxPost)
}

// DownloadAttachment opens a file from the Mattermost server of the connection.
func (a Adapter) DownloadAttachment(ctx context.Context, c *http.Client, cr map[string]string, f channel.Attachment) (io.ReadCloser, error) {
	root, err := base(cr)
	if err != nil || f.ID == "" || strings.ContainsAny(f.ID, "/?#") {
		return nil, errors.New("mattermost attachment is invalid")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, root+"/files/"+url.PathEscape(f.ID), nil)
	if err != nil {
		return nil, errors.New("mattermost attachment request is invalid")
	}
	req.Header.Set("Authorization", "Bearer "+cr["bot_token"])
	resp, err := a.http(c).Do(req)
	if err != nil {
		return nil, errors.New("mattermost attachment download failed")
	}
	if resp.StatusCode/100 != 2 {
		resp.Body.Close()
		return nil, fmt.Errorf("mattermost attachment: status %d", resp.StatusCode)
	}
	return resp.Body, nil
}

// integration is where a button posts: opendesk's webhook, with the button token and
// what the press means in its context. A button without the address would post nowhere.
func integration(cr map[string]string, command, value, thread string) (map[string]any, error) {
	if cr["webhook_url"] == "" {
		return nil, errors.New("mattermost: the connection's webhook address is missing")
	}
	ctx := map[string]any{"action": command, "token": cr["webhook_token"]}
	if value != "" {
		ctx["value"] = value
	}
	if thread != "" {
		ctx["thread"] = thread
	}
	return map[string]any{"url": cr["webhook_url"], "context": ctx}, nil
}

var (
	statuses   = []string{"open", "pending", "on_hold", "solved", "closed"}
	priorities = []string{"low", "normal", "high", "urgent"}
)

func selectAction(to map[string]any, id, name string, values []string) map[string]any {
	options := make([]any, 0, len(values))
	for _, v := range values {
		options = append(options, map[string]any{"text": strings.ReplaceAll(v, "_", " "), "value": v})
	}
	return map[string]any{"id": id, "name": name, "type": "select", "options": options, "integration": to}
}

// ticketProps is the ticket's card: a message attachment with its facts and controls.
func ticketProps(cr map[string]string, t channel.Ticket) (map[string]any, error) {
	assign, err := integration(cr, "assign_self", "", "")
	if err != nil {
		return nil, err
	}
	status, _ := integration(cr, "status", "", "")
	priority, _ := integration(cr, "priority", "", "")
	return map[string]any{"attachments": []any{map[string]any{
		"title": fmt.Sprintf("#%d %s", t.Number, clip(quiet(t.Subject), 200)), "title_link": t.URL,
		"fields": []any{
			map[string]any{"title": "Customer", "value": clip(quiet(t.Customer), 300), "short": true},
			map[string]any{"title": "Assignee", "value": clip(quiet(t.Assignee), 300), "short": true},
			map[string]any{"title": "Status", "value": strings.ReplaceAll(t.Status, "_", " "), "short": true},
			map[string]any{"title": "Priority", "value": t.Priority, "short": true},
		},
		"actions": []any{
			map[string]any{"id": "odassign", "name": "Assign to me", "style": "primary", "integration": assign},
			selectAction(status, "odstatus", "Status", statuses),
			selectAction(priority, "odpriority", "Priority", priorities),
		},
	}}}, nil
}
