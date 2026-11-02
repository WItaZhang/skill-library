-- Runtime remains the immutable source of task/version identity. Explicit execution
-- relations augment it; only content and provider metadata are JSONB.
ALTER TABLE runtime_sessions ADD UNIQUE(team_id,id,owner_id);
ALTER TABLE runtime_tasks ADD UNIQUE(team_id,id,session_id);
CREATE TABLE execution_requests (
 id uuid PRIMARY KEY, team_id uuid NOT NULL, task_id uuid NOT NULL, session_id uuid NOT NULL,
 owner_id uuid NOT NULL, prompt text NOT NULL CHECK(octet_length(prompt) BETWEEN 1 AND 16384),
 provider text NOT NULL, model text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','running','succeeded','failed','uncertain','cancelled')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 10),
 max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
 current_attempt_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(team_id,id), UNIQUE(team_id,task_id), UNIQUE(team_id,id,task_id),
 FOREIGN KEY(team_id,task_id,session_id) REFERENCES runtime_tasks(team_id,id,session_id),
 FOREIGN KEY(team_id,session_id,owner_id) REFERENCES runtime_sessions(team_id,id,owner_id),
 FOREIGN KEY(team_id,owner_id) REFERENCES team_memberships(team_id,user_id),
 CHECK(attempt_count<=max_attempts)
);
CREATE INDEX execution_queue ON execution_requests(created_at,id) WHERE status='queued';
CREATE INDEX execution_owner ON execution_requests(team_id,owner_id,created_at DESC);
CREATE TABLE execution_skills (
 team_id uuid NOT NULL, execution_id uuid NOT NULL, task_id uuid NOT NULL, skill_id uuid NOT NULL, version_id uuid NOT NULL,
 PRIMARY KEY(execution_id,skill_id),
 FOREIGN KEY(team_id,execution_id,task_id) REFERENCES execution_requests(team_id,id,task_id),
 FOREIGN KEY(team_id,task_id,skill_id,version_id) REFERENCES runtime_task_versions(team_id,task_id,skill_id,version_id)
);
CREATE TRIGGER execution_skills_immutable BEFORE UPDATE OR DELETE ON execution_skills FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TABLE execution_attempts (
 id uuid PRIMARY KEY, team_id uuid NOT NULL, execution_id uuid NOT NULL, task_id uuid NOT NULL,
 number integer NOT NULL CHECK(number BETWEEN 1 AND 10),
 status text NOT NULL CHECK(status IN ('claimed','running','succeeded','failed','uncertain','cancelled')),
 provider text NOT NULL, model text NOT NULL, provider_request_id text, error_code text,
 lease_expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 UNIQUE(execution_id,number), UNIQUE(team_id,execution_id,id),
 FOREIGN KEY(team_id,execution_id,task_id) REFERENCES execution_requests(team_id,id,task_id)
);
CREATE INDEX execution_leases ON execution_attempts(lease_expires_at) WHERE status IN ('claimed','running');
ALTER TABLE execution_requests ADD FOREIGN KEY(team_id,id,current_attempt_id) REFERENCES execution_attempts(team_id,execution_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE execution_results (
 attempt_id uuid PRIMARY KEY, team_id uuid NOT NULL, execution_id uuid NOT NULL,
 text text NOT NULL CHECK(octet_length(text)<=262144), metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(team_id,execution_id,attempt_id) REFERENCES execution_attempts(team_id,execution_id,id)
);
CREATE TRIGGER execution_results_immutable BEFORE UPDATE OR DELETE ON execution_results FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE TABLE execution_receipts (
 team_id uuid NOT NULL, owner_id uuid NOT NULL, operation text NOT NULL CHECK(operation IN ('accept','retry')),
 key text NOT NULL CHECK(length(key) BETWEEN 1 AND 128), fingerprint text NOT NULL,
 execution_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,owner_id,operation,key),
 FOREIGN KEY(team_id,owner_id) REFERENCES team_memberships(team_id,user_id),
 FOREIGN KEY(team_id,execution_id) REFERENCES execution_requests(team_id,id)
);
CREATE TRIGGER execution_receipts_immutable BEFORE UPDATE OR DELETE ON execution_receipts FOR EACH ROW EXECUTE FUNCTION deny_mutation();
CREATE FUNCTION protect_execution_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.team_id,NEW.task_id,NEW.session_id,NEW.owner_id,NEW.prompt,NEW.provider,NEW.model,NEW.max_attempts,NEW.created_at)
 IS DISTINCT FROM ROW(OLD.id,OLD.team_id,OLD.task_id,OLD.session_id,OLD.owner_id,OLD.prompt,OLD.provider,OLD.model,OLD.max_attempts,OLD.created_at)
 THEN RAISE EXCEPTION 'immutable execution identity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER execution_identity BEFORE UPDATE ON execution_requests FOR EACH ROW EXECUTE FUNCTION protect_execution_identity();
