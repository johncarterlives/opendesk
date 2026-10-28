package collab

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// fakeGraph is a small Microsoft Graph mail API with per-folder delta.
type fakeGraph struct {
	t       *testing.T
	srv     *httptest.Server
	mu      sync.Mutex
	folders []map[string]any
	msgs    map[string]*graphFakeMsg
	// changes are the delta items of each folder, oldest first. A delta or next link is a
	// place in them, so a link read again answers the same, as Graph's do.
	changes  map[string][]map[string]any
	pageSize int      // delta items a page
	moves    []string // "id->folder"
	patches  []string // "id:json"
	drafts   []string // MIME of created drafts
	sentIDs  []string
	nextID   int
	// unfiltered lets a first delta come without the window (a history import of all
	// mail, history_test.go).
	unfiltered bool
	// settings is the profile name and automatic replies (settings_test.go).
	settings fakeGraphSettings
	// cats are the master categories, message categories and deleted drafts (categories_test.go).
	cats fakeGraphCats
}

type graphFakeMsg struct {
	id, conv, folder string
	read             bool
	raw              []byte
	date             time.Time
}

var graphWell = map[string]string{"inbox": "f-inbox", "sentitems": "f-sent", "drafts": "f-drafts", "deleteditems": "f-trash",
	"junkemail": "f-junk", "archive": "f-archive"}

func newFakeGraph(t *testing.T) *fakeGraph {
	g := &fakeGraph{t: t, msgs: map[string]*graphFakeMsg{}, changes: map[string][]map[string]any{}, pageSize: 2, folders: []map[string]any{
		{"id": "f-inbox", "displayName": "Inbox", "childFolderCount": 1}, {"id": "f-sent", "displayName": "Sent Items"},
		{"id": "f-drafts", "displayName": "Drafts"}, {"id": "f-trash", "displayName": "Deleted Items"},
		{"id": "f-junk", "displayName": "Junk Email"}, {"id": "f-archive", "displayName": "Archive"},
	}}
	g.srv = httptest.NewServer(g)
	t.Cleanup(g.srv.Close)
	return g
}

func (g *fakeGraph) item(m *graphFakeMsg) map[string]any {
	return map[string]any{"id": m.id, "conversationId": m.conv, "isRead": m.read, "isDraft": false, "parentFolderId": m.folder,
		"receivedDateTime": m.date.UTC().Format(time.RFC3339), "flag": map[string]string{"flagStatus": "notFlagged"}}
}

func (g *fakeGraph) add(id, conv, folder string, read bool, m testMail) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if m.date.IsZero() {
		m.date = time.Now().Add(-time.Duration(100-len(g.msgs)) * time.Minute)
	}
	msg := &graphFakeMsg{id: id, conv: conv, folder: folder, read: read, raw: m.raw(), date: m.date}
	g.msgs[id] = msg
	g.changes[folder] = append(g.changes[folder], g.item(msg))
}

// move moves a message at the provider (as a phone would).
func (g *fakeGraph) move(id, folder string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	m := g.msgs[id]
	g.changes[m.folder] = append(g.changes[m.folder], map[string]any{"id": id, "@removed": map[string]string{"reason": "changed"}})
	m.folder = folder
	g.changes[folder] = append(g.changes[folder], g.item(m))
}

func (g *fakeGraph) remove(id string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	m := g.msgs[id]
	g.changes[m.folder] = append(g.changes[m.folder], map[string]any{"id": id, "@removed": map[string]string{"reason": "deleted"}})
	delete(g.msgs, id)
}

func (g *fakeGraph) markRead(id string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	m := g.msgs[id]
	m.read = true
	g.changes[m.folder] = append(g.changes[m.folder], g.item(m))
}

func (g *fakeGraph) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !strings.Contains(r.Header.Get("Prefer"), `IdType="ImmutableId"`) {
		g.t.Errorf("no immutable ids on %s %s", r.Method, r.URL.Path)
	}
	reply := func(v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	p := r.URL.Path
	parts := strings.Split(strings.Trim(p, "/"), "/")
	switch {
	case p == "/me" || strings.HasPrefix(p, "/me/mailboxSettings"):
		g.settings.serve(g.t, w, r, p)
	case strings.HasPrefix(p, "/me/outlook/") || (len(parts) == 3 && parts[1] == "messages" && (r.Method == "GET" || r.Method == "DELETE")):
		g.serveCats(w, r, parts)
	case r.Method == "GET" && p == "/me/mailFolders":
		reply(map[string]any{"value": g.folders})
	case r.Method == "GET" && p == "/me/mailFolders/f-inbox/childFolders":
		reply(map[string]any{"value": []map[string]any{{"id": "f-proj", "displayName": "Projects", "parentFolderId": "f-inbox"}}})
	case r.Method == "GET" && len(parts) == 3 && parts[1] == "mailFolders" && graphWell[parts[2]] != "":
		reply(map[string]any{"id": graphWell[parts[2]]})
	case r.Method == "GET" && (strings.HasSuffix(p, "/messages/delta") || strings.HasPrefix(p, "/delta/") || strings.HasPrefix(p, "/next/")):
		folder := parts[len(parts)-1]
		if strings.HasSuffix(p, "/messages/delta") {
			folder = parts[2]
			if !strings.Contains(r.URL.Query().Get("$filter"), "receivedDateTime ge ") && !g.unfiltered {
				g.t.Errorf("first delta without the window: %s", r.URL.RawQuery)
			}
		}
		// A round's window ("receivedDateTime ge"), carried in its links as ge (unix seconds).
		q := r.URL.Query()
		ge, _ := strconv.ParseInt(q.Get("ge"), 10, 64)
		if f, ok := strings.CutPrefix(q.Get("$filter"), "receivedDateTime ge "); ok {
			if at, err := time.Parse(time.RFC3339, f); err == nil {
				ge = at.Unix()
			}
		}
		window := "&ge=" + strconv.FormatInt(ge, 10)
		// A round is the changes after since up to upto (where its first page found the end),
		// in pages; its delta link goes on from upto.
		log := []map[string]any{}
		for _, c := range g.changes[folder] {
			at, _ := time.Parse(time.RFC3339, fmt.Sprint(c["receivedDateTime"]))
			if c["@removed"] != nil || ge == 0 || at.Unix() >= ge {
				log = append(log, c)
			} else {
				log = append(log, map[string]any{"id": c["id"], "outside": true})
			}
		}
		since, _ := strconv.Atoi(q.Get("since"))
		upto, offset := len(log), 0
		if strings.HasPrefix(p, "/next/") {
			upto, _ = strconv.Atoi(q.Get("upto"))
			offset, _ = strconv.Atoi(q.Get("page"))
		}
		list := log[min(since, upto):upto]
		offset = min(offset, len(list))
		end := min(offset+g.pageSize, len(list))
		value := []map[string]any{}
		for _, c := range list[offset:end] {
			if c["outside"] == nil {
				value = append(value, c)
			}
		}
		if end < len(list) {
			reply(map[string]any{"value": value, "@odata.nextLink": g.srv.URL + "/next/" + folder +
				"?since=" + strconv.Itoa(since) + "&upto=" + strconv.Itoa(upto) + "&page=" + strconv.Itoa(end) + window})
			return
		}
		reply(map[string]any{"value": value, "@odata.deltaLink": g.srv.URL + "/delta/" + folder + "?since=" + strconv.Itoa(upto) + window})
	case r.Method == "GET" && len(parts) == 3 && parts[1] == "mailFolders" && r.URL.Query().Get("$select") == "totalItemCount":
		n := 0
		for _, m := range g.msgs {
			if m.folder == parts[2] {
				n++
			}
		}
		reply(map[string]any{"totalItemCount": n})
	case r.Method == "GET" && len(parts) == 4 && parts[1] == "messages" && parts[3] == "$value":
		m := g.msgs[parts[2]]
		if m == nil {
			w.WriteHeader(404)
			_, _ = w.Write([]byte(`{"error":{"code":"ErrorItemNotFound","message":"x"}}`))
			return
		}
		_, _ = w.Write(m.raw)
	case r.Method == "PATCH" && len(parts) == 3 && parts[1] == "messages":
		b, _ := io.ReadAll(r.Body)
		g.patches = append(g.patches, parts[2]+":"+string(b))
		reply(map[string]any{"id": parts[2]})
	case r.Method == "POST" && len(parts) == 4 && parts[1] == "messages" && parts[3] == "move":
		var in struct {
			DestinationID string `json:"destinationId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		g.moves = append(g.moves, parts[2]+"->"+in.DestinationID)
		if m := g.msgs[parts[2]]; m != nil {
			m.folder = in.DestinationID
		}
		reply(map[string]any{"id": parts[2]})
	case r.Method == "POST" && p == "/me/messages":
		b, _ := io.ReadAll(r.Body)
		raw, err := base64.StdEncoding.DecodeString(string(b))
		if err != nil || r.Header.Get("Content-Type") != "text/plain" {
			g.t.Errorf("draft body: %v %s", err, r.Header.Get("Content-Type"))
		}
		g.drafts = append(g.drafts, string(raw))
		g.nextID++
		reply(map[string]any{"id": "d" + strconv.Itoa(g.nextID), "conversationId": "c1"})
	case r.Method == "POST" && len(parts) == 4 && parts[1] == "messages" && parts[3] == "send":
		g.sentIDs = append(g.sentIDs, parts[2])
		w.WriteHeader(202)
	default:
		g.t.Errorf("unexpected Graph call %s %s", r.Method, r.URL.String())
		w.WriteHeader(400)
	}
}

// burst adds n messages to a folder, received at the given time.
func (g *fakeGraph) burst(prefix, folder string, n int, at time.Time, to string) {
	for i := 0; i < n; i++ {
		id := prefix + "-" + strconv.Itoa(i)
		g.add(id, id, folder, false, testMail{from: "Frank <frank@example.com>", to: to, subject: "Burst",
			msgID: id + "@example.com", body: id, date: at})
	}
}

func TestGraphSyncFirstConnectStaysCapped(t *testing.T) {
	w := newWorld(t)
	g := newFakeGraph(t)
	g.pageSize = 50
	w.s.graphBase = g.srv.URL
	a := w.account(w.agent, ProviderMicrosoft, VisibilityShared, Audience{Everyone: true})
	g.burst("budget", "f-inbox", initialMax, time.Now().Add(-48*time.Hour), a.Email)
	g.burst("budget-archive", "f-archive", 1, time.Now().Add(-48*time.Hour), a.Email)
	for pass := 1; pass <= 2; pass++ {
		if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
			t.Fatal(err)
		}
		if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id = $1`, a.ID); n != initialMax {
			t.Fatalf("pass %d: %d messages, want %d", pass, n, initialMax)
		}
	}
	var st folderDeltaState
	_ = json.Unmarshal(w.folderByRemote(a, "f-archive").SyncState, &st)
	if st.Delta == "" || st.Next != "" || st.Resume != "" {
		t.Fatalf("archive place after the first sync: %+v", st)
	}
}

func TestGraphSyncFirstConnectCapSpansPasses(t *testing.T) {
	w := newWorld(t)
	g := newFakeGraph(t)
	w.s.graphBase = g.srv.URL
	a := w.account(w.agent, ProviderMicrosoft, VisibilityShared, Audience{Everyone: true})
	// Two a page: the inbox's first round is longer than a pass and keeps what it has left
	// of the budget for the next one; the archive gets none of it.
	g.burst("inbox", "f-inbox", 2*graphPagesPerPass+50, time.Now().Add(-48*time.Hour), a.Email)
	g.burst("archive", "f-archive", 150, time.Now().Add(-72*time.Hour), a.Email)
	all := `SELECT count(*) FROM collab_messages WHERE account_id = $1`
	for pass, want := range []int{2 * graphPagesPerPass, 2*graphPagesPerPass + 50, 2*graphPagesPerPass + 50} {
		if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
			t.Fatal(err)
		}
		if n := w.count(all, a.ID); n != want {
			t.Fatalf("pass %d: %d messages, want %d", pass+1, n, want)
		}
	}
	var st folderDeltaState
	_ = json.Unmarshal(w.folderByRemote(a, "f-inbox").SyncState, &st)
	if st.Delta == "" || st.Resume != "" {
		t.Fatalf("inbox place after the first sync: %+v", st)
	}
}

func TestGraphSyncResumesWhenDeltaBudgetIsExhausted(t *testing.T) {
	w := newWorld(t)
	g := newFakeGraph(t)
	g.pageSize = 50
	w.s.graphBase = g.srv.URL
	a := w.account(w.agent, ProviderMicrosoft, VisibilityShared, Audience{Everyone: true})
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}

	g.burst("delta-budget", "f-inbox", initialMax+1, time.Now(), a.Email)
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id = $1 AND remote_id LIKE 'delta-budget-%'`, a.ID); n != initialMax {
		t.Fatalf("first delta sync imported %d messages, want %d", n, initialMax)
	}

	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id = $1 AND remote_id LIKE 'delta-budget-%'`, a.ID); n != initialMax+1 {
		t.Fatalf("second delta sync imported %d messages, want %d", n, initialMax+1)
	}
	var st folderDeltaState
	_ = json.Unmarshal(w.folderByRemote(a, "f-inbox").SyncState, &st)
	if st.Delta == "" || st.Resume != "" || st.Next != "" {
		t.Fatalf("inbox place after the burst: %+v", st)
	}
}

// TestGraphSyncMailGoneBeforeItIsRead: new mail deleted at Microsoft before the sync reads
// it frees its place for the next new message, so a burst larger than a pass's budget still
// comes in whole over the next passes.
func TestGraphSyncMailGoneBeforeItIsRead(t *testing.T) {
	w := newWorld(t)
	g := newFakeGraph(t)
	g.pageSize = 50
	w.s.graphBase = g.srv.URL
	a := w.account(w.agent, ProviderMicrosoft, VisibilityShared, Audience{Everyone: true})
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	// More than two passes' worth: the first pass stops at the budget, the second goes on
	// from where it stopped.
	g.burst("b", "f-inbox", 2*initialMax+200, time.Now(), a.Email)
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	// Gone before the second pass reads them: the delta still lists them, reading one answers
	// 404. One on the page where that pass's budget would end, one first on the next.
	g.mu.Lock()
	delete(g.msgs, "b-960")
	delete(g.msgs, "b-1000")
	g.mu.Unlock()
	for range 4 {
		if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
			t.Fatal(err)
		}
	}
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id = $1`, a.ID); n != 2*initialMax+198 {
		t.Fatalf("%d messages, want %d", n, 2*initialMax+198)
	}
}

func TestGraphSyncTouchedOldMailStaysOut(t *testing.T) {
	w := newWorld(t)
	g := newFakeGraph(t)
	g.pageSize = 50
	w.s.graphBase = g.srv.URL
	a := w.account(w.agent, ProviderMicrosoft, VisibilityShared, Audience{Everyone: true})
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	// Mail from before the connect that was never imported, read in bulk elsewhere: the
	// delta carries every one of them. Then a new message.
	g.burst("old", "f-inbox", initialMax, time.Now().Add(-72*time.Hour), a.Email)
	g.burst("older", "f-inbox", 50, time.Now().Add(-90*24*time.Hour), a.Email)
	g.burst("new", "f-inbox", 1, time.Now(), a.Email)
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id = $1`, a.ID); n != 1 || w.count(
		`SELECT count(*) FROM collab_messages WHERE account_id = $1 AND remote_id = 'new-0'`, a.ID) != 1 {
		t.Fatalf("%d messages imported, want only the new one", n)
	}
	var st folderDeltaState
	_ = json.Unmarshal(w.folderByRemote(a, "f-inbox").SyncState, &st)
	if st.Delta == "" || st.Resume != "" {
		t.Fatalf("inbox place: %+v", st)
	}
}

func TestGraphSyncBurstKeepsReadingTheFolder(t *testing.T) {
	w := newWorld(t)
	g := newFakeGraph(t)
	g.pageSize = 50
	w.s.graphBase = g.srv.URL
	a := w.account(w.agent, ProviderMicrosoft, VisibilityShared, Audience{Everyone: true})
	g.add("kept", "kept", "f-archive", true, testMail{from: "Frank <frank@example.com>", to: a.Email, subject: "Kept",
		msgID: "kept@example.com", body: "Kept", date: time.Now().Add(-72 * time.Hour)})
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	// A burst in the inbox, and pages after the one the budget ends on, a known message
	// moved there from the archive: the move is read in the same pass, so the message is
	// never in no folder (and removed).
	g.burst("burst", "f-inbox", initialMax+2*g.pageSize, time.Now(), a.Email)
	g.move("kept", "f-inbox")
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	m := w.messageByRemote(a, "kept")
	if inbox := w.folderByRemote(a, "f-inbox"); !sliceHas(m.FolderIDs, inbox.ID) {
		t.Fatalf("moved message: %+v", m.FolderIDs)
	}
	var st folderDeltaState
	_ = json.Unmarshal(w.folderByRemote(a, "f-inbox").SyncState, &st)
	if st.Delta == "" || st.Resume == "" {
		t.Fatalf("inbox place during the burst: %+v", st)
	}
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id = $1`, a.ID); n != initialMax+2*g.pageSize+1 {
		t.Fatalf("%d messages, want %d", n, initialMax+2*g.pageSize+1)
	}
}

func TestGraphSync(t *testing.T) {
	w := newWorld(t)
	g := newFakeGraph(t)
	w.s.graphBase = g.srv.URL
	a := w.account(w.agent, ProviderMicrosoft, VisibilityShared, Audience{Everyone: true})
	g.add("g1", "c1", "f-inbox", false, testMail{from: "Frank <frank@example.com>", to: a.Email, subject: "Order", msgID: "o1@example.com", body: "Where is it?"})
	g.add("g2", "c1", "f-sent", true, testMail{from: a.Email, to: "frank@example.com", subject: "Re: Order", msgID: "o2@acme.test",
		inReplyTo: "o1@example.com", body: "On its way"})
	g.add("g3", "c2", "f-proj", false, testMail{from: "pm@example.com", to: a.Email, subject: "Plan", msgID: "p1@example.com", body: "The plan"})

	for i := 0; i < 3; i++ {
		g.add("n"+strconv.Itoa(i), "c0", "f-inbox", true, testMail{from: "news@example.com", to: a.Email, subject: "News",
			msgID: "n" + strconv.Itoa(i) + "@example.com", body: "News"})
	}
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	a = w.reload(a)
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id = $1 AND remote_id LIKE 'n%'`, a.ID); n != 3 {
		t.Fatalf("paged delta: %d of 3", n)
	}
	if a.Status != "active" {
		t.Fatalf("status %s %s", a.Status, a.LastError)
	}
	proj := w.folderByRemote(a, "f-proj")
	if proj.Path != "Inbox/Projects" || proj.Name != "Projects" || proj.Role != nil {
		t.Fatalf("child folder: %+v", proj)
	}
	inbox, archive, trash := w.folderByRemote(a, "f-inbox"), w.folderByRemote(a, "f-archive"), w.folderByRemote(a, "f-trash")
	sent := w.folderByRemote(a, "f-sent")
	if *inbox.Role != RoleInbox || *archive.Role != RoleArchive || *trash.Role != RoleTrash || *w.folderByRemote(a, "f-junk").Role != RoleSpam {
		t.Fatal("well-known roles")
	}
	c1 := w.threadByRemote(a, "c1")
	if c1.MessageCount != 2 || !c1.Unread || !sliceHas(c1.FolderIDs, inbox.ID) || !sliceHas(c1.FolderIDs, sent.ID) {
		t.Fatalf("c1: %+v", c1)
	}
	// Every member sees a shared account's changes.
	if n := w.count(`SELECT count(*) FROM events WHERE workspace_id = $1 AND type = 'collab.changed' AND $2 = ANY(user_ids)`, w.wid, w.viewer.UserID); n < 1 {
		t.Fatal("the audience got no collab.changed")
	}

	// Changes at Microsoft: read, moved to Archive (same id), deleted.
	g.markRead("g1")
	g.move("g1", "f-archive")
	g.remove("g3")
	if err := w.s.syncAccount(w.ctx, a.ID); err != nil {
		t.Fatal(err)
	}
	m1 := w.messageByRemote(a, "g1")
	if m1.Unread || len(m1.FolderIDs) != 1 || m1.FolderIDs[0] != archive.ID {
		t.Fatalf("g1 after delta: %+v", m1)
	}
	if n := w.count(`SELECT count(*) FROM collab_messages WHERE account_id = $1 AND remote_id = 'g3'`, a.ID); n != 0 {
		t.Fatal("a deleted message is kept")
	}
	if n := w.count(`SELECT count(*) FROM collab_threads WHERE account_id = $1 AND remote_id = 'c2'`, a.ID); n != 0 {
		t.Fatal("an empty conversation is kept")
	}

	// Actions: inbox moves the archived message back, the sent one stays in Sent.
	w.act(a, []uuid.UUID{c1.ID}, ActionInbox, nil)
	if strings.Join(g.moves, ",") != "g1->f-inbox" {
		t.Fatalf("moves: %v", g.moves)
	}
	if m := w.messageByRemote(a, "g2"); len(m.FolderIDs) != 1 || m.FolderIDs[0] != sent.ID {
		t.Fatalf("the sent copy moved: %+v", m)
	}
	w.act(a, []uuid.UUID{c1.ID}, ActionUnread, nil)
	if len(g.patches) != 1 || !strings.HasPrefix(g.patches[0], "g2:") || !strings.Contains(g.patches[0], `"isRead":false`) {
		t.Fatalf("unread marks the newest: %v", g.patches)
	}
	w.act(a, []uuid.UUID{c1.ID}, ActionStar, nil)
	if !strings.Contains(g.patches[len(g.patches)-1], `"flagStatus":"flagged"`) {
		t.Fatalf("star: %v", g.patches)
	}
	err := w.d.DB.Tx(w.ctx, func(tx pgx.Tx) error { return w.s.applyLocal(w.ctx, tx, a, []uuid.UUID{c1.ID}, ActionLabel, proj) })
	if err != errLabels {
		t.Fatalf("label on Microsoft: %v", err)
	}

	// Send: a draft from the MIME, then sent; the copy keeps the draft's id in Sent Items.
	prov, err := w.s.provider(w.ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	raw := testMail{from: a.Email, to: "frank@example.com", subject: "Re: Order", msgID: "o3@acme.test", inReplyTo: "o2@acme.test", body: "Shipped"}.raw()
	ref, err := prov.Send(w.ctx, raw, SendInfo{From: a.Email, Recipients: []string{"frank@example.com"}, ThreadRemoteID: "c1"})
	if err != nil || ref.RemoteID != "d1" || len(g.sentIDs) != 1 || g.sentIDs[0] != "d1" || len(ref.FolderRemoteIDs) != 1 || ref.FolderRemoteIDs[0] != "f-sent" {
		t.Fatalf("send: %v %+v %v", err, ref, g.sentIDs)
	}
	if !strings.Contains(g.drafts[0], "Message-ID: <o3@acme.test>") {
		t.Fatal("the draft is not the MIME message")
	}
	if _, err := w.s.storeSent(w.ctx, a, raw, ref, w.agent.UserID, &c1.ID); err != nil {
		t.Fatal(err)
	}
	if tr := w.threadByRemote(a, "c1"); tr.MessageCount != 3 || tr.Snippet != "Shipped" {
		t.Fatalf("after send: %+v", tr)
	}
}
