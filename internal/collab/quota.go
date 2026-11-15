package collab

import (
	"net/http"
	"net/url"
	"strings"
)

// endpoint is what a provider call is, by name (for logs and analytics, never with an id or
// address in it) and by what it costs in the provider's quota.
type endpoint struct {
	name  string
	units int
}

// gmailUnits are the quota units of Gmail's methods (developers.google.com/gmail/api/reference/quota),
// counted against the 250 a second each user has.
var gmailUnits = map[string]int{
	"drafts.create": 10, "drafts.delete": 10, "drafts.get": 1, "drafts.list": 1, "drafts.send": 100, "drafts.update": 15,
	"history.list": 2, "profile": 1,
	"labels.create": 5, "labels.delete": 5, "labels.get": 1, "labels.list": 1, "labels.patch": 5,
	"messages.batchModify": 50, "messages.delete": 10, "messages.get": 5, "messages.list": 5, "messages.modify": 5,
	"messages.send": 100, "messages.trash": 5, "messages.untrash": 5,
	"settings.get": 1, "settings.sendAs.patch": 100, "settings.vacation.update": 5,
	"threads.get": 10, "threads.modify": 10, "threads.trash": 10, "threads.untrash": 10,
	"watch": 100, "stop": 50,
}

// endpointOf names a call of the provider's and prices it. Microsoft Graph counts requests,
// so each of its calls is one unit.
func endpointOf(provider, method, rawURL string) endpoint {
	u, err := url.Parse(rawURL)
	if err != nil {
		return endpoint{name: "other", units: 1}
	}
	if provider != ProviderGoogle {
		return endpoint{name: "graph." + strings.ToLower(method), units: 1}
	}
	name := gmailMethod(method, u.Path)
	units, ok := gmailUnits[name]
	if !ok {
		return endpoint{name: "other", units: 5}
	}
	if f := u.Query().Get("format"); f != "" && strings.HasSuffix(name, ".get") {
		name += "." + strings.ToLower(safeCode(f)) // messages.get.raw: a read's format costs alike
	}
	return endpoint{name: name, units: units}
}

// gmailMethod is the Gmail API method a request calls: "messages.get" for GET
// /gmail/v1/users/me/messages/{id}.
func gmailMethod(method, path string) string {
	path = strings.TrimPrefix(path, "/upload")
	path = strings.TrimPrefix(path, "/gmail/v1/users/me")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if path == "" || parts[0] == "" {
		return "other"
	}
	if parts[0] == "profile" || parts[0] == "watch" || parts[0] == "stop" {
		return parts[0]
	}
	if parts[0] == "settings" {
		switch {
		case method == http.MethodGet:
			return "settings.get"
		case len(parts) > 1 && parts[1] == "sendAs":
			return "settings.sendAs.patch"
		default:
			return "settings.vacation.update"
		}
	}
	resource := parts[0]
	switch len(parts) {
	case 1:
		if method == http.MethodGet {
			return resource + ".list"
		}
		return resource + ".create"
	case 2:
		switch {
		case method == http.MethodGet:
			return resource + ".get"
		case method == http.MethodDelete:
			return resource + ".delete"
		case parts[1] == "batchModify" || parts[1] == "send":
			return resource + "." + parts[1]
		case method == http.MethodPut:
			return resource + ".update"
		}
		return resource + ".patch"
	}
	return resource + "." + parts[2] // messages/{id}/modify, threads/{id}/trash
}
