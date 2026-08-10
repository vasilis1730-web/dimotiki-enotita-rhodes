from pathlib import Path

p=Path('aftepistasia.html')
s=p.read_text(encoding='utf-8')
orig=s

start=s.find('async function _v9DeleteRows(table, ids){')
if start < 0:
    raise SystemExit('_v9DeleteRows start not found')
end=s.find('\n}\n', start)
if end < 0:
    raise SystemExit('_v9DeleteRows end not found')
end += 3
old=s[start:end]
if ".delete().in('id', part)" not in old:
    raise SystemExit('expected physical delete call not found')
new="""async function _v9DeleteRows(table, ids){
  const sb = getSupabase && getSupabase();
  const list = (Array.isArray(ids) ? ids : [ids]).filter(x => x !== undefined && x !== null && String(x).trim() !== '').map(String);
  if(!sb || !list.length) return {ok:true, skipped:true};
  const allowed = new Set(['rodios_issues','rodios_work_orders','rodios_payments','rodios_service_staff']);
  if(!allowed.has(String(table||''))) throw new Error('Μη υποστηριζόμενη οντότητα αρχειοθέτησης.');

  // Release hardening: core rows are never physically deleted from the browser.
  // Administrator-only server RPC sets deleted_at and the DB trigger writes audit metadata.
  for(let i=0; i<list.length; i+=100){
    const part = list.slice(i, i+100);
    const { data, error } = await sb.rpc('rodios_soft_delete', {p_entity:String(table), p_ids:part});
    if(error){
      console.error('[v9 soft delete failed]', table, part, error);
      throw error;
    }
    if(Number(data||0) < 0) throw new Error('Μη έγκυρη απάντηση αρχειοθέτησης.');
  }
  return {ok:true};
}
"""
s=s[:start]+new+s[end:]

replacements = [
    ("return {id, data:c, deleted_at:null};", "return {id, data:c};", 'staff row', 'all'),
    ("return {id:String(c.id), data:c, deleted_at:null};", "return {id:String(c.id), data:c};", 'generic data row', 'all'),
    ("return {id:String(c.id), issue_id:c.issueId||c.issue_id||null, data:c, deleted_at:null};", "return {id:String(c.id), issue_id:c.issueId||c.issue_id||null, data:c};", 'order row', 'one'),
    ("return {id:String(c.id), work_order_id:c.workOrderId||c.orderId||c.woId||c.work_order_id||null, data:c, deleted_at:null};", "return {id:String(c.id), work_order_id:c.workOrderId||c.orderId||c.woId||c.work_order_id||null, data:c};", 'payment row', 'one'),
    ("if(userDeletes.length) await _v9DeleteRows('rodios_app_users', userDeletes);", "if(userDeletes.length) console.warn('[v9] App-user deletion is managed only through manage-app-user; sync delete skipped.', userDeletes);", 'app-user delete bypass', 'one'),
]
for oldtxt,newtxt,label,mode in replacements:
    count=s.count(oldtxt)
    if count < 1:
        raise SystemExit(f'{label}: expected at least one match, got {count}')
    if mode == 'one':
        if count != 1:
            raise SystemExit(f'{label}: expected exactly one match, got {count}')
        s=s.replace(oldtxt,newtxt,1)
    else:
        s=s.replace(oldtxt,newtxt)

if ".delete().in('id', part)" in s:
    raise SystemExit('physical core-row delete remains')
if "sb.rpc('rodios_soft_delete'" not in s:
    raise SystemExit('soft-delete RPC missing')
if "_v9DeleteRows('rodios_app_users'" in s:
    raise SystemExit('generic app-user deletion remains')
if 'deleted_at:null' in s:
    # A deleted_at:null inside a non-upsert context would need explicit review rather than silently bypassing column protections.
    raise SystemExit('deleted_at:null remains in staff app; review required')
if s == orig:
    raise SystemExit('no changes produced')

p.write_text(s,encoding='utf-8')
print('soft-delete client patch applied')
