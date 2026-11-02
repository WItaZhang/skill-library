-- The personal loopback host connects explicitly configured folders only.
CREATE TABLE local_skill_sources (
 team_id uuid NOT NULL,
 skill_id uuid NOT NULL,
 user_id uuid NOT NULL,
 source_path text NOT NULL,
 baseline_checksum text NOT NULL,
 synced_version_id uuid NOT NULL,
 PRIMARY KEY(team_id,skill_id),
 UNIQUE(team_id,source_path),
 FOREIGN KEY(team_id,skill_id) REFERENCES skills(team_id,id),
 FOREIGN KEY(team_id,user_id) REFERENCES team_memberships(team_id,user_id),
 FOREIGN KEY(team_id,skill_id,synced_version_id) REFERENCES versions(team_id,skill_id,id)
);
