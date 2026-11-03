package domain

// PresenceSQL is a member's effective availability: "away" when the member is
// "online" but the workspace's auto_away_minutes passed since they were last seen.
// It expects aliases m (members), u (users) and w (workspaces).
const PresenceSQL = `CASE WHEN m.availability = 'online' AND COALESCE((w.settings ->> 'auto_away_minutes')::int, 0) > 0
	AND (u.last_seen_at IS NULL OR u.last_seen_at < now() - make_interval(mins => (w.settings ->> 'auto_away_minutes')::int))
	THEN 'away' ELSE m.availability END`

// OnlineTimeSQL is whether the workspace records its members' online time for the agents
// report (settings agent_online_time, default true; contracts/api.md "Agents report").
// It expects alias w (workspaces).
const OnlineTimeSQL = `COALESCE((w.settings ->> 'agent_online_time')::boolean, true)`

// OpenTicketsSQL counts a member's open and pending assigned tickets (aliases m).
const OpenTicketsSQL = `(SELECT count(*) FROM tickets ot WHERE ot.workspace_id = m.workspace_id AND ot.assignee_id = m.user_id
	AND ot.deleted_at IS NULL AND ot.status IN ('open', 'pending'))`
