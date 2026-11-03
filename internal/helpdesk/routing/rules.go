package routing

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/domain"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// RoutingRule is a routing rule (contracts/teams.md RoutingRule).
type RoutingRule struct {
	ID         uuid.UUID          `json:"id"`
	Name       string             `json:"name"`
	Enabled    bool               `json:"enabled"`
	Position   int                `json:"position"`
	RunCount   int64              `json:"run_count"`
	Match      string             `json:"match" enum:"all,any"`
	Conditions []RoutingCondition `json:"conditions"`
	TeamID     uuid.UUID          `json:"team_id"`
	SkillIDs   []uuid.UUID        `json:"skill_ids"`
	CreatedAt  time.Time          `json:"created_at"`
	UpdatedAt  time.Time          `json:"updated_at"`
}

// RoutingCondition is one test of a rule (contracts/teams.md RoutingCondition).
type RoutingCondition struct {
	Field string `json:"field" maxLength:"80" doc:"received_at, mailbox_id, brand_id, widget_id, channel, from_email, from_domain, subject, body, page_url, topic, contact.field.<key> or ai_decide"`
	Op    string `json:"op" maxLength:"20" doc:"equals, not_equals, contains, not_contains, starts_with; gt or lt for ai_decide; contact fields take the ops of their type"`
	Value string `json:"value" maxLength:"500"`
	// Question is the yes/no question of an ai_decide condition.
	Question string `json:"question,omitempty" maxLength:"300" doc:"ai_decide only: a yes/no question about the message"`
}

const (
	MatchAll = "all"
	MatchAny = "any"

	FieldAIDecide      = "ai_decide"
	contactFieldPrefix = "contact.field."

	// MaxRules bounds the routing rules of a workspace (contracts/teams.md "Limits").
	MaxRules      = 200
	MaxConditions = 20
	maxAIDecide   = 3
	maxNameRunes  = 80
	maxValueRunes = 500
)

// Fields and ops of plain conditions.
var (
	textFields = []string{"received_at", "mailbox_id", "brand_id", "widget_id", "channel", "from_email", "from_domain",
		"subject", "body", "page_url", "topic"}
	textOps = []string{"equals", "not_equals", "contains", "not_contains", "starts_with"}
	// idFields name a row of the workspace and compare exactly.
	idFields = map[string]string{"mailbox_id": "mailboxes", "brand_id": "brands", "widget_id": "widgets"}
)

const ruleSelect = `SELECT r.id, r.name, r.enabled, r.position, r.run_count, r.match, r.conditions, r.team_id,
	ARRAY(SELECT rs.skill_id FROM routing_rule_skills rs WHERE rs.workspace_id = r.workspace_id AND rs.routing_rule_id = r.id ORDER BY rs.skill_id),
	r.created_at, r.updated_at FROM routing_rules r`

func scanRule(row pgx.Row) (RoutingRule, error) {
	var r RoutingRule
	var conds []byte
	if err := row.Scan(&r.ID, &r.Name, &r.Enabled, &r.Position, &r.RunCount, &r.Match, &conds, &r.TeamID, &r.SkillIDs, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return r, err
	}
	if err := json.Unmarshal(conds, &r.Conditions); err != nil || r.Conditions == nil {
		r.Conditions = []RoutingCondition{}
	}
	if r.SkillIDs == nil {
		r.SkillIDs = []uuid.UUID{}
	}
	return r, nil
}

func loadRule(ctx context.Context, q db.Querier, wid, id uuid.UUID, lock bool) (RoutingRule, error) {
	sql := ruleSelect + ` WHERE r.workspace_id = $1 AND r.id = $2`
	if lock {
		sql += ` FOR UPDATE NOWAIT`
	}
	return scanRule(q.QueryRow(ctx, sql, wid, id))
}

func normalizeSkillIDs(raw []string) ([]uuid.UUID, error) {
	ids := make([]uuid.UUID, 0, len(raw))
	for _, value := range raw {
		id, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil {
			return nil, httpx.Validation("skill_ids must contain valid skill ids")
		}
		ids = append(ids, id)
	}
	slices.SortFunc(ids, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	for i := 1; i < len(ids); i++ {
		if ids[i] == ids[i-1] {
			return nil, httpx.Validation("skill_ids must not repeat")
		}
	}
	return ids, nil
}

// validateRuleSkillIDs locks the workspace, then referenced skills in ID order. This
// matches catalog writes, so archiving and rule edits cannot deadlock or race.
func validateRuleSkillIDs(ctx context.Context, tx pgx.Tx, wid uuid.UUID, ids []uuid.UUID) error {
	if _, err := tx.Exec(ctx, `SELECT 1 FROM workspaces WHERE id = $1 FOR NO KEY UPDATE`, wid); err != nil {
		return err
	}
	for _, id := range ids {
		var archived bool
		err := tx.QueryRow(ctx, `SELECT archived FROM skills WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, wid, id).Scan(&archived)
		if db.IsNotFound(err) {
			return httpx.Validation("skill_ids must reference skills in this workspace")
		}
		if err != nil {
			return err
		}
		if archived {
			return httpx.Validation("archived skills cannot be required by a routing rule")
		}
	}
	return nil
}

func replaceRuleSkills(ctx context.Context, tx pgx.Tx, wid, ruleID uuid.UUID, ids []uuid.UUID) error {
	if _, err := tx.Exec(ctx, `DELETE FROM routing_rule_skills WHERE workspace_id = $1 AND routing_rule_id = $2`, wid, ruleID); err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO routing_rule_skills(workspace_id, routing_rule_id, skill_id)
		SELECT $1, $2, unnest($3::uuid[])`, wid, ruleID, ids)
	return err
}

func loadSkills(ctx context.Context, q db.Querier, wid uuid.UUID, ids []uuid.UUID) ([]Skill, error) {
	if len(ids) == 0 {
		return []Skill{}, nil
	}
	rows, err := q.Query(ctx, skillSelect+` WHERE s.workspace_id = $1 AND s.id = ANY($2) ORDER BY s.id`, wid, ids)
	if err != nil {
		return nil, err
	}
	skills, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Skill, error) { return scanSkill(r) })
	if err != nil {
		return nil, err
	}
	return skills, nil
}

// cleanName trims a rule name: 1..80 runes, single-spaced, no control characters or markup.
func cleanName(s string) (string, error) {
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return "", httpx.Validation("name is required")
	}
	if utf8.RuneCountInString(s) > maxNameRunes {
		return "", httpx.Validation("name must be 80 characters or less")
	}
	if strings.ContainsAny(s, "<>") || strings.IndexFunc(s, unicode.IsControl) >= 0 {
		return "", httpx.Validation("name contains characters that are not allowed")
	}
	return s, nil
}

// ValidateConditions checks a rule's conditions against the enums and the workspace, and
// returns them normalized.
func ValidateConditions(ctx context.Context, q db.Querier, wid uuid.UUID, cs []RoutingCondition) ([]RoutingCondition, error) {
	if len(cs) == 0 {
		return nil, httpx.Validation("a routing rule needs at least one condition")
	}
	if len(cs) > MaxConditions {
		return nil, httpx.Validation("a routing rule can have at most 20 conditions")
	}
	out := make([]RoutingCondition, 0, len(cs))
	var defs domain.FieldDefs
	decides := 0
	for _, c := range cs {
		c.Field, c.Op = strings.TrimSpace(c.Field), strings.TrimSpace(c.Op)
		switch {
		case c.Field == FieldAIDecide:
			if decides++; decides > maxAIDecide {
				return nil, httpx.Validation("a routing rule can have at most 3 ai_decide conditions")
			}
			v, err := validDecide(c)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
			continue
		case strings.HasPrefix(c.Field, contactFieldPrefix):
			key := strings.TrimPrefix(c.Field, contactFieldPrefix)
			if defs == nil {
				d, err := domain.LoadFieldDefs(ctx, q, wid, domain.FieldEntityContact)
				if err != nil {
					return nil, err
				}
				defs = d
			}
			f, ok := defs[key]
			if !ok {
				return nil, httpx.Validation(fmt.Sprintf("condition field %q is not a custom field of contacts", truncate(c.Field, 60)))
			}
			v, err := domain.CheckFieldOperand(f, domain.NormalizeOp(c.Op), c.Value, false)
			if err != nil {
				return nil, err
			}
			c.Op, c.Value, c.Question = domain.NormalizeOp(c.Op), v, ""
			out = append(out, c)
			continue
		}
		c.Question = ""
		if !slices.Contains(textFields, c.Field) {
			return nil, httpx.Validation("condition field must be one of " + strings.Join(textFields, ", ") + ", contact.field.<key> or ai_decide")
		}
		if !slices.Contains(textOps, c.Op) {
			return nil, httpx.Validation("condition op must be one of " + strings.Join(textOps, ", "))
		}
		c.Value = strings.TrimSpace(c.Value)
		if utf8.RuneCountInString(c.Value) > maxValueRunes {
			return nil, httpx.Validation("condition values must be 500 characters or less")
		}
		if strings.IndexFunc(c.Value, unicode.IsControl) >= 0 {
			return nil, httpx.Validation("condition values cannot contain control characters")
		}
		exact := c.Op == "equals" || c.Op == "not_equals"
		if c.Value == "" && !exact {
			return nil, httpx.Validation(c.Op + " needs a value")
		}
		switch c.Field {
		case "channel":
			if exact && !slices.Contains(domain.Channels, c.Value) {
				return nil, httpx.Validation("channel must be one of " + strings.Join(domain.Channels, ", "))
			}
		case "received_at", "from_email":
			c.Value = strings.ToLower(c.Value)
		case "from_domain":
			c.Value = strings.ToLower(strings.TrimPrefix(c.Value, "@"))
		case "mailbox_id", "brand_id", "widget_id":
			if !exact {
				return nil, httpx.Validation(c.Field + " conditions use equals or not_equals")
			}
			id, err := uuid.Parse(c.Value)
			if err != nil {
				return nil, httpx.Validation(c.Field + " is not a valid id")
			}
			if err := checkRow(ctx, q, wid, idFields[c.Field], id, strings.TrimSuffix(c.Field, "_id")); err != nil {
				return nil, err
			}
			c.Value = id.String()
		}
		out = append(out, c)
	}
	return out, nil
}

// validDecide checks an ai_decide condition as automations do: gt or lt, a probability
// strictly between 0 and 1, and a plain text yes/no question.
func validDecide(c RoutingCondition) (RoutingCondition, error) {
	if c.Op != "gt" && c.Op != "lt" {
		return c, httpx.Validation("ai_decide conditions use gt or lt")
	}
	p, err := strconv.ParseFloat(strings.TrimSpace(c.Value), 64)
	if err != nil || p < 0.01 || p > 0.99 {
		return c, httpx.Validation("ai_decide value must be a probability between 0.01 and 0.99")
	}
	c.Value = strconv.FormatFloat(p, 'f', -1, 64)
	q := strings.Join(strings.Fields(c.Question), " ")
	if n := utf8.RuneCountInString(q); n < 3 || n > 300 {
		return c, httpx.Validation("ai_decide needs a question of 3 to 300 characters")
	}
	if strings.ContainsAny(q, "<>`") || strings.IndexFunc(q, unicode.IsControl) >= 0 {
		return c, httpx.Validation("ai_decide questions are plain text without <, > or `")
	}
	c.Question = q
	return c, nil
}

// checkRow confirms id is a row of table (a trusted constant) in the workspace.
func checkRow(ctx context.Context, q db.Querier, wid uuid.UUID, table string, id uuid.UUID, what string) error {
	var ok bool
	if err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM `+table+` WHERE workspace_id = $1 AND id = $2)`, wid, id).Scan(&ok); err != nil {
		return err
	}
	if !ok {
		return httpx.Validation(what + " not found in this workspace")
	}
	return nil
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
