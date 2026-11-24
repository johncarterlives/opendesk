package mcpserver

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/netsafe"
)

// maxInlineFile bounds a file sent inline as base64: its encoding has to fit the MCP
// request body (maxRequestBody) with room for the rest of the call.
const maxInlineFile = 6 << 20

// fetchHops bounds the redirects a file URL may take.
const fetchHops = 3

func fileTools() []*tool {
	return []*tool{
		{
			Name: "upload_attachment", Title: "Upload a file", Scopes: []string{auth.ScopeTicketsWrite}, OpenWorld: true,
			Description: "Upload a file to attach to a message: pass its https url for the server to download (up to 25 MB), or its bytes as " +
				"content_base64 (up to 6 MB). Returns attachment_id, for attachment_ids on create_ticket, reply_to_ticket or add_note. " +
				"Executables and scripts are refused. A file no message uses is deleted after 24 hours.",
			Schema: obj(map[string]any{
				"filename":       strN("The file's name with its extension, such as quote.pdf. Taken from the URL when left out.", 1, 200),
				"url":            strN("An https URL of the file on the public internet.", 8, 2000),
				"content_base64": str("The file's bytes, base64 encoded."),
			}),
			Run: uploadAttachment,
		},
	}
}

type outAttachment struct {
	AttachmentID string `json:"attachment_id"`
	Filename     string `json:"filename"`
	ContentType  string `json:"content_type"`
	SizeBytes    int64  `json:"size_bytes"`
}

func uploadAttachment(ctx context.Context, c *caller, raw json.RawMessage) (any, error) {
	a, err := decode[struct {
		Filename      string `json:"filename"`
		URL           string `json:"url"`
		ContentBase64 string `json:"content_base64"`
	}](raw)
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(a.Filename)
	var data []byte
	switch {
	case (a.URL == "") == (a.ContentBase64 == ""):
		return nil, invalid("pass either url or content_base64")
	case a.ContentBase64 != "":
		if name == "" {
			return nil, invalid("filename is required with content_base64")
		}
		if base64.StdEncoding.DecodedLen(len(a.ContentBase64)) > maxInlineFile+3 {
			return nil, invalid("content_base64 can hold at most 6 MB; pass a url for a larger file")
		}
		data, err = base64.StdEncoding.DecodeString(strings.TrimSpace(a.ContentBase64))
		if err != nil {
			return nil, invalid("content_base64 is not valid base64")
		}
	default:
		var fetched string
		data, fetched, err = c.files.fetch(ctx, a.URL)
		if err != nil {
			return nil, err
		}
		if name == "" {
			name = fetched
		}
	}
	if len(data) == 0 {
		return nil, invalid("the file is empty")
	}
	name = cleanFilename(name)
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", name)
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(data); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	resp, err := c.send(ctx, http.MethodPost, "/v1/attachments", nil, w.FormDataContentType(), body.Bytes())
	if err != nil {
		return nil, err
	}
	var at struct {
		ID          string `json:"id"`
		Filename    string `json:"filename"`
		ContentType string `json:"content_type"`
		SizeBytes   int64  `json:"size_bytes"`
	}
	if err := json.Unmarshal(resp, &at); err != nil {
		return nil, err
	}
	return outAttachment{AttachmentID: at.ID, Filename: at.Filename, ContentType: at.ContentType, SizeBytes: at.SizeBytes}, nil
}

// cleanFilename keeps a name's last path element, without control characters, at most
// 200 characters; "file" when nothing is left.
func cleanFilename(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(path.Base(strings.ReplaceAll(name, "\\", "/")))
	if name == "" || name == "." || name == "/" {
		return "file"
	}
	if utf8.RuneCountInString(name) > 200 {
		r := []rune(name)
		name = string(r[len(r)-200:])
	}
	return name
}

// fileFetcher downloads a file a tool names by URL, through the SSRF guard: https only,
// public addresses only (re-checked at connect and on every redirect).
type fileFetcher struct {
	guard  netsafe.Guard
	client *http.Client
}

func newFileFetcher(dev bool) *fileFetcher {
	return &fileFetcher{guard: netsafe.Guard{Dev: dev}, client: netsafe.Client(dev, 60*time.Second)}
}

// fetch returns the file at raw, up to hd.MaxAttachmentBytes, and a filename for it.
func (f *fileFetcher) fetch(ctx context.Context, raw string) ([]byte, string, error) {
	target := strings.TrimSpace(raw)
	for range fetchHops + 1 {
		u, err := f.guard.ValidateURL(ctx, target)
		if err != nil {
			return nil, "", invalid("url: " + err.Error())
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, "", invalid("url is not valid")
		}
		req.Header.Set("User-Agent", "opendesk")
		resp, err := f.client.Do(req)
		if err != nil {
			return nil, "", invalid("the file could not be downloaded from that url")
		}
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			loc, lerr := resp.Location()
			_ = resp.Body.Close()
			if lerr != nil {
				return nil, "", invalid("the url redirects nowhere")
			}
			target = loc.String()
			continue
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, "", invalid("the url answered " + resp.Status + " instead of the file")
		}
		if resp.ContentLength > hd.MaxAttachmentBytes {
			return nil, "", invalid("the file is larger than 25 MB")
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, hd.MaxAttachmentBytes+1))
		if err != nil {
			return nil, "", invalid("the file could not be downloaded from that url")
		}
		if len(data) > hd.MaxAttachmentBytes {
			return nil, "", invalid("the file is larger than 25 MB")
		}
		return data, fetchedName(resp, u), nil
	}
	return nil, "", invalid("the url redirects too many times")
}

// fetchedName is the name the server gave a download, else its URL's last path element.
func fetchedName(resp *http.Response, raw string) string {
	if _, params, err := mime.ParseMediaType(resp.Header.Get("Content-Disposition")); err == nil && params["filename"] != "" {
		return params["filename"]
	}
	if u, err := url.Parse(raw); err == nil {
		if base := path.Base(u.Path); base != "" && base != "/" && base != "." {
			return base
		}
	}
	return "file"
}
