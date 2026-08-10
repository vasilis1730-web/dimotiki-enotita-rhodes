from pathlib import Path

p=Path('aftepistasia.html')
s=p.read_text(encoding='utf-8')
old="""    alert('🚫 Ανιχνεύθηκαν '+sigs+'/'+req+' ψηφιακές υπογραφές.

Η παραλαβή απαιτεί όλες τις υπογραφές (Άρθρο 9). Ανεβάστε το πλήρως υπογεγραμμένο πρωτόκολλο.');"""
new="""    alert('🚫 Ανιχνεύθηκαν '+sigs+'/'+req+' ψηφιακές υπογραφές.\\n\\nΗ παραλαβή απαιτεί όλες τις υπογραφές (Άρθρο 9). Ανεβάστε το πλήρως υπογεγραμμένο πρωτόκολλο.');"""
if s.count(old)!=1:
    raise SystemExit(f'expected exactly one broken Gate E alert, found {s.count(old)}')
s=s.replace(old,new,1)
if old in s or new not in s:
    raise SystemExit('Gate E syntax replacement invariant failed')
p.write_text(s,encoding='utf-8')
print('E2E Gate E syntax fixed')
