from pathlib import Path

p=Path('supabase/functions/staging-real-integration/index.ts')
s=p.read_text(encoding='utf-8')
orig=s

old_issue='''        const insert = await clients.admin.from("rodios_issues").insert({
          id: issueId,
          data: { id: issueId, issueNum: `ΑΙΤ-2099-${run.slice(-6).toUpperCase()}`, status: "Εκκρεμεί", title: "REAL INTEGRATION TEST", source: "integration" },
          status: "Εκκρεμεί", title: "REAL INTEGRATION TEST", deleted_at: null,
        }).select("id").single();'''
new_issue='''        const issueData = { id: issueId, issueNum: `ΑΙΤ-2099-${run.slice(-6).toUpperCase()}`, status: "Εκκρεμεί", title: "REAL INTEGRATION TEST", source: "integration" };
        const insert = await clients.admin.from("rodios_issues").insert({
          id: issueId,
          data: issueData,
        }).select("id").single();'''
if s.count(old_issue)!=1: raise SystemExit(f'issue insert marker count={s.count(old_issue)}')
s=s.replace(old_issue,new_issue,1)

old_mgr='''        const mgrUpdate = await clients.manager.from("rodios_issues").update({ title: "REAL INTEGRATION MANAGER UPDATE" }).eq("id", issueId).select("title");
        if (mgrUpdate.error) throw mgrUpdate.error;
        assert(mgrUpdate.data?.[0]?.title === "REAL INTEGRATION MANAGER UPDATE", "manager operational update failed");
        return { activeReads: 3, orphanRows: orphanRead.data?.length || 0, managerUpdate: true };'''
new_mgr='''        const managerData = { ...issueData, title: "REAL INTEGRATION MANAGER UPDATE" };
        const mgrUpdate = await clients.manager.from("rodios_issues").update({ data: managerData }).eq("id", issueId).select("data");
        if (mgrUpdate.error) throw mgrUpdate.error;
        assert(mgrUpdate.data?.[0]?.data?.title === "REAL INTEGRATION MANAGER UPDATE", "manager operational data update failed");

        const forbiddenColumnWrite = await clients.manager.from("rodios_issues").update({ title: "MUST BE DENIED" }).eq("id", issueId);
        assert(!!forbiddenColumnWrite.error, "manager could write denormalized title column despite column guard");
        return { activeReads: 3, orphanRows: orphanRead.data?.length || 0, managerDataUpdate: true, denormalizedColumnDenied: true };'''
if s.count(old_mgr)!=1: raise SystemExit(f'manager update marker count={s.count(old_mgr)}')
s=s.replace(old_mgr,new_mgr,1)

old_wo='''        const { error: woError } = await admin.from("rodios_work_orders").insert({
          id: woId, issue_id: issueId,
          data: { id: woId, orderNum: `ΕΝΤ-2099-${run.slice(-6).toUpperCase()}`, status: "Σε εξέλιξη", orderType: "contractor", items: [{ qty: 1, unitPrice: 10 }] },
          status: "Σε εξέλιξη", deleted_at: null,
        });'''
new_wo='''        const woData = { id: woId, orderNum: `ΕΝΤ-2099-${run.slice(-6).toUpperCase()}`, status: "Σε εξέλιξη", orderType: "contractor", items: [{ qty: 1, unitPrice: 10 }] };
        const { error: woError } = await admin.from("rodios_work_orders").insert({
          id: woId, issue_id: issueId, data: woData,
        });'''
if s.count(old_wo)!=1: raise SystemExit(f'work-order insert marker count={s.count(old_wo)}')
s=s.replace(old_wo,new_wo,1)

old_bypass='''        const bypass = await clients.admin.from("rodios_work_orders").update({ status: "Παραλήφθηκε", data: { id: woId, status: "Παραλήφθηκε" } }).eq("id", woId).select("id");'''
new_bypass='''        const bypass = await clients.admin.from("rodios_work_orders").update({ data: { ...woData, status: "Παραλήφθηκε" } }).eq("id", woId).select("id");'''
if s.count(old_bypass)!=1: raise SystemExit(f'bypass marker count={s.count(old_bypass)}')
s=s.replace(old_bypass,new_bypass,1)

if s==orig: raise SystemExit('no changes produced')
p.write_text(s,encoding='utf-8')
print('real integration runner now mirrors least-privilege browser column shape')
