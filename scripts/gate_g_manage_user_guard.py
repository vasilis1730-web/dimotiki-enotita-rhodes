from pathlib import Path

p=Path('aftepistasia.html')
s=p.read_text(encoding='utf-8')
old="""async function manageAppUser(action, profile, password, oldEmail){
  const sb = getSupabase();
  if(!sb || !sb.auth) throw new Error('Δεν υπάρχει ενεργή σύνδεση με Supabase.');"""
new="""async function manageAppUser(action, profile, password, oldEmail){
  if(!currentUser || userTier(currentUser)!=='admin'){
    throw new Error('Η διαχείριση χρηστών επιτρέπεται μόνο στον Administrator.');
  }
  const sb = getSupabase();
  if(!sb || !sb.auth) throw new Error('Δεν υπάρχει ενεργή σύνδεση με Supabase.');"""
if s.count(old)!=1:
    raise SystemExit(f'expected one manageAppUser entry block, found {s.count(old)}')
s=s.replace(old,new,1)
if "userTier(currentUser)!=='admin'" not in s:
    raise SystemExit('admin guard invariant missing')
p.write_text(s,encoding='utf-8')
print('manageAppUser client admin guard applied')
