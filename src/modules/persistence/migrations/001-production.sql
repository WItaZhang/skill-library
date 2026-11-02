CREATE TABLE users (
 id uuid PRIMARY KEY, display_name text NOT NULL, email text,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE auth_identities (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), provider text NOT NULL,
 provider_subject text NOT NULL, UNIQUE(provider,provider_subject)
);
CREATE TABLE auth_sessions (
 id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE TABLE teams (
 id uuid PRIMARY KEY, name text NOT NULL, status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE team_memberships (
 team_id uuid NOT NULL REFERENCES teams(id), user_id uuid NOT NULL REFERENCES users(id),
 role text NOT NULL CHECK(role IN ('admin','contributor','viewer')),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')),
 joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(team_id,user_id)
);
CREATE TABLE team_invitations (
 id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), email text NOT NULL,
 role text NOT NULL CHECK(role IN ('admin','contributor','viewer')),
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, accepted_at timestamptz,
 invited_by uuid NOT NULL, FOREIGN KEY(team_id,invited_by) REFERENCES team_memberships(team_id,user_id)
);
-- Membership mutations serialize on their team. Teams may start empty inside creation transactions.
CREATE FUNCTION protect_last_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM teams WHERE id=OLD.team_id FOR UPDATE;
 IF OLD.role='admin' AND OLD.status='active' AND
    (TG_OP='DELETE' OR NEW.role<>'admin' OR NEW.status<>'active' OR NEW.team_id<>OLD.team_id) AND
    NOT EXISTS(SELECT 1 FROM team_memberships WHERE team_id=OLD.team_id AND user_id<>OLD.user_id AND role='admin' AND status='active')
 THEN RAISE EXCEPTION 'last active admin' USING ERRCODE='23514'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER membership_last_admin BEFORE UPDATE OR DELETE ON team_memberships FOR EACH ROW EXECUTE FUNCTION protect_last_admin();

CREATE TABLE skills (
 id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), data jsonb NOT NULL,
 creator_id uuid GENERATED ALWAYS AS ((data->>'creatorId')::uuid) STORED NOT NULL, current_version_id uuid GENERATED ALWAYS AS ((data->>'currentVersionId')::uuid) STORED, revision integer GENERATED ALWAYS AS ((data->>'revision')::integer) STORED CHECK(revision>0), archived_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(team_id,id), CHECK((data->>'id')::uuid=id), CHECK((data->>'teamId')::uuid=team_id)
 );
 CREATE INDEX skills_team ON skills(team_id);

CREATE TABLE versions (
 id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), data jsonb NOT NULL,
 skill_id uuid GENERATED ALWAYS AS ((data->>'skillId')::uuid) STORED NOT NULL, author_id uuid GENERATED ALWAYS AS ((data->>'authorId')::uuid) STORED NOT NULL, parent_version_id uuid GENERATED ALWAYS AS ((data->>'parentVersionId')::uuid) STORED, number integer GENERATED ALWAYS AS ((data->>'number')::integer) STORED NOT NULL CHECK(number>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(team_id,id), CHECK((data->>'id')::uuid=id), CHECK((data->>'teamId')::uuid=team_id)
 );
 CREATE INDEX versions_team ON versions(team_id);

CREATE TABLE drafts (
 id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), data jsonb NOT NULL,
 skill_id uuid GENERATED ALWAYS AS ((data->>'skillId')::uuid) STORED NOT NULL, author_id uuid GENERATED ALWAYS AS ((data->>'authorId')::uuid) STORED NOT NULL, base_version_id uuid GENERATED ALWAYS AS ((data->>'baseVersionId')::uuid) STORED, revision integer GENERATED ALWAYS AS ((data->>'revision')::integer) STORED NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(team_id,id), CHECK((data->>'id')::uuid=id), CHECK((data->>'teamId')::uuid=team_id)
 );
 CREATE INDEX drafts_team ON drafts(team_id);

CREATE TABLE proposals (
 id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), data jsonb NOT NULL,
 skill_id uuid GENERATED ALWAYS AS ((data->>'skillId')::uuid) STORED NOT NULL, author_id uuid GENERATED ALWAYS AS ((data->>'authorId')::uuid) STORED NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(team_id,id), CHECK((data->>'id')::uuid=id), CHECK((data->>'teamId')::uuid=team_id)
 );
 CREATE INDEX proposals_team ON proposals(team_id);

CREATE TABLE audit (
 id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), data jsonb NOT NULL,
 actor_id uuid GENERATED ALWAYS AS ((data->>'actorId')::uuid) STORED NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(team_id,id), CHECK((data->>'id')::uuid=id), CHECK((data->>'teamId')::uuid=team_id)
 );
 CREATE INDEX audit_team ON audit(team_id);

ALTER TABLE skills ADD FOREIGN KEY(team_id,creator_id) REFERENCES team_memberships(team_id,user_id);
ALTER TABLE versions ADD UNIQUE(team_id,skill_id,id), ADD UNIQUE(skill_id,number),
 ADD FOREIGN KEY(team_id,skill_id) REFERENCES skills(team_id,id),
 ADD FOREIGN KEY(team_id,author_id) REFERENCES team_memberships(team_id,user_id),
 ADD FOREIGN KEY(team_id,skill_id,parent_version_id) REFERENCES versions(team_id,skill_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE skills ADD FOREIGN KEY(team_id,id,current_version_id) REFERENCES versions(team_id,skill_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE drafts ADD FOREIGN KEY(team_id,skill_id) REFERENCES skills(team_id,id),
 ADD FOREIGN KEY(team_id,author_id) REFERENCES team_memberships(team_id,user_id),
 ADD FOREIGN KEY(team_id,skill_id,base_version_id) REFERENCES versions(team_id,skill_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE proposals ADD FOREIGN KEY(team_id,skill_id) REFERENCES skills(team_id,id),
 ADD FOREIGN KEY(team_id,author_id) REFERENCES team_memberships(team_id,user_id);
ALTER TABLE audit ADD FOREIGN KEY(team_id,actor_id) REFERENCES team_memberships(team_id,user_id);
CREATE TABLE skill_maintainers (
 team_id uuid NOT NULL, skill_id uuid NOT NULL, user_id uuid NOT NULL,
 PRIMARY KEY(skill_id,user_id), FOREIGN KEY(team_id,skill_id) REFERENCES skills(team_id,id),
 FOREIGN KEY(team_id,user_id) REFERENCES team_memberships(team_id,user_id)
);
CREATE FUNCTION sync_maintainers() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM skill_maintainers WHERE skill_id=NEW.id;
 INSERT INTO skill_maintainers SELECT NEW.team_id,NEW.id,x::uuid FROM jsonb_array_elements_text(NEW.data->'maintainerIds') x;
 RETURN NEW;
END $$;
CREATE TRIGGER skills_maintainers AFTER INSERT OR UPDATE ON skills FOR EACH ROW EXECUTE FUNCTION sync_maintainers();
CREATE TABLE events (
 id uuid PRIMARY KEY, sequence bigint GENERATED BY DEFAULT AS IDENTITY UNIQUE,
 team_id uuid NOT NULL REFERENCES teams(id), data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 skill_id uuid GENERATED ALWAYS AS ((data->>'skillId')::uuid) STORED NOT NULL,
 version_id uuid GENERATED ALWAYS AS ((data->>'versionId')::uuid) STORED NOT NULL,
 previous_version_id uuid GENERATED ALWAYS AS ((data->>'previousVersionId')::uuid) STORED,
 CHECK((data->>'id')::uuid=id), CHECK((data->>'teamId')::uuid=team_id),
 FOREIGN KEY(team_id,skill_id,version_id) REFERENCES versions(team_id,skill_id,id),
 FOREIGN KEY(team_id,skill_id,previous_version_id) REFERENCES versions(team_id,skill_id,id)
);
CREATE INDEX events_team_sequence ON events(team_id,sequence);
CREATE TABLE requests (
 id uuid PRIMARY KEY, team_id uuid NOT NULL, actor_id uuid NOT NULL,
 operation text NOT NULL, key text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 UNIQUE(team_id,actor_id,operation,key), FOREIGN KEY(team_id,actor_id) REFERENCES team_memberships(team_id,user_id)
);
CREATE TABLE draft_previews (
 token uuid PRIMARY KEY, team_id uuid NOT NULL, actor_id uuid NOT NULL, snapshot jsonb NOT NULL, fingerprint text NOT NULL,
 draft_id uuid GENERATED ALWAYS AS ((snapshot->>'draftId')::uuid) STORED NOT NULL,
 FOREIGN KEY(team_id,actor_id) REFERENCES team_memberships(team_id,user_id),
 FOREIGN KEY(team_id,draft_id) REFERENCES drafts(team_id,id)
);
CREATE FUNCTION deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record' USING ERRCODE='23514'; END $$;
CREATE TRIGGER versions_immutable BEFORE UPDATE OR DELETE ON versions FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER requests_immutable BEFORE UPDATE OR DELETE ON requests FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER draft_previews_immutable BEFORE UPDATE OR DELETE ON draft_previews FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TABLE runtime_sessions (
 id uuid PRIMARY KEY, team_id uuid NOT NULL, owner_id uuid NOT NULL, epoch integer NOT NULL DEFAULT 0,
 UNIQUE(team_id,id), FOREIGN KEY(team_id,owner_id) REFERENCES team_memberships(team_id,user_id)
);
CREATE TABLE runtime_tasks (
 id uuid PRIMARY KEY, team_id uuid NOT NULL, session_id uuid NOT NULL,
 parent_task_id uuid, snapshot jsonb NOT NULL, checksums jsonb NOT NULL,
 created_at timestamptz NOT NULL, UNIQUE(team_id,id), UNIQUE(team_id,session_id,id),
 FOREIGN KEY(team_id,session_id) REFERENCES runtime_sessions(team_id,id),
 FOREIGN KEY(team_id,session_id,parent_task_id) REFERENCES runtime_tasks(team_id,session_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE runtime_task_versions (
 team_id uuid NOT NULL, task_id uuid NOT NULL, skill_id uuid NOT NULL, version_id uuid NOT NULL,
 PRIMARY KEY(task_id,skill_id), UNIQUE(team_id,task_id,skill_id,version_id),
 FOREIGN KEY(team_id,task_id) REFERENCES runtime_tasks(team_id,id),
 FOREIGN KEY(team_id,skill_id,version_id) REFERENCES versions(team_id,skill_id,id)
);
CREATE TABLE runtime_preferences (
 team_id uuid NOT NULL, session_id uuid NOT NULL, skill_id uuid NOT NULL, target_id uuid NOT NULL,
 value jsonb NOT NULL, PRIMARY KEY(session_id,skill_id),
 FOREIGN KEY(team_id,session_id) REFERENCES runtime_sessions(team_id,id),
 FOREIGN KEY(team_id,skill_id,target_id) REFERENCES versions(team_id,skill_id,id)
);
CREATE TABLE runtime_invocations (
 id uuid PRIMARY KEY, sequence bigint GENERATED BY DEFAULT AS IDENTITY UNIQUE,
 team_id uuid NOT NULL, session_id uuid NOT NULL, task_id uuid NOT NULL, skill_id uuid NOT NULL, version_id uuid NOT NULL,
 value jsonb NOT NULL, created_at timestamptz NOT NULL,
 FOREIGN KEY(team_id,session_id,task_id) REFERENCES runtime_tasks(team_id,session_id,id),
 FOREIGN KEY(team_id,task_id,skill_id,version_id) REFERENCES runtime_task_versions(team_id,task_id,skill_id,version_id)
);
CREATE TRIGGER runtime_tasks_immutable BEFORE UPDATE OR DELETE ON runtime_tasks FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER runtime_task_versions_immutable BEFORE UPDATE OR DELETE ON runtime_task_versions FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TRIGGER runtime_invocations_immutable BEFORE UPDATE OR DELETE ON runtime_invocations FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TABLE legacy_imports (
 id uuid PRIMARY KEY, source_key text NOT NULL UNIQUE, fingerprint text NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT now(), id_map jsonb NOT NULL
);
CREATE TABLE legacy_records (
 id uuid PRIMARY KEY, import_id uuid NOT NULL REFERENCES legacy_imports(id),
 source_table text NOT NULL, source_key text NOT NULL, raw_text text NOT NULL,
 UNIQUE(import_id,source_table,source_key)
);
CREATE TRIGGER legacy_records_immutable BEFORE UPDATE OR DELETE ON legacy_records FOR EACH ROW EXECUTE FUNCTION deny_mutation();

ALTER TABLE versions ADD reviewer_id uuid GENERATED ALWAYS AS ((data->>'reviewerId')::uuid) STORED,
 ADD FOREIGN KEY(team_id,reviewer_id) REFERENCES team_memberships(team_id,user_id);
ALTER TABLE proposals ADD base_version_id uuid GENERATED ALWAYS AS ((data->>'baseVersionId')::uuid) STORED,
 ADD merged_version_id uuid GENERATED ALWAYS AS ((data->>'mergedVersionId')::uuid) STORED,
 ADD FOREIGN KEY(team_id,skill_id,base_version_id) REFERENCES versions(team_id,skill_id,id) DEFERRABLE INITIALLY DEFERRED,
 ADD FOREIGN KEY(team_id,skill_id,merged_version_id) REFERENCES versions(team_id,skill_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE runtime_tasks ADD CHECK((snapshot->>'taskId')::uuid=id),
 ADD CHECK((snapshot->>'teamId')::uuid=team_id), ADD CHECK((snapshot->>'sessionId')::uuid=session_id),
 ADD CHECK((snapshot->>'parentTaskId')::uuid IS NOT DISTINCT FROM parent_task_id);
CREATE FUNCTION populate_task_versions() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pair record; expected text;
BEGIN
 FOR pair IN SELECT * FROM jsonb_each_text(NEW.snapshot->'versions') LOOP
  SELECT data->>'checksum' INTO expected FROM versions WHERE id=pair.value::uuid AND skill_id=pair.key::uuid AND team_id=NEW.team_id;
  IF expected IS NULL OR expected IS DISTINCT FROM NEW.checksums->>pair.key THEN
   RAISE EXCEPTION 'task checksum or version mismatch' USING ERRCODE='23514';
  END IF;
  INSERT INTO runtime_task_versions(team_id,task_id,skill_id,version_id) VALUES(NEW.team_id,NEW.id,pair.key::uuid,pair.value::uuid);
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER task_version_links AFTER INSERT ON runtime_tasks FOR EACH ROW EXECUTE FUNCTION populate_task_versions();
CREATE FUNCTION check_task_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected text;
BEGIN
 SELECT snapshot->'versions'->>NEW.skill_id::text INTO expected FROM runtime_tasks WHERE id=NEW.task_id AND team_id=NEW.team_id;
 IF expected IS DISTINCT FROM NEW.version_id::text THEN RAISE EXCEPTION 'task link mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER task_link_valid BEFORE INSERT ON runtime_task_versions FOR EACH ROW EXECUTE FUNCTION check_task_link();
