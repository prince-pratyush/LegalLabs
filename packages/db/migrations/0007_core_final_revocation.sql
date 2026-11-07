-- MFA time is written once, when the session is created.
revoke update (mfa_at) on core.session from legallabs_app;

-- One-way, so a stolen session or token cannot be brought back.
create function core.keep_revoked() returns trigger
language plpgsql as $$
begin
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'revocation is final' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger session_keep_revoked before update on core.session
  for each row execute function core.keep_revoked();
create trigger api_token_keep_revoked before update on core.api_token
  for each row execute function core.keep_revoked();
