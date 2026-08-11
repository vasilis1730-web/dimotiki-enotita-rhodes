import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.110.9";

const PROD_REF = "nzrdcgmrsfdmocyhfrod";
const FUNCTION_NAME = "staging-real-integration";
const EMAIL_TEST_NONCE_SHA256 = "14e516bf027296394e22c880abb54f3ca469f8ba52fa6221ac737bb949b008bd";

type TestResult = { name: string; ok: boolean; durationMs?: number; detail?: unknown };

function withTimeout<T>(promise: Promise<T>, ms: number, label: string | (() => string)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const currentLabel = typeof label === "function" ? label() : label;
      reject(new Error(`${currentLabel} timeout after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

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

function decodeOptionalPdfFixture(value: unknown): Uint8Array | null {
  const raw = String(value || "").replace(/\s+/g, "");
  if (!raw) return null;
  if (raw.length > 5_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) {
    throw new Error("Invalid or oversized PDF fixture");
  }
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  assert(bytes.length > 128 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-", "PDF fixture is not a PDF");
  return bytes;
}

function tamperSignedPdfByte(bytes: Uint8Array): Uint8Array {
  const copy = bytes.slice();
  const text = new TextDecoder("windows-1252").decode(copy);
  const match = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  assert(match, "PDF fixture has no ByteRange");
  const firstStart = Number(match[1]), firstLength = Number(match[2]);
  const secondStart = Number(match[3]), secondLength = Number(match[4]);
  const candidates = [Math.max(firstStart + 16, 128), secondStart + Math.min(32, Math.max(0, secondLength - 1))];
  const offset = candidates.find((x) => Number.isSafeInteger(x) && x >= firstStart && x < firstStart + firstLength && x < copy.length)
    ?? candidates.find((x) => Number.isSafeInteger(x) && x >= secondStart && x < secondStart + secondLength && x < copy.length);
  assert(offset !== undefined, "No safe signed byte available for tampering");
  copy[offset] ^= 0x01;
  return copy;
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
  }
  return btoa(out);
}

async function sha256Text(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function decodeOptionalEmailFixture(value: unknown): Promise<{ to: string } | null> {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const nonce = String(input.nonce || "");
  assert(nonce.length === 64 && await sha256Text(nonce) === EMAIL_TEST_NONCE_SHA256, "Email fixture authorization failed");
  const to = String(input.to || "").trim().toLowerCase();
  assert(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to) && to.length <= 254, "Email fixture recipient is invalid");
  return { to };
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

    const requestText = await req.text();
    if (requestText.length > 5_100_000) return json(req, { ok: false, error: "Request fixture is too large" }, 413);
    let requestBody: Record<string, unknown> = {};
    if (requestText.trim()) {
      try { requestBody = JSON.parse(requestText); }
      catch { return json(req, { ok: false, error: "Invalid JSON" }, 400); }
    }
    const pdfFixture = decodeOptionalPdfFixture(requestBody.pdfBase64);
    const emailFixture = await decodeOptionalEmailFixture(requestBody.emailTest);

    const run = `${Date.now().toString(36)}_${randomText(5)}`;
    const password = `R0dios-${randomText(12)}!Aa1`;
    const results = diagnostics;
    const createdUserIds: string[] = [];
    const profileIds: string[] = [];
    const storagePaths: string[] = [];
    const issueIds: string[] = [];
    const workOrderIds: string[] = [];
    const ackIds: string[] = [];
    const pdfProofIds: string[] = [];
    const protocolPaths: string[] = [];
    let emailSettingsOriginal: Record<string, unknown> | null = null;
    const realtimeChannels: Array<{ client: SupabaseClient; channel: any }> = [];
    const seqYear = new Date().getUTCFullYear() + 1;
    const suiteDeadline = Date.now() + 90_000;

    const emails = {
      admin: `it-admin-${run}@example.invalid`,
      manager: `it-manager-${run}@example.invalid`,
      user: `it-user-${run}@example.invalid`,
      orphan: `it-orphan-${run}@example.invalid`,
    };

    async function addResult(name: string, fn: (mark: (stage: string) => void) => Promise<unknown>) {
      const started = Date.now();
      const remaining = suiteDeadline - started;
      let stage = "start";
      const mark = (nextStage: string) => { stage = nextStage; };
      if (remaining <= 0) {
        results.push({ name, ok: false, durationMs: 0, detail: { message: "Integration suite time budget exhausted" } });
        return undefined;
      }
      try {
        const detail = await withTimeout(fn(mark), Math.min(30_000, remaining), () => `${name} [${stage}]`);
        results.push({ name, ok: true, durationMs: Date.now() - started, detail });
        return detail;
      }
      catch (e) { results.push({ name, ok: false, durationMs: Date.now() - started, detail: errorDetail(e) }); return undefined; }
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

      await addResult("real_two_session_atomic_concurrency_realtime", async (mark) => {
        assert(clients.manager && clients.user, "manager/user clients unavailable for concurrency test");
        const subscribe = async (client: SupabaseClient, label: string) => {
          const events: any[] = [];
          const channel = client.channel(`rodios_${label}_${run}`)
            .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rodios_issues", filter: `id=eq.${issueId}` }, (payload: any) => events.push(payload));
          realtimeChannels.push({ client, channel });
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${label} Realtime subscription timeout`)), 12_000);
            channel.subscribe((status: string) => {
                if (status === "SUBSCRIBED") { clearTimeout(timer); resolve(); }
                if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { clearTimeout(timer); reject(new Error(`${label} Realtime status ${status}`)); }
              });
          });
          return events;
        };

        mark("subscribe-realtime");
        const [managerEvents, userEvents] = await Promise.all([
          subscribe(clients.manager, "manager"),
          subscribe(clients.user, "user"),
        ]);
        mark("read-baseline");
        const before = await admin.from("rodios_issues").select("data,updated_at").eq("id", issueId).single();
        if (before.error) throw before.error;
        const managerData = { ...before.data.data, title: `CONCURRENT MANAGER ${run}` };
        const userData = { ...before.data.data, title: `CONCURRENT USER ${run}` };
        const args = (data: any) => ({ p_bundle: { issues: { upserts: [{ id: issueId, data, expectedUpdatedAt: before.data.updated_at }], deletes: [] } } });
        mark("invoke-concurrent-rpcs");
        const [managerWrite, userWrite] = await Promise.all([
          clients.manager.rpc("rodios_save_bundle", args(managerData)),
          clients.user.rpc("rodios_save_bundle", args(userData)),
        ]);
        const writes = [managerWrite, userWrite];
        assert(writes.filter((x) => !x.error && x.data?.ok === true).length === 1, "concurrent same-version writes did not produce exactly one winner");
        const loser = writes.find((x) => !!x.error);
        assert(loser?.error?.code === "PT409" && String(loser.error.message || "").includes("RODIOS_SYNC_CONFLICT"), "concurrent loser was not rejected as an HTTP 409 atomic sync conflict");

        mark("await-realtime-events");
        const deadline = Date.now() + 10_000;
        while ((managerEvents.length < 1 || userEvents.length < 1) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
        assert(managerEvents.length >= 1, "manager session did not receive the concurrent Realtime update");
        assert(userEvents.length >= 1, "user session did not receive the concurrent Realtime update");
        mark("read-final-row");
        const finalRow = await admin.from("rodios_issues").select("data,updated_at").eq("id", issueId).single();
        if (finalRow.error) throw finalRow.error;
        assert([managerData.title, userData.title].includes(finalRow.data.data?.title), "concurrent winner was not the final stored row");
        return { oneWinner: true, staleLoserDenied: true, managerRealtimeEvents: managerEvents.length, userRealtimeEvents: userEvents.length, finalTitle: finalRow.data.data.title };
      });

      await addResult("real_atomic_bundle_rollback", async (mark) => {
        assert(clients.admin && clients.manager && clients.user, "clients unavailable for atomic rollback test");
        const a = `it_rollback_a_${run}`;
        const b = `it_rollback_b_${run}`;
        issueIds.push(a, b);
        mark("create-baseline");
        const create = await clients.admin.rpc("rodios_save_bundle", { p_bundle: { issues: { upserts: [
          { id: a, data: { id: a, title: "ROLLBACK A ORIGINAL", source: "integration" }, expectedUpdatedAt: null },
          { id: b, data: { id: b, title: "ROLLBACK B ORIGINAL", source: "integration" }, expectedUpdatedAt: null },
        ], deletes: [] } } });
        if (create.error) throw create.error;
        mark("read-baseline");
        const baseline = await admin.from("rodios_issues").select("id,data,updated_at").in("id", [a,b]);
        if (baseline.error) throw baseline.error;
        const rowA = baseline.data.find((x: any) => x.id === a);
        const rowB = baseline.data.find((x: any) => x.id === b);
        assert(rowA?.updated_at && rowB?.updated_at, "rollback baselines missing");

        mark("advance-second-row");
        const advanceB = await clients.manager.rpc("rodios_save_bundle", { p_bundle: { issues: { upserts: [{ id: b, data: { ...rowB.data, title: "ROLLBACK B ADVANCED" }, expectedUpdatedAt: rowB.updated_at }], deletes: [] } } });
        if (advanceB.error) throw advanceB.error;
        mark("invoke-stale-bundle");
        const staleBundle = await clients.user.rpc("rodios_save_bundle", { p_bundle: { issues: { upserts: [
          { id: a, data: { ...rowA.data, title: "ROLLBACK A MUST NOT PERSIST" }, expectedUpdatedAt: rowA.updated_at },
          { id: b, data: { ...rowB.data, title: "ROLLBACK B STALE MUST NOT PERSIST" }, expectedUpdatedAt: rowB.updated_at },
        ], deletes: [] } } });
        assert(staleBundle.error?.code === "PT409" && String(staleBundle.error.message || "").includes("RODIOS_SYNC_CONFLICT"), "stale multi-row bundle was not rejected as an HTTP 409 atomic sync conflict");
        mark("read-after-rollback");
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

      const interruptedPath = `integration/${run}/interrupted-retry.bin`;
      storagePaths.push(interruptedPath);
      await addResult("real_interrupted_upload_retry_reload", async (mark) => {
        assert(clients.user, "active user client unavailable for interrupted upload test");
        const { data: sessionData, error: sessionError } = await clients.user.auth.getSession();
        if (sessionError) throw sessionError;
        const accessToken = sessionData.session?.access_token;
        assert(accessToken, "active user access token missing for raw Storage upload");

        const totalBytes = 8 * 1024 * 1024;
        const chunkBytes = 64 * 1024;
        let producedBytes = 0;
        let streamCancelled = false;
        const slowBody = new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 35));
            if (streamCancelled) return;
            const remaining = totalBytes - producedBytes;
            if (remaining <= 0) { controller.close(); return; }
            const size = Math.min(chunkBytes, remaining);
            const chunk = new Uint8Array(size);
            chunk.fill((producedBytes / chunkBytes) % 251);
            producedBytes += size;
            controller.enqueue(chunk);
          },
          cancel() { streamCancelled = true; },
        });
        const encodedPath = interruptedPath.split("/").map(encodeURIComponent).join("/");
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), 220);
        let interrupted = false;
        let interruptionDetail = "";
        mark("interrupt-streaming-upload");
        try {
          const response = await fetch(`${supabaseUrl}/storage/v1/object/attachments/${encodedPath}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${accessToken}`,
              apikey: anonKey,
              "cache-control": "3600",
              "content-type": "application/octet-stream",
              "x-upsert": "false",
            },
            body: slowBody,
            signal: controller.signal,
          });
          interruptionDetail = `unexpected HTTP ${response.status}`;
        } catch (e) {
          interruptionDetail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          interrupted = e instanceof DOMException
            ? e.name === "AbortError"
            : /abort/i.test(interruptionDetail);
        } finally {
          clearTimeout(abortTimer);
        }
        assert(interrupted, `streaming upload was not interrupted: ${interruptionDetail}`);
        assert(producedBytes > 0 && producedBytes < totalBytes, `interruption did not occur mid-stream: produced=${producedBytes}`);

        mark("verify-no-partial-object");
        await new Promise((resolve) => setTimeout(resolve, 750));
        const partial = await admin.storage.from("attachments").download(interruptedPath);
        assert(!!partial.error, "interrupted upload left a readable partial Storage object");

        mark("retry-complete-upload");
        const retryBytes = new Uint8Array(1024 * 1024);
        for (let i = 0; i < retryBytes.length; i++) retryBytes[i] = (i * 31 + 17) % 251;
        const retry = await clients.user.storage.from("attachments").upload(
          interruptedPath,
          new Blob([retryBytes], { type: "application/octet-stream" }),
          { cacheControl: "3600", upsert: false },
        );
        if (retry.error) throw retry.error;

        mark("fresh-session-signed-reload");
        const reloadClient = await signIn(emails.user);
        const signed = await reloadClient.storage.from("attachments").createSignedUrl(interruptedPath, 60);
        if (signed.error) throw signed.error;
        assert(signed.data?.signedUrl, "fresh session did not receive a signed retry URL");
        const downloaded = await fetch(signed.data.signedUrl, { cache: "no-store" });
        assert(downloaded.ok, `fresh-session signed reload failed: HTTP ${downloaded.status}`);
        const downloadedBytes = new Uint8Array(await downloaded.arrayBuffer());
        assert(downloadedBytes.length === retryBytes.length, "retry object length changed after signed reload");
        const expectedHash = new Uint8Array(await crypto.subtle.digest("SHA-256", retryBytes));
        const actualHash = new Uint8Array(await crypto.subtle.digest("SHA-256", downloadedBytes));
        const hashHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
        assert(hashHex(actualHash) === hashHex(expectedHash), "retry object bytes changed after signed reload");

        return {
          interruptionObserved: true,
          producedBeforeAbort: producedBytes,
          partialObjectAbsent: true,
          retryBytes: retryBytes.length,
          freshSessionSignedReload: true,
          sha256: hashHex(actualHash),
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

      if (pdfFixture) {
        await addResult("real_municipal_signed_and_tampered_pdf", async (mark) => {
          assert(clients.admin, "admin client unavailable for PDF verification test");
          mark("verify-known-good-municipal-pdf");
          const valid = await clients.admin.functions.invoke("verify-pdf-signatures", {
            body: {
              workOrderIds: [woId],
              pdfName: "municipal-signed-e2e.pdf",
              pdfBase64: bytesToBase64(pdfFixture),
            },
          });
          if (valid.error) throw valid.error;
          assert(valid.data?.verified === true && valid.data?.integrityOk === true, "known-good municipal signed PDF was rejected");
          assert(valid.data?.detectedCount >= 1 && valid.data?.count === valid.data?.detectedCount, "known-good signature count mismatch");
          assert(valid.data?.verificationProofId && valid.data?.protocolPath, "known-good PDF did not create a verification proof");
          pdfProofIds.push(String(valid.data.verificationProofId));
          protocolPaths.push(String(valid.data.protocolPath));

          mark("verify-tampered-municipal-pdf");
          const tampered = tamperSignedPdfByte(pdfFixture);
          const invalid = await clients.admin.functions.invoke("verify-pdf-signatures", {
            body: {
              workOrderIds: [woId],
              pdfName: "municipal-tampered-e2e.pdf",
              pdfBase64: bytesToBase64(tampered),
            },
          });
          if (invalid.error) throw invalid.error;
          assert(invalid.data?.verified === false && invalid.data?.integrityOk === false, "tampered municipal PDF was accepted");
          assert(!invalid.data?.verificationProofId && !invalid.data?.protocolPath, "tampered PDF created a proof or protocol object");
          return {
            validAccepted: true,
            detectedSignatures: valid.data.detectedCount,
            cryptographicSignatures: valid.data.count,
            finalRevisionCovered: valid.data.details?.every((x: any) => x?.coversFinalRevision === true) === true,
            tamperedRejected: true,
            trustMode: valid.data.trustMode,
          };
        });
      }

      if (emailFixture) {
        await addResult("real_email_delivery_and_ack_lifecycle", async (mark) => {
          assert(clients.admin, "admin client unavailable for email/ACK test");
          mark("configure-preview-recipient");
          const settings = await admin.from("rodios_settings").select("value").eq("key", "main").single();
          if (settings.error) throw settings.error;
          emailSettingsOriginal = settings.data.value || {};
          const configure = await admin.from("rodios_settings").update({ value: { ...emailSettingsOriginal, contractorEmail: emailFixture.to } }).eq("key", "main");
          if (configure.error) throw configure.error;

          const token = randomText(24);
          const ack = await admin.from("work_order_acknowledgments").insert({
            work_order_id: woId,
            order_num: `ΕΝΤ-PREVIEW-${run}`,
            ack_token: token,
            expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          }).select("id").single();
          if (ack.error) throw ack.error;
          ackIds.push(ack.data.id);

          mark("send-real-preview-email");
          const sent = await clients.admin.functions.invoke("send-order-email", {
            body: {
              to: emailFixture.to,
              subject: "RODIOS PRE-PRODUCTION TEST — EMAIL / ACK",
              body: `ΑΥΤΟΜΑΤΗ ΔΟΚΙΜΗ PRE-PRODUCTION — ΔΕΝ ΑΠΑΙΤΕΙΤΑΙ ΚΑΜΙΑ ΕΝΕΡΓΕΙΑ.\nACK-PREVIEW-TOKEN:${token}\nΗ επιβεβαίωση εκτελείται αυτόματα μόνο στο προσωρινό Preview.`,
              attachments: [],
            },
          });
          if (sent.error) throw sent.error;
          assert(sent.data?.ok === true && Array.isArray(sent.data?.accepted) && sent.data.accepted.length === 1 && sent.data?.rejected?.length === 0, "SMTP did not accept exactly one preview recipient");

          mark("complete-and-replay-preview-ack");
          const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
          const first = await anon.rpc("complete_work_order_ack", { p_token: token });
          if (first.error) throw first.error;
          const firstRow = Array.isArray(first.data) ? first.data[0] : first.data;
          assert(firstRow?.success === true && firstRow?.work_order_id === woId, "email-linked ACK first use failed");
          const replay = await anon.rpc("complete_work_order_ack", { p_token: token });
          if (replay.error) throw replay.error;
          const replayRow = Array.isArray(replay.data) ? replay.data[0] : replay.data;
          assert(replayRow?.success === false, "email-linked ACK replay succeeded");

          mark("restore-preview-recipient");
          const restore = await admin.from("rodios_settings").update({ value: emailSettingsOriginal }).eq("key", "main");
          if (restore.error) throw restore.error;
          emailSettingsOriginal = null;
          return { smtpAccepted: true, acknowledgedOnce: true, replayDenied: true, settingsRestored: true };
        });
      }

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
      // Close Realtime while the corresponding Auth sessions still exist. Every
      // cleanup phase is bounded so test teardown can never consume the Edge
      // runtime's 150-second idle budget and hide the actual assertion results.
      await Promise.allSettled(realtimeChannels.map((entry) =>
        withTimeout(entry.client.removeChannel(entry.channel), 3_000, "Realtime cleanup")
      ));
      if (storagePaths.length) {
        try { await withTimeout(admin.storage.from("attachments").remove([...new Set(storagePaths)]), 5_000, "Storage cleanup"); } catch (_) {}
      }
      if (ackIds.length) {
        try { await withTimeout(Promise.resolve(admin.from("work_order_acknowledgments").delete().in("id", [...new Set(ackIds)])), 5_000, "ACK cleanup"); } catch (_) {}
      }
      if (pdfProofIds.length) {
        try { await withTimeout(Promise.resolve(admin.from("rodios_pdf_verification_proofs").delete().in("id", [...new Set(pdfProofIds)])), 5_000, "PDF proof cleanup"); } catch (_) {}
      }
      if (protocolPaths.length) {
        try { await withTimeout(admin.storage.from("protocols").remove([...new Set(protocolPaths)]), 5_000, "Protocol cleanup"); } catch (_) {}
      }
      if (emailSettingsOriginal) {
        try { await withTimeout(Promise.resolve(admin.from("rodios_settings").update({ value: emailSettingsOriginal }).eq("key", "main")), 5_000, "Email settings cleanup"); } catch (_) {}
      }
      if (workOrderIds.length) {
        try { await withTimeout(Promise.resolve(admin.from("rodios_work_orders").delete().in("id", [...new Set(workOrderIds)])), 5_000, "Work-order cleanup"); } catch (_) {}
      }
      if (issueIds.length) {
        try { await withTimeout(Promise.resolve(admin.from("rodios_issues").delete().in("id", [...new Set(issueIds)])), 5_000, "Issue cleanup"); } catch (_) {}
      }
      if (profileIds.length) {
        try { await withTimeout(Promise.resolve(admin.from("rodios_app_users").delete().in("id", [...new Set(profileIds)])), 5_000, "Profile cleanup"); } catch (_) {}
      }
      await Promise.allSettled(createdUserIds.map((id) =>
        withTimeout(admin.auth.admin.deleteUser(id), 5_000, "Auth cleanup")
      ));
      try {
        await withTimeout(
          Promise.resolve(admin.from("rodios_sequences").delete().eq("kind", "issue").eq("year", seqYear)),
          5_000,
          "Sequence cleanup",
        );
      } catch (_) {}
    }
  } catch (e) {
    return json(req, { ok: false, function: FUNCTION_NAME, error: errorDetail(e), results: diagnostics }, 500);
  }
});
