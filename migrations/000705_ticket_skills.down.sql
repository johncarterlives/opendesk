DROP TABLE ticket_skills;
ALTER TABLE tickets DROP CONSTRAINT tickets_ws_id_uq;
DROP TABLE routing_rule_skills;
ALTER TABLE routing_rules DROP CONSTRAINT routing_rules_ws_id_uq;
DROP TABLE member_skills;
DROP TABLE skills;
