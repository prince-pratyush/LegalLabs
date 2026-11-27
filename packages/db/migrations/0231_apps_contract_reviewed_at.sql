-- When the playbook review behind a contract last finished. updated_at also moves on
-- reassignment, so it can't say what is new since someone last looked at the queue.
alter table apps.ci_contract_review add column reviewed_at timestamptz;
grant update (reviewed_at) on apps.ci_contract_review to legallabs_app;
