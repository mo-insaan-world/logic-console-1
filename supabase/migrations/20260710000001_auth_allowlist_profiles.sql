-- M1: Closed-registration auth foundation for the Medical Logic Console.
--
-- Adds the allowlist + profiles tables, the signup gate (before-insert trigger
-- on auth.users rejecting non-allowlisted emails, case-insensitive), the
-- profile auto-provisioner (after-insert copying full_name/role from the
-- allowlist), a role-immutability guard, and the is_admin() helper used by
-- every admin RLS clause. Seeds the founder (admin) + Prof Tim Hardcastle.
--
-- Additive only. No existing table is touched. Edge functions (service role)
-- are unaffected. This migration does NOT yet change the anon browser paths on
-- architect_cases/submissions — that is M3, applied only after signup gating is
-- verified.

-- ── allowlist ────────────────────────────────────────────────────────────────
create table if not exists public.allowed_experts (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  full_name   text not null,
  role        text not null default 'surgeon' check (role in ('surgeon','admin')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  created_at  timestamptz not null default now()
);
-- Case-insensitive uniqueness without the citext extension (keep deps minimal).
create unique index if not exists allowed_experts_email_lower_uidx
  on public.allowed_experts (lower(email));

-- ── profiles ─────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text not null default 'surgeon' check (role in ('surgeon','admin')),
  created_at timestamptz not null default now()
);

-- ── is_admin(): SECURITY DEFINER so admin RLS clauses don't recurse on profiles
create or replace function public.is_admin(uid uuid) returns boolean
  language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = uid and role = 'admin');
$$;

-- ── signup gate: reject any email not on the allowlist (case-insensitive) ─────
create or replace function public.enforce_allowed_expert() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.allowed_experts a where lower(a.email) = lower(new.email)
  ) then
    raise exception 'not_allowlisted' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists trg_enforce_allowed_expert on auth.users;
create trigger trg_enforce_allowed_expert
  before insert on auth.users
  for each row execute function public.enforce_allowed_expert();

-- ── profile auto-provision from the matching allowlist row ────────────────────
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare a public.allowed_experts%rowtype;
begin
  select * into a from public.allowed_experts where lower(email) = lower(new.email) limit 1;
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(a.full_name, ''), coalesce(a.role, 'surgeon'))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── role immutability: only admin or service_role may change profiles.role ────
create or replace function public.guard_profile_role() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role
     and current_user <> 'service_role'
     and not public.is_admin(auth.uid()) then
    raise exception 'profiles.role is not user-updatable';
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_profile_role on public.profiles;
create trigger trg_guard_profile_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.allowed_experts enable row level security;
alter table public.profiles        enable row level security;

create policy profiles_self_read   on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_admin_read  on public.profiles for select to authenticated using (public.is_admin(auth.uid()));
create policy profiles_self_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_all   on public.profiles for all    to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

create policy allowed_experts_admin_all on public.allowed_experts for all to authenticated
  using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- Grants: RLS still restricts rows; grants only open the table to the role.
grant select, update            on public.profiles        to authenticated;
grant select, insert, update    on public.allowed_experts to authenticated;
grant all                       on public.profiles, public.allowed_experts to service_role;
revoke all                      on public.profiles, public.allowed_experts from anon;

-- ── seed ─────────────────────────────────────────────────────────────────────
insert into public.allowed_experts (email, full_name, role) values
  ('mo@insaan.world',      'Mohammed Elzubeir',   'admin'),
  ('traumadoc2@gmail.com', 'Prof Tim Hardcastle', 'surgeon')
on conflict do nothing;
