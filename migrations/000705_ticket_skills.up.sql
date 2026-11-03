-- Skill identities and all relationships belong to the same workspace.
CREATE TABLE skills (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 64),
    archived boolean NOT NULL DEFAULT false,
    UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX skills_ws_name_uq ON skills(workspace_id, lower(name));

CREATE TABLE member_skills (
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    skill_id uuid NOT NULL,
    PRIMARY KEY (workspace_id, user_id, skill_id),
    FOREIGN KEY (workspace_id, user_id) REFERENCES members(workspace_id, user_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, skill_id) REFERENCES skills(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX member_skills_skill_idx ON member_skills(workspace_id, skill_id);

ALTER TABLE routing_rules ADD CONSTRAINT routing_rules_ws_id_uq UNIQUE (workspace_id, id);
CREATE TABLE routing_rule_skills (
    workspace_id uuid NOT NULL,
    routing_rule_id uuid NOT NULL,
    skill_id uuid NOT NULL,
    PRIMARY KEY (workspace_id, routing_rule_id, skill_id),
    FOREIGN KEY (workspace_id, routing_rule_id) REFERENCES routing_rules(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, skill_id) REFERENCES skills(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX routing_rule_skills_skill_idx ON routing_rule_skills(workspace_id, skill_id);

ALTER TABLE tickets ADD CONSTRAINT tickets_ws_id_uq UNIQUE (workspace_id, id);
CREATE TABLE ticket_skills (
    workspace_id uuid NOT NULL,
    ticket_id uuid NOT NULL,
    skill_id uuid NOT NULL,
    PRIMARY KEY (workspace_id, ticket_id, skill_id),
    FOREIGN KEY (workspace_id, ticket_id) REFERENCES tickets(workspace_id, id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id, skill_id) REFERENCES skills(workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ticket_skills_skill_idx ON ticket_skills(workspace_id, skill_id);
