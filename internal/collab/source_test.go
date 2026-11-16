package collab

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/useopendesk/opendesk/internal/mailsource"
)

func TestAPIMessageSource(t *testing.T) {
	w := newWorld(t)
	a := w.account(w.agent, ProviderGoogle, VisibilityPrivate, Audience{})
	_, mid := w.seedThread(a, "Café follow up", w.folder(a, RoleInbox))
	raw := "Received: by mx.google.com\r\nFrom: Jade <jade@ramp.com>\r\nSubject: Cafe follow up\r\n\r\nbody\r\n"
	key := "collab/" + w.wid.String() + "/" + a.ID.String() + "/" + mid.String() + ".eml"
	if err := w.d.Storage.Put(w.ctx, key, bytes.NewReader([]byte(raw)), int64(len(raw)), "message/rfc822"); err != nil {
		t.Fatal(err)
	}
	mustExec(t, w.d, `UPDATE collab_messages SET raw_key = $2 WHERE id = $1`, mid, key)
	path := "/v1/collab/messages/" + mid.String() + "/source"

	var got mailsource.MailSource
	if st := doJSON(t, "GET", w.api(w.agent).URL+path, nil, &got); st != 200 || got.Source != raw || got.SizeBytes != len(raw) || got.Truncated {
		t.Fatalf("source: %d %+v", st, got)
	}
	resp, err := http.Get(w.api(w.agent).URL + path + ".eml")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 || string(b) != raw || resp.Header.Get("Content-Type") != "message/rfc822" || resp.Header.Get("X-Content-Type-Options") != "nosniff" ||
		!strings.HasPrefix(resp.Header.Get("Content-Disposition"), `attachment; filename="`) || !strings.Contains(resp.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("download: %d %q %v", resp.StatusCode, b, resp.Header)
	}
	// A private account's mail is nobody else's, an admin's included.
	var none map[string]any
	if st := doJSON(t, "GET", w.api(w.owner).URL+path, nil, &none); st != 404 {
		t.Fatalf("another member read a private account's source: %d", st)
	}
}
