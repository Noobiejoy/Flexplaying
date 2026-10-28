-- Tighten function privileges. Postgres grants EXECUTE to PUBLIC by default,
-- which made the SECURITY DEFINER RPCs callable by the anon role.

-- Membership helpers are used inside RLS policies for signed-in users only.
revoke execute on function public.is_member(uuid) from public, anon;
revoke execute on function public.has_role(uuid, text[]) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.has_role(uuid, text[]) to authenticated;

-- RPCs that require a signed-in user (they also check auth.uid() internally).
revoke execute on function public.create_workspace(text, text) from public, anon;
revoke execute on function public.accept_invitation(text) from public, anon;
grant execute on function public.create_workspace(text, text) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;

-- Trigger-only function: never callable through the API.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
