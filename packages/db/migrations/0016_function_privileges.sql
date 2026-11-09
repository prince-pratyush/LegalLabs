-- Per-schema default privileges can only add rights, so earlier revokes had no effect.
alter default privileges revoke execute on functions from public;
revoke execute on all functions in schema core from public;
revoke execute on all functions in schema admin from public;
