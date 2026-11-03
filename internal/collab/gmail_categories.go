package collab

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/useopendesk/opendesk/internal/db"
)

type gmailCategoryDefinition struct {
	MailCategory
	Label string
}

var gmailCategoryCatalog = []gmailCategoryDefinition{
	{MailCategory: MailCategory{Key: "primary", Name: "Primary", Color: "gray"}, Label: "CATEGORY_PERSONAL"},
	{MailCategory: MailCategory{Key: "social", Name: "Social", Color: "teal"}, Label: "CATEGORY_SOCIAL"},
	{MailCategory: MailCategory{Key: "promotions", Name: "Promotions", Color: "amber"}, Label: "CATEGORY_PROMOTIONS"},
	{MailCategory: MailCategory{Key: "updates", Name: "Updates", Color: "blue"}, Label: "CATEGORY_UPDATES"},
	{MailCategory: MailCategory{Key: "forums", Name: "Forums", Color: "violet"}, Label: "CATEGORY_FORUMS"},
}

func gmailCategories() []MailCategory {
	out := make([]MailCategory, 0, len(gmailCategoryCatalog))
	for _, c := range gmailCategoryCatalog {
		out = append(out, c.MailCategory)
	}
	return out
}

func gmailCategoryBit(key string) int {
	for i, c := range gmailCategoryCatalog {
		if c.Key == key {
			return 1 << i
		}
	}
	return 0
}

type gmailCategoryObservation struct {
	Mask    int
	Version string
}

func gmailObservation(m *gmailMessage) (*gmailCategoryObservation, error) {
	v := m.HistoryID
	if v == "" {
		return nil, fmt.Errorf("Gmail metadata omitted its history version")
	}
	for _, r := range v {
		if r < '0' || r > '9' {
			return nil, fmt.Errorf("Gmail metadata has an invalid history version")
		}
	}
	// Keep arbitrary precision, including versions above uint64.
	v = strings.TrimLeft(v, "0")
	if v == "" {
		v = "0"
	}
	mask := 0
	for i, c := range gmailCategoryCatalog {
		if slices.Contains(m.LabelIDs, c.Label) {
			mask |= 1 << i
		}
	}
	return &gmailCategoryObservation{Mask: mask, Version: v}, nil
}

func (p *pass) observeGmailCategory(ctx context.Context, tx pgx.Tx, m *storedMsg, ob *gmailCategoryObservation) (bool, error) {
	if ob == nil {
		return true, nil
	}
	tag, err := tx.Exec(ctx, `UPDATE collab_messages SET gmail_category_mask = $4, gmail_category_version = $5::numeric
        WHERE workspace_id = $1 AND account_id = $2 AND id = $3
        AND (gmail_category_version IS NULL OR gmail_category_version <= $5::numeric)`, p.a.WorkspaceID, p.a.ID, m.ID, ob.Mask, ob.Version)
	if err == nil && tag.RowsAffected() > 0 {
		p.touch(m.ThreadID)
	}
	return tag.RowsAffected() > 0, err
}

// Projection uses the newest non-draft inbox message, otherwise the newest received message.
// Unknown and known-empty observations display Primary; their stored facts stay distinct.
func projectGmailCategories(ctx context.Context, q db.Querier, a *accountRow, tids []uuid.UUID) error {
	cs, err := loadAccountCategorySets(ctx, q, a)
	if err != nil || cs.resolve(a).Engine != modeGmail {
		return err
	}
	projection := "CASE"
	for i, c := range gmailCategoryCatalog {
		projection += fmt.Sprintf(" WHEN m.gmail_category_mask & %d <> 0 THEN '%s'", 1<<i, c.Key)
	}
	projection += " ELSE 'primary' END"
	_, err = q.Exec(ctx, `UPDATE collab_threads t SET category = COALESCE(
        (SELECT i.desired FROM collab_category_intents i JOIN collab_accounts a ON a.id = i.account_id
         WHERE i.thread_id = t.id AND i.epoch = a.category_epoch AND i.state IN ('pending','confirming','blocked')),
        (SELECT `+projection+`
         FROM collab_messages m WHERE m.thread_id = t.id AND NOT m.draft
         AND (EXISTS (SELECT 1 FROM collab_message_folders mf JOIN collab_folders f ON f.id = mf.folder_id
             WHERE mf.message_id = m.id AND f.role = 'inbox')
             OR (m.sent_by IS NULL AND NOT EXISTS (SELECT 1 FROM collab_message_folders mf JOIN collab_folders f ON f.id = mf.folder_id
                 WHERE mf.message_id = m.id AND f.role = 'sent')))
         ORDER BY EXISTS (SELECT 1 FROM collab_message_folders mf JOIN collab_folders f ON f.id = mf.folder_id
             WHERE mf.message_id = m.id AND f.role = 'inbox') DESC, m.sent_at DESC, m.remote_id DESC LIMIT 1), 'primary'),
        category_source = 'gmail', category_pending = false
        WHERE t.workspace_id = $1 AND t.account_id = $2 AND ($3::uuid[] IS NULL OR t.id = ANY($3))`, a.WorkspaceID, a.ID, tids)
	return err
}

// A private ApplyOp variant cannot be constructed by an API request or another provider.
type gmailCategoryChange struct {
	Thread   string
	Messages []gmailMessage
	Key      string
	current  func(context.Context) error
}

func (g *gmailProvider) applyCategory(ctx context.Context, c *gmailCategoryChange) error {
	if c.Thread == "" || gmailCategoryBit(c.Key) == 0 {
		return &providerError{msg: "Choose a Gmail category.", permanent: true}
	}
	add, remove := []string{}, []string{}
	for _, def := range gmailCategoryCatalog {
		if def.Key == c.Key {
			add = append(add, def.Label)
		} else {
			remove = append(remove, def.Label)
		}
	}
	ids := make([]string, 0, len(c.Messages))
	for _, m := range c.Messages {
		if !slices.Contains(m.LabelIDs, "DRAFT") {
			ids = append(ids, m.ID)
		}
	}
	for batch := range slices.Chunk(ids, 1000) {
		body, err := json.Marshal(map[string]any{"ids": batch, "addLabelIds": add, "removeLabelIds": remove})
		if err != nil {
			return err
		}
		if _, err := g.s.call(ctx, g.a, "Gmail", restRequest{method: http.MethodPost, url: g.url("/messages/batchModify"), body: body, contentType: "application/json", beforeRequest: c.current}); err != nil {
			return err
		}
	}
	return nil
}
