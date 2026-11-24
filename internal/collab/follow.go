package collab

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/useopendesk/opendesk/internal/auth"
	"github.com/useopendesk/opendesk/internal/db"
	"github.com/useopendesk/opendesk/internal/events"
	"github.com/useopendesk/opendesk/internal/httpx"
)

// Mentions (contracts/collab.md "Mentions"): a member follows a conversation once a comment
// mentions them or answers theirs (a reply to it, or the next comment after it), and it stays in their Mentions box until they remove
// themselves. Following never changes who sees a conversation: only members who see it
// follow it, and the box lists only what its member still sees.

// followedSQL is a predicate on collab_threads alias t: the user (SQL parameter u) follows it.
func followedSQL(u string) string {
	return `EXISTS (SELECT 1 FROM collab_thread_followers xf WHERE xf.workspace_id = t.workspace_id AND xf.thread_id = t.id AND xf.user_id = ` + u + `)`
}

// mentionsOrderSQL is the Mentions box's order key on collab_threads alias t for the user (SQL
// parameter u): its newest mail, or the newest comment or follow that concerned them.
func mentionsOrderSQL(u string) string {
	return `GREATEST(t.last_message_at, (SELECT xf.activity_at FROM collab_thread_followers xf WHERE xf.workspace_id = t.workspace_id AND xf.thread_id = t.id AND xf.user_id = ` + u + `))`
}

// follow makes people follow a conversation, in tx: those who are members and see it. One
// following already has its activity moved to now, so the conversation comes back on top.
func follow(ctx context.Context, tx pgx.Tx, wid, threadID uuid.UUID, users []uuid.UUID) error {
	if len(users) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO collab_thread_followers (workspace_id, thread_id, user_id)
		SELECT DISTINCT $1::uuid, t.id, u FROM collab_threads t, unnest($3::uuid[]) u
		WHERE t.workspace_id = $1 AND t.id = $2
			AND EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = $1 AND m.user_id = u)
			AND `+threadVisibleSQL("t", "u")+`
		ON CONFLICT (thread_id, user_id) DO UPDATE SET activity_at = now()`, wid, threadID, users)
	return err
}

// commentFollowers applies a new comment to who follows its conversation, in tx: everyone
// following sees new activity, the people it mentions follow, and so does the person it answers.
//
// A reply answers the author of the comment it replies to (contracts/collab.md "Replies"), and
// no one else. A comment that replies to nothing answers a member when, since that member's latest
// comment, only its author has commented: the first comments after theirs, however many the author
// writes. Another teammate chiming in later answers no one but the author before them, so someone
// who removed themselves comes back when they are answered, not with every comment.
func commentFollowers(ctx context.Context, tx pgx.Tx, wid, threadID, commentID, author uuid.UUID, mentions []uuid.UUID, parent *replyTarget) error {
	if _, err := tx.Exec(ctx, `UPDATE collab_thread_followers SET activity_at = now() WHERE workspace_id = $1 AND thread_id = $2`,
		wid, threadID); err != nil {
		return err
	}
	people := appendNew(nil, mentions...)
	if parent != nil {
		if u := parent.answered(author); u != nil {
			people = appendNew(people, *u)
		}
		return follow(ctx, tx, wid, threadID, people)
	}
	rows, err := tx.Query(ctx, `SELECT mine.author_id FROM (
			SELECT c.author_id, max(c.created_at) AS last FROM collab_comments c
			WHERE c.workspace_id = $1 AND c.thread_id = $2 AND c.id <> $3 AND c.author_id IS NOT NULL AND c.author_id <> $4
			GROUP BY c.author_id) mine
		WHERE NOT EXISTS (SELECT 1 FROM collab_comments o WHERE o.workspace_id = $1 AND o.thread_id = $2 AND o.id <> $3
			AND o.created_at > mine.last AND (o.author_id IS NULL OR (o.author_id <> mine.author_id AND o.author_id <> $4)))`,
		wid, threadID, commentID, author)
	if err != nil {
		return err
	}
	answered, err := pgx.CollectRows(rows, pgx.RowTo[uuid.UUID])
	if err != nil {
		return err
	}
	return follow(ctx, tx, wid, threadID, appendNew(people, answered...))
}

// following reports whether the user follows the conversation.
func following(ctx context.Context, q db.Querier, wid, threadID, userID uuid.UUID) (bool, error) {
	var ok bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM collab_thread_followers WHERE workspace_id = $1 AND thread_id = $2 AND user_id = $3)`,
		wid, threadID, userID).Scan(&ok)
	return ok, err
}

func (s *service) registerFollowRoutes(api huma.API) {
	// Following is the member's own: it changes their Mentions box and nothing anyone else sees,
	// so a viewer, who can be mentioned, can remove themselves too.
	setFollow := func(on bool) func(context.Context, *threadIDInput) (*struct{}, error) {
		return func(ctx context.Context, in *threadIDInput) (*struct{}, error) {
			p, err := s.require(ctx, auth.RoleViewer)
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			id, err := parseID(in.ID, "Conversation")
			if err != nil {
				return nil, err
			}
			t, err := visibleThread(ctx, s.d.DB.Pool, p, id)
			if err != nil {
				return nil, notFound(err, "Conversation")
			}
			err = s.d.DB.Tx(ctx, func(tx pgx.Tx) error {
				if on {
					err = follow(ctx, tx, p.WorkspaceID, t.ID, []uuid.UUID{p.UserID})
				} else {
					_, err = tx.Exec(ctx, `DELETE FROM collab_thread_followers WHERE workspace_id = $1 AND thread_id = $2 AND user_id = $3`,
						p.WorkspaceID, t.ID, p.UserID)
				}
				if err != nil {
					return err
				}
				// Only the member's own box and count changed.
				_, err = events.Publish(ctx, tx, events.Event{WorkspaceID: p.WorkspaceID, Type: EventChanged, Users: []uuid.UUID{p.UserID},
					Data: map[string]any{"account_id": t.AccountID, "thread_ids": []uuid.UUID{t.ID}, "folders": true}})
				return err
			})
			if err != nil {
				return nil, httpx.Wrap(err)
			}
			return nil, nil
		}
	}
	collabOp(api, huma.Operation{OperationID: "follow-collab-thread", Method: http.MethodPut, Path: "/v1/collab/threads/{id}/follow",
		Summary: "Follow a conversation in my Mentions", DefaultStatus: http.StatusNoContent}, setFollow(true))
	collabOp(api, huma.Operation{OperationID: "unfollow-collab-thread", Method: http.MethodDelete, Path: "/v1/collab/threads/{id}/follow",
		Summary: "Remove a conversation from my Mentions", DefaultStatus: http.StatusNoContent}, setFollow(false))
}
