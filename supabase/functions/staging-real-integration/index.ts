import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.9";

const PROD_REF = "nzrdcgmrsfdmocyhfrod";
const FUNCTION_NAME = "staging-real-integration";

type TestResult = { name: string; ok: boolean; detail?: unknown };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function projectRef(url: string): string {
  try { return new URL(url).hostname.split(".")[0] || ""; } catch { return ""; }
}

function randomText(bytes = 12): string {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function errorDetail(e: unknown) {
  if (e instanceof Error) return { message: e.message, name: e.name, stack: e.stack?.split("\n").slice(0, 4).join("\n") };
  if (e && typeof e === "object") {
    const x = e as Record<string, unknown>;
    return {
      message: String(x.message ?? x.error_description ?? x.error ?? "Unknown object error"),
      code: x.code ?? null,
      details: x.details ?? null,
      hint: x.hint ?? null,
      status: x.status ?? null,
      name: x.name ?? null,
    };
  }
  return { message: String(e) };
}

async function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function requirePreviewGuard(admin: SupabaseClient, url: string) {
  const ref = projectRef(url);
  assert(ref && ref !== PROD_REF, "REFUSED: production project or unknown project ref");
  const { data, error } = await admin.from("rodios_settings").select("value").eq("key", "main").maybeSingle();
  if (error) throw error;
  assert(data?.value?.staging === true, "REFUSED: database is not marked staging:true");
  return ref;
}

Deno.serve(async (req: Request) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceKey) return json(req, { ok: false, error: "Missing Supabase runtime credentials" }, 500);

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const diagnostics: TestResult[] = [];
  try {
    const ref = await requirePreviewGuard(admin, supabaseUrl);
    if (req.method === "GET") return json(req, { ok: true, ready: true, function: FUNCTION_NAME, previewRef: ref });
    if (req.method !== "POST") return json(req, { ok: false, error: "Method not allowed" }, 405);

    const run = `${Date.now().toString(36)}_${randomText(5)}`;
    const password = `R0dios-${randomText(12)}!Aa1`;
    const results = diagnostics;
    const createdUserIds: string[] = [];
    const profileIds: string[] = [];
    const storagePaths: string[] = [];
    const issueIds: string[] = [];
    const workOrderIds: string[] = [];
    const ackIds: string[] = [];
    const realtimeChannels: Array<{ client: SupabaseClient; channel: any }> = [];
    const seqYear = new Date().getUTCFullYear() + 1;

    const emails = {
      admin: `it-admin-${run}@example.invalid`,
      manager: `it-manager-${run}@example.invalid`,
      user: `it-user-${run}@example.invalid`,
      orphan: `it-orphan-${run}@example.invalid`,
    };

    async function addResult(name: string, fn: () => Promise<unknown>) {
      try { const detail = await fn(); results.push({ name, ok: true, detail }); return detail; }
      catch (e) { results.push({ name, ok: false, detail: errorDetail(e) }); return undefined; }
    }

    async function createAuthUser(email: string) {
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { integration_run: run } });
      if (error) throw error;
      assert(data.user?.id, `Auth user id missing for ${email}`);
      createdUserIds.push(data.user.id);
      return data.user;
    }

    async function signIn(email: string) {
      const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      assert(data.session?.access_token && data.user?.id, `Real sign-in failed for ${email}`);
      return client;
    }

    try {
      const authUsers: Record<string, any> = {};
      await addResult("real_auth_create_users", async () => {
        authUsers.admin = await createAuthUser(emails.admin);
        authUsers.manager = await createAuthUser(emails.manager);
        authUsers.user = await createAuthUser(emails.user);
        authUsers.orphan = await createAuthUser(emails.orphan);
        return { created: 4 };
      });

      await addResult("real_app_profile_bindings", async () => {
        assert(authUsers.admin?.id && authUsers.manager?.id && authUsers.user?.id, "auth users unavailable for profile binding");
        const profileRows = (["admin", "manager", "user"] as const).map((tier) => {
          const id = `it_${tier}_${run}`;
          profileIds.push(id);
          return {
            id,
            auth_user_id: authUsers[tier].id,
            data: { id, name: `Integration ${tier}`, email: emails[tier], tier, role: tier, username: id, canOrders: true, canEdit: true },
            deleted_at: null,
          };
        });
        const { error } = await admin.from("rodios_app_users").upsert(profileRows, { onConflict: "id" });
        if (error) throw error;
        return { bound: 3 };
      });

      const clients: Record<string, SupabaseClient> = {};
      await addResult("real_auth_sign_in_password", async () => {
        clients.admin = await signIn(emails.admin);
        clients.manager = await signIn(emails.manager);
        clients.user = await signIn(emails.user);
        clients.orphan = await signIn(emails.orphan);
        return { signedIn: 4 };
      });

      const issueId = `it_issue_${run}`; issueIds.push(issueId);
      await addResult("real_postgrest_rls_operational", async () => {
        assert(clients.admin && clients.manager && clients.user && clients.orphan, "signed-in clients unavailable");
        const issueData = { id: issueId, issueNum: `ΑΙΤ-2099-${run.slice(-6).toUpperCase()}`, status: "Εκκρεμεί", title: "REAL INTEGRATION TEST", source: "integration" };
        const insert = await clients.admin.rpc("rodios_save_bundle", { p_bundle: { issues: { upserts: [{ id: issueId, data: issueData, expectedUpdatedAt: null }], deletes: [] } } });
        if (insert.error) throw insert.error;
        assert(insert.data?.ok === true && insert.data?.versions?.issues?.[issueId], "atomic issue insert did not return a server version");

        for (const role of ["admin", "manager", "user"] as const) {
          const q = await clients[role].from("rodios_issues").select("id").eq("id", issueId);
          if (q.error) throw q.error;
          assert(q.data?.length === 1, `${role} active profile cannot read integration issue`);
        }
        const orphanRead = await clients.orphan.from("rodios_issues").select("id").eq("id", issueId);
        if (orphanRead.error) throw orphanRead.error;
        assert((orphanRead.data || []).length === 0, "orphan Auth user can read protected issue");

        const beforeManager = await admin.from("rodios_issues").select("data,updated_at").eq("id", issueId).single();
        if (beforeManager.error) throw beforeManager.error;
        const managerData = { ...beforeManager.data.data, title: "REAL INTEGRATION MANAGER UPDATE" };
        const mgrUpdate = await clients.manager.rpc("rodios_save_bundle", { p_bundle: { issues: { upserts: [{ id: issueId, data: managerData, expectedUpdatedAt: beforeManager.data.updated_at }], deletes: [] } } });
        if (mgrUpdate.error) throw mgrUpdate.error;
        const afterManager = await admin.from("rodios_issues").select("data").eq("id", issueId).single();
        if (afterManager.error) throw afterManager.error;
        assert(afterManager.data.data?.title === "REAL INTEGRATION MANAGER UPDATE", "manager atomic operational update failed");

        const forbiddenColumnWrite = await clients.manager.from("rodios_issues").update({ title: "MUST BE DENIED" }).eq("id", issueId);
        assert(!!forbiddenColumnWrite.error, "manager could write denormalized title column despite column guard");
        const forbiddenDirectData = await clients.manager.from("rodios_issues").update({ data: { ...managerData, title: "DIRECT MUST BE DENIED" } }).eq("id", issueId);
        assert(!!forbiddenDirectData.error, "manager retained a direct operational update path outside rodios_save_bundle");
        const directProbeId = `it_direct_${run}`; issueIds.push(directProbeId);
        const forbiddenDirectInsert = await clients.manager.from("rodios_issues").insert({ id: directProbeId, data: { id: directProbeId } });
        assert(!!forbiddenDirectInsert.error, "manager retained a direct operational insert path outside rodios_save_bundle");
        return { activeReads: 3, orphanRows: orphanRead.data?.length || 0, managerAtomicUpdate: true, directWritesDenied: true, denormalizedColumnDenied: true };
      });

      await addResult("real_two_session_atomic_concurrency_realtime", async () => {
        assert(clients.manager && clients.user, "manager/user clients unavailable for concurrency test");
        const subscribe = async (client: SupabaseClient, label: string) => {
          const events: any[] = [];
          let channel: any;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${label} Realtime subscription timeout`)), 12_000);
            channel = client.channel(`rodios_${label}_${run}`)
              .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rodios_issues", filter: `id=eq.${issueId}` }, (payload: any) => events.push(payload))
              .subscribe((status: string) => {
                if (status === "SUBSCRIBED") { clearTimeout(timer); resolve(); }
                if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { clearTimeout(timer); reject(new Error(`${label} Realtime status ${status}`)); }
              });
          });
          realtimeChannels.push({ client, channel });
          return events;
        };

        const managerEvents = await subscribe(clients.manager, "manager");
        const userEvents = await subscribe(clients.user, "user");
        const before = await admin.from("rodios_issues").select("data,updated_at").eq("id", issueId).single();
        if (before.error) throw before.error;
        const managerData = { ...before.data.data, title: `CONCURRENT MANAGER ${run}` };
        const userData = { ...before.data.data, title: `CONCURRENT USER ${run}` };
        const args = (data: any) => ({ p_bundle: { issues: { upserts: [{ id: issueId, data, expectedUpdatedAt: before.data.updated_at }], deletes: [] } } });
        const [managerWrite, userWrite] = await Promise.all([
          clients.manager.rpc("rodios_save_bundle", args(managerData)),
          clients.user.rpc("rodios_save_bundle", args(userData)),
        ]);
        const writes = [managerWrite, userWrite];
        assert(writes.filter((x) => !x.error && x.data?.ok === true).length === 1, "concurrent same-version writes did not produce exactly one winner");
        const loser = writes.find((x) => !!x.error);
        assert(loser?.error?.code === "40001" && String(loser.error.message || "").includes("RODIOS_SYNC_CONFLICT"), "concurrent loser was not rejected as an atomic sync conflict");

        const deadline = Date.now() + 10_000;
        while ((managerEvents.length < 1 || userEvents.length < 1) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
        assert(managerEvents.length >= 1, "manager session did not receive the concurrent Realtime update");
        assert(userEvents.length >= 1, "user session did not receive the concurrent Realtime update");
        const finalRow = await admin.from("rodios_issues").select("data,updated_at").eq("id", issueId).single();
        if (finalRow.error) throw finalRow.error;
        assert([managerData.title, userData.title].includes(finalRow.data.data?.title), "concurrent winner was not the final stored row");
        return { oneWinner: true, staleLoserDenied: true, managerRealtimeEvents: managerEvents.length, userRealtimeEvents: userEvents.length, finalTitle: finalRow.data.data.title };
      });

      await addResult("real_atomic_bundle_rollback", async () => {
        assert(clients.admin && clients.manager && clients.user, "clients unavailable for atomic rollback test");
        const a = `it_rollback_a_${run}`;
        const b = `it_rollback_b_${run}`;
        issueIds.push(a, b);
        const create = await clients.admin.rpc("rodios_save_bundle", { p_bundle: { issues: { upserts: [
          { id: a, data: { id: a, title: "ROLLBACK A ORIGINAL", source: "integration" }, expectedUpdatedAt: null },
          { id: b, data: { id: b, title: "ROLLBACK B ORIGINAL", source: "integration" }, expectedUpdatedAt: null },
        ], deletes: [] } } });
        if (create.error) throw create.error;
        const baseline = await admin.from("rodios_issues").select("id,data,updated_at").in("id", [a,b]);
        if (baseline.error) throw baseline.error;
        const rowA = baseline.data.find((x: any) => x.id === a);
        const rowB = baseline.data.find((x: any) => x.id === b);
        assert(rowA?.updated_at && rowB?.updated_at, "rollback baselines missing");

        const advanceB = await clients.manager.rpc("rodios_save_bundle", { p_bundle: { issues: { upserts: [{ id: b, data: { ...rowB.data, title: "ROLLBACK B ADVANCED" }, expectedUpdatedAt: rowB.updated_at }], deletes: [] } } });
        if (advanceB.error) throw advanceB.error;
        const staleBundle = await clients.user.rpc("rodios_save_bundle", { p_bundle: { issues: { upserts: [
          { id: a, data: { ...rowA.data, title: "ROLLBACK A MUST NOT PERSIST" }, expectedUpdatedAt: rowA.updated_at },
          { id: b, data: { ...rowB.data, title: "ROLLBACK B STALE MUST NOT PERSIST" }, expectedUpdatedAt: rowB.updated_at },
        ], deletes: [] } } });
        assert(staleBundle.error?.code === "40001", "stale multi-row bundle did not fail");
        const after = await admin.from("rodios_issues").select("id,data").in("id", [a,b]);
        if (after.error) throw after.error;
        const afterA = after.data.find((x: any) => x.id === a);
        const afterB = after.data.find((x: any) => x.id === b);
        assert(afterA?.data?.title === "ROLLBACK A ORIGINAL", "first write in failed bundle was not rolled back");
        assert(afterB?.data?.title === "ROLLBACK B ADVANCED", "pre-existing winner was changed by failed stale bundle");
        return { staleBundleDenied: true, entireTransactionRolledBack: true };
      });

      await addResult("real_settings_admin_boundary", async () => {
        assert(clients.admin && clients.manager, "admin/manager clients unavailable");
        const before = await admin.from("rodios_settings").select("value,updated_at").eq("key", "main").single();
        if (before.error) throw before.error;
        const original = before.data.value || {};

        const managerAttempt = await clients.manager.rpc("rodios_save_bundle", { p_bundle: { settings: { upserts: [{ key: "main", value: { ...original, integration_manager_must_not_write: run }, expectedUpdatedAt: before.data.updated_at }], deletes: [] } } });
        assert(!!managerAttempt.error, "manager changed settings through atomic save RPC");
        const verifyManager = await admin.from("rodios_settings").select("value").eq("key", "main").single();
        if (verifyManager.error) throw verifyManager.error;
        assert(verifyManager.data.value?.integration_manager_must_not_write !== run, "manager changed settings through real RLS");

        const adminWrite = await clients.admin.rpc("rodios_save_bundle", { p_bundle: { settings: { upserts: [{ key: "main", value: { ...original, integration_admin_write: run }, expectedUpdatedAt: before.data.updated_at }], deletes: [] } } });
        if (adminWrite.error) throw adminWrite.error;
        const verifyAdmin = await admin.from("rodios_settings").select("value").eq("key", "main").single();
        if (verifyAdmin.error) throw verifyAdmin.error;
        assert(verifyAdmin.data.value?.integration_admin_write === run, "admin could not update settings through atomic save RPC");
        const restore = await admin.from("rodios_settings").update({ value: original }).eq("key", "main");
        if (restore.error) throw restore.error;
        return { managerDenied: true, adminAllowed: true };
      });

      await addResult("real_sequence_rpc_authorization", async () => {
        assert(clients.manager && clients.orphan, "manager/orphan clients unavailable");
        const active = await clients.manager.rpc("rodios_next_sequence", { p_kind: "issue", p_year: seqYear });
        if (active.error) throw active.error;
        assert(Number(active.data) >= 1, "active manager sequence RPC failed");
        const orphan = await clients.orphan.rpc("rodios_next_sequence", { p_kind: "issue", p_year: seqYear });
        assert(!!orphan.error, "orphan Auth user could call sequence RPC");
        await admin.from("rodios_sequences").delete().eq("kind", "issue").eq("year", seqYear);
        return { testYear: seqYear, activeValue: active.data, orphanDenied: true };
      });

      const storagePath = `integration/${run}/payload.txt`; storagePaths.push(storagePath);
      await addResult("real_private_storage_signed_url", async () => {
        assert(clients.user && clients.manager && clients.orphan && clients.admin, "storage test clients unavailable");
        const payload = `RODIOS real integration ${run}`;
        const up = await clients.user.storage.from("attachments").upload(storagePath, new Blob([payload], { type: "text/plain" }), { upsert: false });
        if (up.error) throw up.error;

        const directUrl = `${supabaseUrl}/storage/v1/object/public/attachments/${storagePath}`;
        const direct = await fetch(directUrl, { redirect: "manual" });
        assert(!direct.ok, `private attachment unexpectedly public: HTTP ${direct.status}`);

        const signed = await clients.user.storage.from("attachments").createSignedUrl(storagePath, 60);
        if (signed.error) throw signed.error;
        assert(signed.data?.signedUrl, "signed URL not produced for active user");
        const downloaded = await fetch(signed.data.signedUrl);
        assert(downloaded.ok, `signed URL download failed: HTTP ${downloaded.status}`);
        assert(await downloaded.text() === payload, "signed URL returned wrong bytes");

        const managerDelete = await clients.manager.storage.from("attachments").remove([storagePath]);
        const afterManager = await admin.storage.from("attachments").download(storagePath);
        assert(!afterManager.error && !!afterManager.data, "manager delete request actually removed the protected attachment");
        assert(await afterManager.data.text() === payload, "attachment bytes changed after denied manager delete request");

        const orphanPath = `integration/${run}/orphan.txt`;
        const orphanUpload = await clients.orphan.storage.from("attachments").upload(orphanPath, new Blob(["no"], { type: "text/plain" }), { upsert: false });
        const orphanProbe = await admin.storage.from("attachments").download(orphanPath);
        if (!orphanProbe.error && orphanProbe.data) storagePaths.push(orphanPath);
        assert(!!orphanProbe.error, "orphan Auth user actually created an attachment object");

        const adminDelete = await clients.admin.storage.from("attachments").remove([storagePath]);
        if (adminDelete.error) throw adminDelete.error;
        const afterAdmin = await admin.storage.from("attachments").download(storagePath);
        assert(!!afterAdmin.error, "admin delete request did not remove attachment");
        storagePaths.splice(storagePaths.indexOf(storagePath), 1);
        return {
          upload: true,
          publicDeniedStatus: direct.status,
          signedDownload: true,
          managerDeleteApiError: !!managerDelete.error,
          managerDeletePreservedObject: true,
          orphanUploadApiError: !!orphanUpload.error,
          orphanObjectAbsent: true,
          adminDelete: true,
        };
      });

      await addResult("real_manage_app_user_edge_auth", async () => {
        assert(clients.admin && clients.manager, "admin/manager clients unavailable");
        const adminPing = await clients.admin.functions.invoke("manage-app-user", { body: { action: "ping" } });
        if (adminPing.error) throw adminPing.error;
        assert(adminPing.data?.ok === true && adminPing.data?.admin === true, "admin manage-app-user ping failed");
        const managerPing = await clients.manager.functions.invoke("manage-app-user", { body: { action: "ping" } });
        assert(!!managerPing.error || managerPing.data?.ok !== true, "manager reached admin-only manage-app-user function");
        return { adminAllowed: true, managerDenied: true };
      });

      const woId = `it_wo_${run}`; workOrderIds.push(woId);
      await addResult("real_direct_acceptance_bypass_denied", async () => {
        assert(clients.admin, "admin client unavailable");
        const woData = { id: woId, orderNum: `ΕΝΤ-2099-${run.slice(-6).toUpperCase()}`, status: "Σε εξέλιξη", orderType: "contractor", items: [{ qty: 1, unitPrice: 10 }] };
        const { error: woError } = await admin.from("rodios_work_orders").insert({ id: woId, issue_id: issueId, data: woData });
        if (woError) throw woError;
        const woVersion = await admin.from("rodios_work_orders").select("updated_at").eq("id", woId).single();
        if (woVersion.error) throw woVersion.error;
        const bypass = await clients.admin.rpc("rodios_save_bundle", { p_bundle: { workOrders: { upserts: [{ id: woId, issue_id: issueId, data: { ...woData, status: "Παραλήφθηκε" }, expectedUpdatedAt: woVersion.data.updated_at }], deletes: [] } } });
        assert(!!bypass.error, "authenticated admin bypassed proof-only accepted-state trigger");
        const verify = await admin.from("rodios_work_orders").select("status,data").eq("id", woId).single();
        if (verify.error) throw verify.error;
        assert(verify.data.status !== "Παραλήφθηκε" && verify.data.data?.status !== "Παραλήφθηκε", "bypass attempt changed accepted state");
        return { denied: true };
      });

      await addResult("real_public_ack_one_time_rpc", async () => {
        const token = randomText(24);
        const ack = await admin.from("work_order_acknowledgments").insert({ work_order_id: woId, order_num: `ΕΝΤ-IT-${run}`, ack_token: token, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() }).select("id").single();
        if (ack.error) throw ack.error;
        ackIds.push(ack.data.id);
        const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
        const first = await anon.rpc("complete_work_order_ack", { p_token: token });
        if (first.error) throw first.error;
        const row1 = Array.isArray(first.data) ? first.data[0] : first.data;
        assert(row1?.success === true && row1?.work_order_id === woId, "public ACK first use did not succeed");
        const replay = await anon.rpc("complete_work_order_ack", { p_token: token });
        if (replay.error) throw replay.error;
        const row2 = Array.isArray(replay.data) ? replay.data[0] : replay.data;
        assert(row2?.success === false, "public ACK token replay succeeded");
        return { firstUse: true, replayDenied: true };
      });

      const allOk = results.length >= 9 && results.every((x) => x.ok);
      return json(req, { ok: allOk, previewRef: ref, run, realNetwork: true, results }, allOk ? 200 : 500);
    } finally {
      for (const p of storagePaths) { try { await admin.storage.from("attachments").remove([p]); } catch (_) {} }
      for (const id of ackIds) { try { await admin.from("work_order_acknowledgments").delete().eq("id", id); } catch (_) {} }
      for (const id of workOrderIds) { try { await admin.from("rodios_work_orders").delete().eq("id", id); } catch (_) {} }
      for (const id of issueIds) { try { await admin.from("rodios_issues").delete().eq("id", id); } catch (_) {} }
      for (const id of profileIds) { try { await admin.from("rodios_app_users").delete().eq("id", id); } catch (_) {} }
      for (const id of createdUserIds) { try { await admin.auth.admin.deleteUser(id); } catch (_) {} }
      for (const entry of realtimeChannels) { try { await entry.client.removeChannel(entry.channel); } catch (_) {} }
      try { await admin.from("rodios_sequences").delete().eq("kind", "issue").eq("year", seqYear); } catch (_) {}
    }
  } catch (e) {
    return json(req, { ok: false, function: FUNCTION_NAME, error: errorDetail(e), results: diagnostics }, 500);
  }
});
