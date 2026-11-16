// Package mailsource is how a message's raw source (its headers and body as the mail
// server delivered them) is shown and downloaded: Show original in tickets and in Collab.
package mailsource

import (
	"io"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/useopendesk/opendesk/internal/httpx"
)

const (
	// ViewBytes is how much of a source the app shows; the download is the whole message.
	ViewBytes = 1 << 20
	// MaxBytes is the largest raw message opendesk keeps: inbound mail and Collab sync refuse
	// or skip a larger one, so every stored source fits.
	MaxBytes = 30 << 20
)

// TooLarge is the answer for a source over MaxBytes.
func TooLarge() error {
	return httpx.E(http.StatusRequestEntityTooLarge, "too_large", "This message is too large to show its source.")
}

// ReadAll reads a whole source from r for its download.
func ReadAll(r io.Reader) ([]byte, error) {
	raw, err := io.ReadAll(io.LimitReader(r, MaxBytes+1))
	if err != nil {
		return nil, httpx.Wrap(err)
	}
	if len(raw) > MaxBytes {
		return nil, TooLarge()
	}
	return raw, nil
}

// Read is View for a source read from r, keeping only what is shown in memory and counting
// the rest.
func Read(r io.Reader) (MailSource, error) {
	head, err := io.ReadAll(io.LimitReader(r, ViewBytes+1))
	if err != nil {
		return MailSource{}, httpx.Wrap(err)
	}
	rest, err := io.Copy(io.Discard, io.LimitReader(r, MaxBytes+1-int64(len(head))))
	if err != nil {
		return MailSource{}, httpx.Wrap(err)
	}
	size := len(head) + int(rest)
	if size > MaxBytes {
		return MailSource{}, TooLarge()
	}
	out := View(head)
	out.SizeBytes = size
	return out, nil
}

// MailSource is a message's source as the app shows it.
type MailSource struct {
	Source    string `json:"source" doc:"The raw message: its headers, a blank line and its body, as text. Invalid UTF-8 is replaced."`
	SizeBytes int    `json:"size_bytes" doc:"The whole message's size"`
	Truncated bool   `json:"truncated" doc:"Only the first megabyte is shown; the download has all of it"`
}

// View is raw as text for the app: the first ViewBytes of it, cut at a line, with
// anything that isn't valid UTF-8 replaced.
func View(raw []byte) MailSource {
	out := MailSource{SizeBytes: len(raw)}
	if len(raw) > ViewBytes {
		raw, out.Truncated = raw[:ViewBytes], true
		if i := strings.LastIndexByte(string(raw), '\n'); i > 0 {
			raw = raw[:i+1]
		}
	}
	out.Source = strings.ToValidUTF8(string(raw), "�")
	return out
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// Filename names a message's download after its subject: letters, digits and . _ - only,
// 60 characters at most, ending in .eml.
func Filename(subject string) string {
	name := strings.Trim(unsafeName.ReplaceAllString(strings.TrimSpace(subject), "-"), "-._")
	if utf8.RuneCountInString(name) > 60 {
		name = string([]rune(name)[:60])
	}
	if name == "" {
		name = "message"
	}
	return name + ".eml"
}

// File is a source's download: the raw message with headers that make a browser save it,
// never render it, and keep anything inside it from running.
type File struct {
	ContentType        string `header:"Content-Type"`
	ContentDisposition string `header:"Content-Disposition"`
	NoSniff            string `header:"X-Content-Type-Options"`
	CSP                string `header:"Content-Security-Policy"`
	Body               []byte
}

// Download is the response for raw, named after subject.
func Download(raw []byte, subject string) *File {
	return &File{ContentType: "message/rfc822", ContentDisposition: `attachment; filename="` + Filename(subject) + `"`,
		NoSniff: "nosniff", CSP: "default-src 'none'; sandbox", Body: raw}
}
