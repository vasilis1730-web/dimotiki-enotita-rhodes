from pathlib import Path

p=Path('aftepistasia.html')
s=p.read_text(encoding='utf-8')
orig=s
start=s.find('function exportCSV(){')
if start < 0:
    raise SystemExit('exportCSV start not found')
end=s.find('\n}\n', start)
if end < 0:
    raise SystemExit('exportCSV end not found')
end += 3
old=s[start:end]
if old.count("replace(/\"/g,'\"\"')") != 1:
    raise SystemExit('expected original quote-only CSV escaping exactly once')
new="""function _csvSafeCell(value){
  let s=(value===undefined||value===null)?'':String(value);
  // Spreadsheet formula injection protection. Stored application data is not modified;
  // only the exported representation is neutralized.
  if(/^[\\t\\r\\n ]*[=+\\-@]/.test(s) || /^[\\t\\r\\n]/.test(s)) s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}
function exportCSV(){
  const cols=['id','date','category','title','location','priority','status','description'];
  const hdr=['ID','Ημερομηνία','Κατηγορία','Τίτλος','Τοποθεσία','Προτεραιότητα','Κατάσταση','Περιγραφή'];
  const rows=issues.map(i=>cols.map(c=>_csvSafeCell(i[c])).join(','));
  const blob=new Blob(['\\uFEFF'+hdr.map(_csvSafeCell).join(',')+'\\n'+rows.join('\\n')],{type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='aitimata_'+todayStr()+'.csv';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
"""
s=s[:start]+new+s[end:]
for required in ['function _csvSafeCell(value)','/^[\\t\\r\\n ]*[=+\\-@]/','cols.map(c=>_csvSafeCell(i[c]))','URL.revokeObjectURL(url)']:
    if required not in s:
        raise SystemExit('missing CSV hardening invariant: '+required)
if "cols.map(c=>'\"'+" in s:
    raise SystemExit('old CSV serialization remains')
if s==orig:
    raise SystemExit('no CSV changes produced')
p.write_text(s,encoding='utf-8')
print('CSV export hardening applied')
