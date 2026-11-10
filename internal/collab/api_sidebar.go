package collab

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/httpx"
	"github.com/useopendesk/opendesk/internal/products"
)

// maxSidebarBytes bounds the stored sidebar preferences, the member's own sections
// (maxOwnSectionsBytes) and row order (maxRowOrderBytes) apart.
const (
	maxSidebarBytes  = 16 << 10
	maxRowOrderBytes = 16 << 10
	maxLabelsBytes   = 48 << 10
)

// maxSidebarItem bounds one id in the sidebar preferences ("folder:<uuid>" and the like).
const maxSidebarItem = 100

// maxSidebarBadges bounds the chosen numbers; maxMailTabs the folder bar's tabs; maxPins Favorites.
const (
	maxSidebarBadges = 300
	maxMailTabs      = 30
	maxPins          = 30
)

// defaultMailTabs is the folder bar of a member who never arranged it.
func defaultMailTabs() []string { return []string{"inbox", "starred", "sent", "drafts", "archive"} }

// tabBoxes are the boxes the folder bar can show as tabs.
var tabBoxes = map[string]bool{"inbox": true, "unread": true, "starred": true, "sent": true, "drafts": true,
	"archive": true, "spam": true, "trash": true, "all": true}

// badgePrefixes are the row kinds a number can be chosen for; badgeSections the sections with a default;
// badgeValues the numbers: unread and total for mail rows, count, awaiting, urgent and overdue for ticket
// rows, open for team rows, none for any. A row reads a value it has no such number for as its default.
var (
	badgePrefixes = []string{"box:", "account:", "folder:", "ticket_folder:", "view:", "team:"}
	badgeSections = map[string]bool{"mail": true, "inbox": true, "teams": true, "views": true, "favorites": true}
	badgeValues   = map[string]bool{"unread": true, "total": true, "none": true, "count": true,
		"awaiting": true, "urgent": true, "overdue": true, "open": true}
)

// defaultSidebar is the sidebar of a member who never arranged it.
func defaultSidebar() SidebarPrefs {
	return SidebarPrefs{Order: slices.Clone(SidebarSectionIDs), Hidden: []string{},
		Pinned: []SidebarPin{}, ExpandedAccounts: []string{}, MarkReadOnOpen: true, UnifiedInbox: true,
		Badges: map[string]string{}, MailTabs: defaultMailTabs(), AutoPins: []string{}, Sections: []SidebarSection{},
		RowOrder: map[string][]string{}, Names: map[string]string{}, Icons: map[string]string{}, ShowWaitingChats: new(bool)}
}

// normalized fills missing lists so the shape always has arrays.
func (p SidebarPrefs) normalized() SidebarPrefs {
	if p.Order == nil {
		p.Order = defaultSidebar().Order
	}
	if p.Hidden == nil {
		p.Hidden = []string{}
	}
	if p.Pinned == nil {
		p.Pinned = []SidebarPin{}
	}
	if p.ExpandedAccounts == nil {
		p.ExpandedAccounts = []string{}
	}
	if p.Badges == nil {
		p.Badges = map[string]string{}
	}
	if p.MailTabs == nil {
		p.MailTabs = defaultMailTabs()
	}
	if p.AutoPins == nil {
		p.AutoPins = []string{}
	}
	if p.Sections == nil {
		p.Sections = []SidebarSection{}
	}
	if p.RowOrder == nil {
		p.RowOrder = map[string][]string{}
	}
	if p.Names == nil {
		p.Names = map[string]string{}
	}
	if p.Icons == nil {
		p.Icons = map[string]string{}
	}
	if p.ShowWaitingChats == nil {
		p.ShowWaitingChats = new(bool)
	}
	for i := range p.Sections {
		if p.Sections[i].Items == nil {
			p.Sections[i].Items = []SidebarItem{}
		}
	}
	return p
}

// badgeKeyOK accepts a row id with a known prefix or a section with a default.
func badgeKeyOK(k string) bool {
	if !sidebarItemOK(k) {
		return false
	}
	if sec, ok := strings.CutPrefix(k, "section:"); ok {
		return badgeSections[sec]
	}
	for _, pre := range badgePrefixes {
		if rest, ok := strings.CutPrefix(k, pre); ok && rest != "" {
			return true
		}
	}
	return false
}

// mailTabOK accepts a box name or "folder:<uuid>".
func mailTabOK(t string) bool {
	if tabBoxes[t] {
		return true
	}
	id, ok := strings.CutPrefix(t, "folder:")
	if !ok {
		return false
	}
	_, err := uuid.Parse(id)
	return err == nil && len(id) == 36
}

// validateSidebar checks the chosen numbers and tabs; the other lists are checked by item.
func validateSidebar(p SidebarPrefs) error {
	if len(p.Badges) > maxSidebarBadges {
		return httpx.Validation("Numbers can be chosen for at most 300 rows.")
	}
	for k, v := range p.Badges {
		if !badgeKeyOK(k) || !badgeValues[v] {
			return httpx.Validation("Each number choice names a sidebar row or section and is unread, total, count or none.")
		}
	}
	for _, id := range p.Order {
		if !orderEntryOK(id) {
			return httpx.Validation("A ticket inbox or team shown as its own section is named by its id.")
		}
	}
	if len(p.MailTabs) > maxMailTabs {
		return httpx.Validation("The folder bar holds at most 30 tabs.")
	}
	seen := map[string]bool{}
	for _, t := range p.MailTabs {
		if !mailTabOK(t) || seen[t] {
			return httpx.Validation("Each tab is a box (inbox, unread, starred, sent, drafts, archive, spam, trash, all) or a folder, once.")
		}
		seen[t] = true
	}
	return nil
}

// loadSidebar reads the member's saved preferences, or the defaults.
func (s *service) loadSidebar(ctx context.Context, wid, uid uuid.UUID) (SidebarPrefs, error) {
	var raw []byte
	err := s.d.DB.Pool.QueryRow(ctx, `SELECT prefs FROM collab_sidebar_prefs WHERE workspace_id = $1 AND user_id = $2`,
		wid, uid).Scan(&raw)
	if db.IsNotFound(err) {
		return defaultSidebar(), nil
	}
	if err != nil {
		return SidebarPrefs{}, err
	}
	var stored SidebarPrefs
	if json.Unmarshal(raw, &stored) != nil {
		return defaultSidebar(), nil
	}
	return stored.normalized(), nil
}

type sidebarBody struct {
	Body SidebarPrefs
}

func (s *service) registerSidebarRoutes(api huma.API) {
	collabOp(api, huma.Operation{OperationID: "get-collab-sidebar", Method: http.MethodGet, Path: "/v1/collab/sidebar",
		Summary: "Get my sidebar"},
		func(ctx context.Context, _ *struct{}) (*sidebarBody, error) {
			// Every member arranges their sidebar, with or without Collab.
			p, err := s.member(ctx, auth.RoleViewer)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out, err := s.loadSidebar(ctx, p.WorkspaceID, p.UserID)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			out, err = s.pinAllInboxes(ctx, p.WorkspaceID, p.UserID, out)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &sidebarBody{out}, nil
		})

	collabOp(api, huma.Operation{OperationID: "put-collab-sidebar", Method: http.MethodPut, Path: "/v1/collab/sidebar",
		Summary: "Save my sidebar"},
		func(ctx context.Context, in *sidebarBody) (*sidebarBody, error) {
			// Every member arranges their sidebar, with or without Collab.
			p, err := s.member(ctx, auth.RoleViewer)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			// A client that does not know the numbers, the tabs, the pins added by themselves,
			// the member's own sections, their row order, names, icons or the waiting chats row
			// leaves them as saved.
			if in.Body.Badges == nil || in.Body.MailTabs == nil || in.Body.AutoPins == nil || in.Body.Sections == nil || in.Body.RowOrder == nil || in.Body.Names == nil || in.Body.Icons == nil || in.Body.ShowWaitingChats == nil {
				saved, err := s.loadSidebar(ctx, p.WorkspaceID, p.UserID)
				if err != nil {
					return nil, httpx.Wrap(err)
				}
				if in.Body.Badges == nil {
					in.Body.Badges = saved.Badges
				}
				if in.Body.MailTabs == nil {
					in.Body.MailTabs = saved.MailTabs
				}
				if in.Body.AutoPins == nil {
					in.Body.AutoPins = saved.AutoPins
				}
				if in.Body.Sections == nil {
					in.Body.Sections = saved.Sections
				}
				if in.Body.RowOrder == nil {
					in.Body.RowOrder = saved.RowOrder
				}
				if in.Body.Names == nil {
					in.Body.Names = saved.Names
				}
				if in.Body.Icons == nil {
					in.Body.Icons = saved.Icons
				}
				if in.Body.ShowWaitingChats == nil {
					in.Body.ShowWaitingChats = saved.ShowWaitingChats
				}
			}
			prefs := in.Body.normalized()
			if err := validateSidebar(prefs); err != nil {
				return nil, err
			}
			if err := validateRowOrder(prefs.RowOrder); err != nil {
				return nil, err
			}
			if prefs.Names, prefs.Icons, err = validateLabels(prefs.Names, prefs.Icons); err != nil {
				return nil, httpx.Wrap(err)
			}
			if prefs.Sections, err = validateSections(prefs.Sections); err != nil {
				return nil, httpx.Wrap(err)
			}
			own, err := json.Marshal(prefs.Sections)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if len(own) > maxOwnSectionsBytes {
				return nil, httpx.Validation("Your sections are too large.")
			}
			for _, list := range [][]string{prefs.Order, prefs.Hidden, prefs.ExpandedAccounts, prefs.AutoPins} {
				for _, item := range list {
					if !sidebarItemOK(item) {
						return nil, httpx.Validation("Each sidebar item is 1 to 100 characters.")
					}
				}
			}
			for _, pin := range prefs.Pinned {
				if !sidebarItemOK(pin.ID) {
					return nil, httpx.Validation("Each sidebar item is 1 to 100 characters.")
				}
			}
			order, err := json.Marshal(prefs.RowOrder)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if len(order) > maxRowOrderBytes {
				return nil, httpx.Validation("Your row order is too large.")
			}
			labels, err := json.Marshal([]any{prefs.Names, prefs.Icons})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if len(labels) > maxLabelsBytes {
				return nil, httpx.Validation("Your names and icons are too large.")
			}
			raw, err := json.Marshal(prefs)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			if len(raw)-len(own)-len(order)-len(labels) > maxSidebarBytes {
				return nil, httpx.Validation("The sidebar settings are too large.")
			}
			// The member's other tabs and devices follow (contracts/collab.md "Events").
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if err := saveSidebar(ctx, tx, p.WorkspaceID, p.UserID, raw); err != nil {
					return err
				}
				_, err := events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: EventSidebar, Users: []uuid.UUID{p.UserID},
					Data: map[string]any{}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return &sidebarBody{prefs}, nil
		})
}

func saveSidebar(ctx context.Context, q db.Querier, wid, uid uuid.UUID, raw []byte) error {
	_, err := q.Exec(ctx, `INSERT INTO collab_sidebar_prefs (workspace_id, user_id, prefs, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (workspace_id, user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`, wid, uid, raw)
	return err
}

// autoPinAllInboxes is All inboxes' entry in SidebarPrefs.AutoPins.
const autoPinAllInboxes = "box:inbox"

// pinAllInboxes pins All inboxes to the top of Favorites once, when the member first sees
// two accounts, unless they turned it off, hid it or pinned it already. It is remembered in
// AutoPins either way, so All inboxes unpinned afterwards stays unpinned. Mail is Collab's:
// without Collab it reads no accounts and records nothing, so the pin waits for Collab.
func (s *service) pinAllInboxes(ctx context.Context, wid, uid uuid.UUID, prefs SidebarPrefs) (SidebarPrefs, error) {
	if slices.Contains(prefs.AutoPins, autoPinAllInboxes) {
		return prefs, nil
	}
	if err := products.RequireMail(ctx, s.d.DB.Pool, s.d.Plan, s.d.Cfg.Collab, wid); err != nil {
		var disabled *products.DisabledError
		if errors.As(err, &disabled) {
			return prefs, nil
		}
		return prefs, err
	}
	var n int
	if err := s.d.DB.Pool.QueryRow(ctx, `SELECT count(*) FROM collab_accounts a WHERE a.workspace_id = $1 AND `+AccountVisibleSQL("a", "$2"),
		wid, uid).Scan(&n); err != nil || n < 2 {
		return prefs, err
	}
	pin := SidebarPin{Kind: "box", ID: "inbox"}
	if prefs.UnifiedInbox && !slices.Contains(prefs.Hidden, autoPinAllInboxes) && !slices.Contains(prefs.Pinned, pin) &&
		len(prefs.Pinned) < maxPins {
		prefs.Pinned = append([]SidebarPin{pin}, prefs.Pinned...)
	}
	prefs.AutoPins = append(slices.Clone(prefs.AutoPins), autoPinAllInboxes)
	raw, err := json.Marshal(prefs)
	if err != nil {
		return prefs, err
	}
	return prefs, saveSidebar(ctx, s.d.DB.Pool, wid, uid, raw)
}

func sidebarItemOK(s string) bool {
	if s == "" || len(s) > maxSidebarItem {
		return false
	}
	return !strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r == 0x7f })
}
