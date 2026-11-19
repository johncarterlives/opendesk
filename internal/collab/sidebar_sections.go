package collab

import (
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/displayname"
	"github.com/useopendesk/opendesk/internal/helpdesk/hd"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// SidebarSectionIDs are the built-in sidebar sections, in their default order.
var SidebarSectionIDs = []string{"favorites", "inbox", "mail", "teams", "views", "pages", "workspace"}

// BadgeValue reports whether v is one of the numbers a sidebar row can show
// (contracts/collab.md "badges").
func BadgeValue(v string) bool { return badgeValues[v] }

// SidebarItemIDs are the ids of the row kinds with a fixed set, in a member's own sections
// and in Spaces alike; the other row kinds (SidebarUUIDKinds) name a uuid.
var SidebarItemIDs = map[string][]string{
	"ticket_folder": {"unassigned", "mine", "open", "pending", "solved", "spam"},
	"box":           {"inbox", "shared", "assigned", "mentions"},
	"page":          {"contacts", "knowledge", "wiki", "reports"},
}

// SidebarUUIDKinds are the row kinds that name a uuid. A team row may also be "mine" (My teams).
var SidebarUUIDKinds = []string{"team", "view", "account", "folder", "wiki_page", "wiki_space", "mailbox"}

// Limits of a member's own sections, those of a Space (contracts/spaces.md).
const (
	maxOwnSections      = 20
	maxOwnSectionItems  = 60
	maxOwnItems         = 300
	maxOwnTitle         = 40
	maxOwnItemName      = 64
	maxOwnSectionsBytes = 32 << 10
)

var ownSectionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,40}$`)

// validateSections checks the member's own sections and returns their stored form: titles
// and names normalized, uuids canonical. An id of something gone or out of sight is kept;
// the app skips the row, as in a Space.
func validateSections(in []SidebarSection) ([]SidebarSection, error) {
	if len(in) > maxOwnSections {
		return nil, httpx.Validation("The sidebar holds at most 20 sections of your own.")
	}
	out := make([]SidebarSection, 0, len(in))
	ids := map[string]bool{}
	total := 0
	for _, sec := range in {
		if !ownSectionIDRe.MatchString(sec.ID) || ids[sec.ID] {
			return nil, httpx.Validation("Each section needs an id of 1 to 40 letters, digits, dashes or underscores, once.")
		}
		ids[sec.ID] = true
		if utf8.RuneCountInString(displayname.Normalize(sec.Title)) > maxOwnTitle {
			return nil, httpx.Validation("A section's title must be 40 characters or less.")
		}
		title, err := displayname.Validate("A section's title", sec.Title, displayname.Workspace, true)
		if err != nil {
			return nil, err
		}
		if len(sec.Items) > maxOwnSectionItems {
			return nil, httpx.Validation("A section holds at most 60 rows.")
		}
		total += len(sec.Items)
		if total > maxOwnItems {
			return nil, httpx.Validation("Your sections hold at most 300 rows.")
		}
		icon, err := SidebarIcon(sec.Icon)
		if err != nil {
			return nil, err
		}
		o := SidebarSection{ID: sec.ID, Title: title, Collapsed: sec.Collapsed, Icon: icon, Items: make([]SidebarItem, 0, len(sec.Items))}
		for _, it := range sec.Items {
			item, err := validateItem(it)
			if err != nil {
				return nil, err
			}
			o.Items = append(o.Items, item)
		}
		out = append(out, o)
	}
	return out, nil
}

func validateItem(in SidebarItem) (SidebarItem, error) {
	out := SidebarItem{Kind: in.Kind, ID: in.ID, Badge: in.Badge}
	if fixed, ok := SidebarItemIDs[in.Kind]; ok {
		if !slices.Contains(fixed, in.ID) {
			return out, httpx.Validation("Each " + in.Kind + " row needs one of the ids the app knows.")
		}
	} else if slices.Contains(SidebarUUIDKinds, in.Kind) {
		if in.Kind == "team" && in.ID == "mine" {
			// My teams: the member's teams together.
		} else if id, err := uuid.Parse(in.ID); err != nil || len(in.ID) != 36 {
			return out, httpx.Validation("Each " + in.Kind + " row needs an id that is a uuid.")
		} else {
			out.ID = id.String()
		}
	} else {
		return out, httpx.Validation("Each row's kind is ticket_folder, team, view, box, account, folder, page, wiki_page, wiki_space or mailbox.")
	}
	if in.Name != "" {
		if utf8.RuneCountInString(displayname.Normalize(in.Name)) > maxOwnItemName {
			return out, httpx.Validation("A row's name must be 64 characters or less.")
		}
		name, err := displayname.Validate("A row's name", in.Name, displayname.Workspace, false)
		if err != nil {
			return out, err
		}
		out.Name = name
	}
	if out.Badge != "" && !badgeValues[out.Badge] {
		return out, httpx.Validation("A row's number is unread, total, count, awaiting, urgent, overdue, open or none.")
	}
	icon, err := SidebarIcon(in.Icon)
	if err != nil {
		return out, err
	}
	out.Icon = icon
	return out, nil
}

// orderEntryOK checks a sidebar order entry that names a ticket inbox or team shown as a
// section of its own (contracts/collab.md "Inboxes as sections"): mailbox:<uuid>, team:<uuid>
// or team:mine. Other entries are built-in or own section ids, kept as saved.
func orderEntryOK(entry string) bool {
	kind, id, ok := strings.Cut(entry, ":")
	if !ok || (kind != "mailbox" && kind != "team") {
		return true
	}
	if kind == "team" && id == "mine" {
		return true
	}
	_, err := uuid.Parse(id)
	return err == nil && len(id) == 36
}

// SidebarIcon checks the emoji a member's own section or row wears, in their sidebar and in
// their Spaces: one emoji, or "" for none.
func SidebarIcon(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", nil
	}
	if len(s) > 64 || !hd.IsEmoji(s) {
		return "", httpx.Validation("An icon is one emoji.")
	}
	return s, nil
}

// Limits of RowOrder: one list per built-in section, each naming at most maxRowOrder rows.
// Names and Icons hold at most maxLabels entries each.
const (
	maxRowOrder = 300
	maxLabels   = 300
)

// validateLabels checks the member's own names and emoji for sections and rows and returns
// their stored form; an empty name or icon is dropped (the row's own shows again).
func validateLabels(names, icons map[string]string) (map[string]string, map[string]string, error) {
	if len(names) > maxLabels || len(icons) > maxLabels {
		return nil, nil, httpx.Validation("At most 300 sections and rows can have a name or an icon of your own.")
	}
	outNames := map[string]string{}
	for k, v := range names {
		if !sidebarItemOK(k) {
			return nil, nil, httpx.Validation("Each name belongs to a section or row of 1 to 100 characters.")
		}
		if strings.TrimSpace(v) == "" {
			continue
		}
		if utf8.RuneCountInString(displayname.Normalize(v)) > maxOwnItemName {
			return nil, nil, httpx.Validation("A name must be 64 characters or less.")
		}
		name, err := displayname.Validate("A name", v, displayname.Workspace, false)
		if err != nil {
			return nil, nil, err
		}
		outNames[k] = name
	}
	outIcons := map[string]string{}
	for k, v := range icons {
		if !sidebarItemOK(k) {
			return nil, nil, httpx.Validation("Each icon belongs to a section or row of 1 to 100 characters.")
		}
		icon, err := SidebarIcon(v)
		if err != nil {
			return nil, nil, err
		}
		if icon != "" {
			outIcons[k] = icon
		}
	}
	return outNames, outIcons, nil
}

// validateRowOrder checks the member's order of rows inside built-in sections: keys are
// built-in section ids, rows are sidebar ids, each once.
func validateRowOrder(in map[string][]string) error {
	for sec, rows := range in {
		if !slices.Contains(SidebarSectionIDs, sec) {
			return httpx.Validation("Rows can be ordered in the built-in sections only.")
		}
		if len(rows) > maxRowOrder {
			return httpx.Validation("A section's row order names at most 300 rows.")
		}
		seen := map[string]bool{}
		for _, r := range rows {
			if !sidebarItemOK(r) || seen[r] {
				return httpx.Validation("Each row in a section's order is 1 to 100 characters, once.")
			}
			seen[r] = true
		}
	}
	return nil
}
