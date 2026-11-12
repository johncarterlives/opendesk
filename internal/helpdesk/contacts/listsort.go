package contacts

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/useopendesk/opendesk/internal/httpx"
)

// listSort is one order a People or Companies list can take: the SQL it orders by, the same
// value written over a cursor's text parameter, and a row's value as that text. Every sort
// pages by key (the value, then the id), so a page never repeats or skips a record when others
// are added or deleted meanwhile. Only fixed text from these tables reaches the query.
type listSort[T any] struct {
	expr  string            // what the list orders by
	param string            // the cursor's value in SQL; %s is its text parameter
	key   func(T) string    // a row's value, as the cursor keeps it
	valid func(string) bool // whether a cursor's value can be that text
}

func timeSort[T any](expr string, v func(T) time.Time) listSort[T] {
	return listSort[T]{expr: expr, param: "(%s::text)::timestamptz",
		key:   func(r T) string { return v(r).UTC().Format(time.RFC3339Nano) },
		valid: func(s string) bool { _, err := time.Parse(time.RFC3339Nano, s); return err == nil }}
}

// nameSort orders by a name regardless of case; the cursor keeps the name as it is and the
// database lowers it, so the comparison is the one the order uses.
func nameSort[T any](col string, v func(T) string) listSort[T] {
	return listSort[T]{expr: "lower(" + col + ")", param: "lower(%s::text)", key: v,
		valid: func(string) bool { return true }}
}

func countSort[T any](expr string, v func(T) int) listSort[T] {
	return listSort[T]{expr: expr, param: "(%s::text)::bigint",
		key:   func(r T) string { return strconv.Itoa(v(r)) },
		valid: func(s string) bool { _, err := strconv.ParseInt(s, 10, 64); return err == nil }}
}

// listCursor is where the next page of a sorted list starts: the sort it was made for, the
// last row's value as text and its id.
type listCursor struct {
	Sort string    `json:"s"`
	V    string    `json:"v"`
	ID   uuid.UUID `json:"id"`
}

// sortedPage is one page of a list in one of its orders.
type sortedPage[T any] struct {
	sort  string
	s     listSort[T]
	idCol string
	id    func(T) uuid.UUID
	// after is the " AND (...) > (...)" condition that starts the page after the cursor, or "".
	after string
	args  []any
}

// pageOf reads the requested sort (fallback when empty) and cursor, binding the cursor's value
// and id from $next. A cursor made for another sort is refused. idCol and id are the rows' id,
// in SQL and on a row.
func pageOf[T any](sorts map[string]listSort[T], sort, fallback, idCol string, id func(T) uuid.UUID, cursor string, next int) (sortedPage[T], error) {
	if sort == "" {
		sort = fallback
	}
	s, ok := sorts[sort]
	if !ok {
		return sortedPage[T]{}, httpx.Validation("unknown sort")
	}
	pg := sortedPage[T]{sort: sort, s: s, idCol: idCol, id: id}
	if cursor == "" {
		return pg, nil
	}
	var c listCursor
	if err := httpx.DecodeCursor(cursor, &c); err != nil {
		return pg, err
	}
	if c.Sort != sort || !s.valid(c.V) {
		return pg, httpx.BadRequest("invalid cursor")
	}
	cmp := ">"
	if strings.HasPrefix(sort, "-") {
		cmp = "<"
	}
	pg.after = fmt.Sprintf(" AND (%s, %s) %s (%s, $%d)", s.expr, idCol, cmp, fmt.Sprintf(s.param, "$"+strconv.Itoa(next)), next+1)
	pg.args = []any{c.V, c.ID}
	return pg, nil
}

// orderBy is the page's ORDER BY, the id breaking ties in the same direction.
func (pg sortedPage[T]) orderBy() string {
	dir := " ASC"
	if strings.HasPrefix(pg.sort, "-") {
		dir = " DESC"
	}
	return " ORDER BY " + pg.s.expr + dir + ", " + pg.idCol + dir
}

// cursor is where the page after row starts.
func (pg sortedPage[T]) cursor(row T) any {
	return listCursor{Sort: pg.sort, V: pg.s.key(row), ID: pg.id(row)}
}
