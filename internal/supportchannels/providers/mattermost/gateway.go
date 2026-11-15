package mattermost

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/useopendesk/opendesk/internal/supportchannels/channel"
)

// reasonToken is shown to admins when Mattermost refuses the bot for good.
const reasonToken = "Mattermost refused the bot's token. Disconnect this connection and connect it again with a new token."

const (
	pingEvery   = 30 * time.Second
	pingTimeout = 10 * time.Second
	maxFiles    = 10
)

// explicit are the typed commands a person may start a message with, after a "!": Mattermost
// keeps "/" for its own slash commands.
var explicit = map[string]bool{"link": true, "reply": true, "note": true, "assign": true, "assign_self": true, "status": true, "priority": true}

type socketEvent struct {
	Event string `json:"event"`
	Data  struct {
		Post     string `json:"post"`
		Mentions string `json:"mentions"`
		TeamID   string `json:"team_id"`
		Type     string `json:"channel_type"`
	} `json:"data"`
	Broadcast struct {
		ChannelID string `json:"channel_id"`
		TeamID    string `json:"team_id"`
	} `json:"broadcast"`
}

type socketPost struct {
	ID      string         `json:"id"`
	UserID  string         `json:"user_id"`
	RootID  string         `json:"root_id"`
	Message string         `json:"message"`
	Type    string         `json:"type"`
	FileIDs []string       `json:"file_ids"`
	ChanID  string         `json:"channel_id"`
	Props   map[string]any `json:"props"`
}

// Subscribe receives the posts the bot can read over Mattermost's websocket, so people
// can talk to it in a ticket's thread without a webhook or a slash command. A refused
// token ends the subscription with a channel.FatalError; any other end is retried by the engine.
func (a Adapter) Subscribe(ctx context.Context, c *http.Client, cr map[string]string, stream channel.Stream) error {
	var me user
	if err := a.call(ctx, c, cr, http.MethodGet, "/users/me", nil, &me); err != nil {
		var se *statusError
		if errors.As(err, &se) && (se.code == http.StatusUnauthorized || se.code == http.StatusForbidden) {
			return &channel.FatalError{Reason: reasonToken}
		}
		return err
	}
	root, err := base(cr)
	if err != nil {
		return &channel.FatalError{Reason: "The server address of this connection is not valid. Disconnect it and connect it again."}
	}
	u, err := url.Parse(root + "/websocket")
	if err != nil {
		return err
	}
	if u.Scheme == "https" {
		u.Scheme = "wss"
	} else {
		u.Scheme = "ws"
	}
	header := http.Header{"Authorization": {"Bearer " + cr["bot_token"]}}
	ws, resp, err := websocket.Dial(ctx, u.String(), &websocket.DialOptions{HTTPClient: a.http(c), HTTPHeader: header})
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			return &channel.FatalError{Reason: reasonToken}
		}
		return errors.New("mattermost websocket could not connect")
	}
	defer ws.CloseNow()
	ws.SetReadLimit(4 << 20)
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	// A connection that stops answering pings is dropped, so the engine reconnects.
	go func() {
		t := time.NewTicker(pingEvery)
		defer t.Stop()
		for {
			select {
			case <-runCtx.Done():
				return
			case <-t.C:
				pctx, stop := context.WithTimeout(runCtx, pingTimeout)
				err := ws.Ping(pctx)
				stop()
				if err != nil {
					cancel()
					_ = ws.CloseNow()
					return
				}
			}
		}
	}()
	for {
		_, data, err := ws.Read(runCtx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return errors.New("mattermost websocket ended")
		}
		var ev socketEvent
		if json.Unmarshal(data, &ev) != nil {
			continue
		}
		switch ev.Event {
		case "hello":
			if stream.Connected != nil {
				stream.Connected()
			}
		case "posted":
			in, ok := a.inbound(runCtx, c, cr, me, ev)
			if !ok {
				continue
			}
			if err := stream.Emit(runCtx, []channel.Inbound{in}); err != nil {
				return err
			}
		}
	}
}

// inbound reads one posted event as something said to the bot, or not at all: the bot's own
// posts, other bots', system posts, other teams', direct messages and posts that neither mention
// the bot nor start with a command are left out.
func (a Adapter) inbound(ctx context.Context, c *http.Client, cr map[string]string, me user, ev socketEvent) (channel.Inbound, bool) {
	var p socketPost
	if json.Unmarshal([]byte(ev.Data.Post), &p) != nil || p.ID == "" || p.UserID == "" {
		return channel.Inbound{}, false
	}
	team := ev.Data.TeamID
	if team == "" {
		team = ev.Broadcast.TeamID
	}
	if p.UserID == me.ID || p.Type != "" || ev.Data.Type == "D" || ev.Data.Type == "G" || (team != "" && team != cr["team_id"]) {
		return channel.Inbound{}, false
	}
	if from, _ := p.Props["from_bot"].(string); from == "true" {
		return channel.Inbound{}, false
	}
	if _, hook := p.Props["from_webhook"]; hook {
		return channel.Inbound{}, false
	}
	var mentions []string
	_ = json.Unmarshal([]byte(ev.Data.Mentions), &mentions)
	directed := false
	for _, m := range mentions {
		directed = directed || m == me.ID
	}
	text := strings.TrimSpace(p.Message)
	// The bot's own name is not part of what is said to it.
	text = strings.TrimSpace(strings.TrimPrefix(text, "@"+me.Username))
	cmd := "chat"
	if rest, ok := strings.CutPrefix(text, "!"); ok {
		word, tail, _ := strings.Cut(rest, " ")
		if explicit[strings.ToLower(word)] {
			cmd, text = strings.ToLower(word), strings.TrimSpace(tail)
		}
	}
	if cmd == "chat" && !directed {
		return channel.Inbound{}, false // people talking among themselves in the thread
	}
	thread := p.RootID
	if thread == "" {
		thread = p.ID // a new conversation starts at the post that opened it
	}
	channelID := p.ChanID
	if channelID == "" {
		channelID = ev.Broadcast.ChannelID
	}
	in := channel.Inbound{EventID: p.ID, AccountID: team, ExternalChannelID: channelID, ExternalThreadID: thread, ExternalUserID: p.UserID, Command: cmd,
		Text: text, Value: text, Directed: directed, ExternalMessageID: p.ID, Respond: p.UserID + "/" + channelID + "/" + thread}
	for i, id := range p.FileIDs {
		if i == maxFiles {
			break
		}
		var f struct {
			ID   string `json:"id"`
			Name string `json:"name"`
			Mime string `json:"mime_type"`
			Size int64  `json:"size"`
		}
		if a.call(ctx, c, cr, http.MethodGet, "/files/"+url.PathEscape(id)+"/info", nil, &f) == nil && f.ID != "" {
			in.Files = append(in.Files, channel.Attachment{ID: f.ID, Name: f.Name, ContentType: f.Mime, SizeBytes: f.Size})
		}
	}
	if text == "" && len(in.Files) == 0 {
		return channel.Inbound{}, false
	}
	return in, true
}
