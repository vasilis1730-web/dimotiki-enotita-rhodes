-- ============================================================================
-- ΡΟΔΙΟΣ v9.13 — Atomic αρίθμηση ΑΙΤ-/ΕΕ- (issues & work orders)
-- Εκτέλεση ΜΙΑ φορά στο Supabase SQL Editor.
--
-- Σκοπός: αποτρέπει διπλούς αριθμούς ΑΙΤ-/ΕΕ- όταν δύο χρήστες δημιουργούν
-- εγγραφές ταυτόχρονα, δίνοντας τον επόμενο αριθμό ατομικά από τη βάση.
--
-- ΣΗΜΑΝΤΙΚΟ: Το script κάνει ΚΑΙ seeding του μετρητή από τα ΥΠΑΡΧΟΝΤΑ δεδομένα,
-- ώστε η νέα αρίθμηση να ΣΥΝΕΧΙΖΕΙ από εκεί που είστε και να ΜΗΝ συγκρούεται
-- με αριθμούς που έχουν ήδη εκδοθεί. Είναι ασφαλές να ξανατρέξει (idempotent):
-- ποτέ δεν χαμηλώνει υπάρχοντα μετρητή (GREATEST).
--
-- Αν ΔΕΝ το τρέξετε, η εφαρμογή συνεχίζει κανονικά με τους τοπικούς μετρητές
-- (settings.issueSeq / settings.orderSeq) — fallback ασφαλές.
-- ============================================================================

-- 1) Πίνακας μετρητών (kind, year) -> next_value
create table if not exists public.rodios_sequences (
  kind        text        not null,
  year        integer     not null,
  next_value  integer     not null default 1,
  updated_at  timestamptz not null default now(),
  primary key (kind, year)
);

-- 2) RPC: επιστρέφει τον επόμενο αριθμό ατομικά και τον αυξάνει.
--    Ο πρώτος αριθμός που εκδίδεται ισούται με το τρέχον next_value.
create or replace function public.rodios_next_sequence(p_kind text, p_year integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  insert into public.rodios_sequences(kind, year, next_value)
  values (p_kind, p_year, 2)
  on conflict (kind, year)
  do update set
    next_value = public.rodios_sequences.next_value + 1,
    updated_at = now()
  returning public.rodios_sequences.next_value - 1 into v_next;

  return v_next;
end;
$$;

-- 3) Δικαιώματα εκτέλεσης.
--    Χρειάζεται 'anon' γιατί η εφαρμογή της επιτροπής καλεί τη Supabase με το
--    anon key (PIN-based auth, όχι Supabase Auth για τους απλούς χρήστες).
grant execute on function public.rodios_next_sequence(text, integer) to anon, authenticated;

-- ============================================================================
-- 4) SEEDING — υπολογισμός του επόμενου αριθμού ανά (είδος, έτος)
--    από τους ΥΠΑΡΧΟΝΤΕΣ αριθμούς. Τρέχει εντός μίας συναλλαγής.
-- ============================================================================
begin;

-- 4α) Από τα ΑΙΤΗΜΑΤΑ: data->>'issueNum' σε μορφή «ΑΙΤ-ΕΤΟΣ-ΝΝΝ».
insert into public.rodios_sequences (kind, year, next_value)
select
  'issue'                                        as kind,
  (split_part(s.num, '-', 2))::int               as year,
  max((split_part(s.num, '-', 3))::int) + 1       as next_value
from (
  select data->>'issueNum' as num
  from public.rodios_issues
  where deleted_at is null
    and data->>'issueNum' ~ '^[^-]+-[0-9]{4}-[0-9]+$'
) s
group by (split_part(s.num, '-', 2))::int
on conflict (kind, year) do update
  set next_value = greatest(public.rodios_sequences.next_value, excluded.next_value),
      updated_at = now();

-- 4β) Από τις ΕΝΤΟΛΕΣ: data->>'orderNum' σε μορφή «ΕΕ-ΕΤΟΣ-ΝΝΝ».
insert into public.rodios_sequences (kind, year, next_value)
select
  'order'                                        as kind,
  (split_part(s.num, '-', 2))::int               as year,
  max((split_part(s.num, '-', 3))::int) + 1       as next_value
from (
  select data->>'orderNum' as num
  from public.rodios_work_orders
  where deleted_at is null
    and data->>'orderNum' ~ '^[^-]+-[0-9]{4}-[0-9]+$'
) s
group by (split_part(s.num, '-', 2))::int
on conflict (kind, year) do update
  set next_value = greatest(public.rodios_sequences.next_value, excluded.next_value),
      updated_at = now();

-- 4γ) Δίχτυ ασφαλείας: τρέχον έτος >= τοπικοί μετρητές της εφαρμογής
--     (settings.issueSeq / settings.orderSeq), σε περίπτωση που υπάρχουν
--     αριθμοί που δεν αποθηκεύτηκαν στο data->>'issueNum'/'orderNum'.
insert into public.rodios_sequences (kind, year, next_value)
select 'issue', extract(year from now())::int,
       coalesce(nullif(value->>'issueSeq','')::int, 1)
from public.rodios_settings
where key = 'main'
on conflict (kind, year) do update
  set next_value = greatest(public.rodios_sequences.next_value, excluded.next_value),
      updated_at = now();

insert into public.rodios_sequences (kind, year, next_value)
select 'order', extract(year from now())::int,
       coalesce(nullif(value->>'orderSeq','')::int, 1)
from public.rodios_settings
where key = 'main'
on conflict (kind, year) do update
  set next_value = greatest(public.rodios_sequences.next_value, excluded.next_value),
      updated_at = now();

commit;

-- ============================================================================
-- 5) ΕΛΕΓΧΟΣ — δείτε τι μετρητές δημιουργήθηκαν (ο επόμενος αριθμός ανά είδος/έτος).
-- ============================================================================
select kind, year, next_value as epomenos_arithmos, updated_at
from public.rodios_sequences
order by year desc, kind;
