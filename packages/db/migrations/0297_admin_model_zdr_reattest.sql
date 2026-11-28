-- Earlier code marked hosted models zero data retention from the route's "safe for client data"
-- flag on any edit, and the models screen sends the flag back on every save, so no stored true
-- (nor the audit log) shows an admin declared it. It is cleared once for hosted models, and an
-- admin declares it again. Local models keep it. The table forces RLS even on its owner, so the
-- owner steps out of it for this update only.
alter table admin.model_config no force row level security;
update admin.model_config set zdr = false, updated_at = now()
 where zdr and provider <> 'ollama' and region <> 'local';
alter table admin.model_config force row level security;
