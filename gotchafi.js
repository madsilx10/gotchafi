const https = require("https");
const fs = require("fs");
const readline = require("readline");

// ============================================================
const REF_CODE = "V7WYF9"; // ref lo
const AKUN_FILE = "akun.txt";
const DELAY_TASK = 1500;  // ms antar task dalam 1 akun
const DELAY_AKUN = 3000;  // ms antar akun
// ============================================================

const TASKS = ["follow", "like", "rt", "comment", "broadcast"];

const HEADERS_BASE = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "Upgrade-Insecure-Requests": "1",
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Cookie Jar ───────────────────────────────────────────────
function createJar() {
  const store = {}; // domain → { name: value }
  return {
    set(cookieStr, url) {
      const domain = new URL(url).hostname;
      if (!store[domain]) store[domain] = {};
      for (const part of cookieStr.split(/,(?=[^ ])/)) {
        const [pair] = part.trim().split(";");
        const eq = pair.indexOf("=");
        if (eq < 0) continue;
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        store[domain][k] = v;
      }
    },
    setRaw(key, value, url) {
      const domain = new URL(url).hostname;
      if (!store[domain]) store[domain] = {};
      store[domain][key] = value;
    },
    get(url) {
      const host = new URL(url).hostname;
      const merged = {};
      for (const [domain, cookies] of Object.entries(store)) {
        if (host === domain || host.endsWith("." + domain) || domain.startsWith(".") && host.endsWith(domain))
          Object.assign(merged, cookies);
      }
      return Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("; ");
    },
    getKey(key, url) {
      const host = new URL(url).hostname;
      for (const [domain, cookies] of Object.entries(store)) {
        if (host === domain || host.endsWith("." + domain))
          if (cookies[key]) return cookies[key];
      }
      return null;
    },
  };
}

// ─── HTTP Request (flow OAuth, pakai cookie jar) ───────────────
function request(jar, url, { method = "GET", headers = {}, body, followRedirects = true } = {}) {
  return new Promise((resolve, reject) => {
    const doReq = (currentUrl, currentMethod, currentBody, hops) => {
      if (hops > 10) return reject(new Error("Too many redirects"));
      const parsed = new URL(currentUrl);
      const cookieStr = jar.get(currentUrl);
      const reqHeaders = { ...HEADERS_BASE, ...headers };
      if (cookieStr) reqHeaders["Cookie"] = cookieStr;
      if (currentBody) reqHeaders["Content-Length"] = Buffer.byteLength(currentBody);

      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: currentMethod,
        headers: reqHeaders,
      };

      const req = https.request(options, (res) => {
        // Save cookies
        const setCookies = res.headers["set-cookie"] || [];
        for (const c of setCookies) jar.set(c, currentUrl);

        if (followRedirects && [301, 302, 303, 307, 308].includes(res.statusCode)) {
          let loc = res.headers["location"];
          if (!loc) return reject(new Error("Redirect tanpa Location"));
          if (!loc.startsWith("http")) loc = new URL(loc, currentUrl).href;
          // consume body
          res.resume();
          const nextMethod = [307, 308].includes(res.statusCode) ? currentMethod : "GET";
          const nextBody = nextMethod === "GET" ? undefined : currentBody;
          return doReq(loc, nextMethod, nextBody, hops + 1);
        }

        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data, finalUrl: currentUrl }));
      });

      req.on("error", reject);
      if (currentBody) req.write(currentBody);
      req.end();
    };

    doReq(url, method, body, 0);
  });
}

// ─── HTTP Request (task API, pakai gf_sess doang) ──────────────
function requestTask(gf_sess, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: "gotchafi.com",
      path,
      method: "POST",
      headers: {
        "User-Agent": HEADERS_BASE["User-Agent"],
        "Accept": "*/*",
        "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Origin": "https://gotchafi.com",
        "Referer": "https://gotchafi.com/",
        "Cookie": `gf_sess=${gf_sess}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ─── HTML parser minimal ──────────────────────────────────────
function extractInputValue(html, name) {
  const re = new RegExp(`<input[^>]+name=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0] || "";
  return tag.match(/value=["']([^"']*)["']/i)?.[1] ?? null;
}

// Ekstrak SEMUA <form>...</form> beserta seluruh <input> di dalamnya.
// Ini menggantikan pendekatan "nebak field" — kita ambil field apa adanya
// dari HTML asli (termasuk tombol submit "Authorize app" / hidden token lain
// yang mungkin tidak kita tahu namanya sebelumnya).
function extractForms(html) {
  const forms = [];
  const formRe = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = formRe.exec(html))) {
    const fullTag = m[0];
    const inner = m[1];
    const action = fullTag.match(/action=["']([^"']*)["']/i)?.[1] || null;
    const fields = {};
    let submit = null; // {name, value} tombol submit, kalau ada
    const inputRe = /<input\b([^>]*)>/gi;
    let im;
    while ((im = inputRe.exec(inner))) {
      const attrs = im[1];
      const name = attrs.match(/name=["']([^"']*)["']/i)?.[1];
      if (!name) continue;
      const value = attrs.match(/value=["']([^"']*)["']/i)?.[1] ?? "";
      const type = (attrs.match(/type=["']([^"']*)["']/i)?.[1] || "text").toLowerCase();
      fields[name] = value;
      if (type === "submit") submit = { name, value };
    }
    // Parse <button> tags — X render "Authorize app" sebagai <button>, bukan <input type=submit>
    const buttonRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    let bm;
    while ((bm = buttonRe.exec(inner))) {
      const attrs = bm[1];
      const innerText = bm[2].replace(/<[^>]+>/g, "").trim();
      const type = (attrs.match(/type=["']([^"']*)["']/i)?.[1] || "submit").toLowerCase();
      if (type !== "submit") continue;
      const name = attrs.match(/name=["']([^"']*)["']/i)?.[1];
      const value = attrs.match(/value=["']([^"']*)["']/i)?.[1] ?? innerText;
      if (name) submit = { name, value };
      else submit = { name: null, value };
    }
    forms.push({ action, fields, submit });
  }
  return forms;
}

// ─── Akun ─────────────────────────────────────────────────────
function loadAccounts(filepath) {
  const content = fs.readFileSync(filepath, "utf-8");
  const blocks = content.trim().split(/\n\n+/).filter(b => b.trim());
  const accounts = [];
  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) { console.log(`[!] Block ${i + 1} tidak valid, skip`); continue; }
    accounts.push({ label: `akun${i + 1}`, auth_token: lines[0], ct0: lines[1] });
  }
  console.log(`[*] Total akun dimuat: ${accounts.length}`);
  return accounts;
}

function seedCookies(jar, auth_token, ct0) {
  for (const domain of ["twitter.com", "api.twitter.com", "x.com", "api.x.com"]) {
    jar.setRaw("auth_token", auth_token, `https://${domain}`);
    jar.setRaw("ct0", ct0, `https://${domain}`);
  }
}

// ─── Flow Connect X ─────────────────────────────────────────────
async function finishCallback(jar, url, label) {
  console.log(`[${label}] Step 5: Proses callback...`);
  const gf_sess = jar.getKey("gf_sess", "https://gotchafi.com");
  console.log(`[${label}]   gf_sess: ${gf_sess}`);
  const r = await request(jar, "https://gotchafi.com/?x=1");
  console.log(`[${label}]   Final: ${r.status} ${r.finalUrl}`);
  return { label, status: "BERHASIL", gf_sess, final_url: r.finalUrl };
}

async function connectAccount(account) {
  const { label } = account;
  console.log(`\n${"=".repeat(50)}`);
  console.log(`[${label}] Mulai proses connect...`);

  const jar = createJar();
  seedCookies(jar, account.auth_token, account.ct0);

  // Step 1
  console.log(`[${label}] Step 1: Request oauth_token...`);
  const r1 = await request(jar, `https://gotchafi.com/auth/x/login?ref=${REF_CODE}`, { followRedirects: false });
  const location = r1.headers["location"] || "";
  const tokenMatch = location.match(/oauth_token=([^&]+)/);
  if (!tokenMatch) return { label, status: "GAGAL", error: "Tidak dapat oauth_token" };
  const oauth_token = tokenMatch[1];
  console.log(`[${label}]   oauth_token: ${oauth_token}`);

  // Step 2
  console.log(`[${label}] Step 2: Load halaman authorize Twitter...`);
  const r2 = await request(jar, `https://x.com/oauth/authorize?oauth_token=${oauth_token}`, {
    headers: { Referer: "https://gotchafi.com/" },
  });
  console.log(`[${label}]   Status: ${r2.status} | URL: ${r2.finalUrl.slice(0, 80)}`);

  if (r2.finalUrl.includes("gotchafi.com") && r2.finalUrl.includes("oauth_verifier")) {
    console.log(`[${label}]   Auto-authorized!`);
    return finishCallback(jar, r2.finalUrl, label);
  }

  // Step 3 — ambil SEMUA field form apa adanya, bukan nebak nama field
  console.log(`[${label}] Step 3: Parse form authorize...`);
  const isLoginPage = r2.finalUrl.includes("/login") || r2.finalUrl.includes("/i/flow/login");
  const isOAuthPage = r2.finalUrl.includes("/oauth/authorize") || r2.finalUrl.includes("/oauth/authenticate");
  if (isLoginPage || (!isOAuthPage && !r2.finalUrl.includes("gotchafi.com"))) {
    return { label, status: "GAGAL", error: `Cookie expired / tidak valid (landed: ${r2.finalUrl})` };
  }

  const forms = extractForms(r2.body);
  console.log(`[${label}]   Total form ditemukan: ${forms.length}`);
  forms.forEach((f, idx) => {
    console.log(`[${label}]     form[${idx}] action="${f.action}" fields=[${Object.keys(f.fields).join(", ")}] submit=${f.submit ? `${f.submit.name}=${f.submit.value}` : "-"}`);
  });

  // Form yang benar: form OAuth 1.0a authorize SELALU punya field oauth_token.
  // Dulu kita nebak nama field CSRF-nya ("authenticity_token"), tapi itu bisa
  // beda-beda tergantung markup yang lagi di-serve X saat ini — jadi sekarang
  // kita cari berdasarkan field yang pasti ada (oauth_token), lalu di antara
  // form yang lolos, pilih yang tombolnya BUKAN "cancel" / "deny" / "batal".
  const candidates = forms.filter(f => f.fields.oauth_token !== undefined);
  const authorizeForm =
    candidates.find(f => f.submit && !/cancel|deny|batal/i.test(f.submit.value + f.submit.name)) ||
    candidates[0] ||
    // fallback terakhir: kalau gak ada form dengan oauth_token eksplisit,
    // pakai form manapun yang tombolnya jelas bukan cancel/deny
    forms.find(f => f.submit && !/cancel|deny|batal/i.test(f.submit.value + f.submit.name));

  if (!authorizeForm) {
    // Simpan HTML mentah supaya bisa diperiksa manual tanpa perlu buka browser lagi
    const dumpPath = `debug_step2_${label}.html`;
    fs.writeFileSync(dumpPath, r2.body);
    const hint = /suspend|locked|verify your identity|whoa there/i.test(r2.body)
      ? " (kemungkinan akun ke-suspend/locked/rate-limit, cek isi HTML-nya)"
      : "";
    return { label, status: "GAGAL", error: `Tidak ada form authorize ditemukan${hint}. HTML disimpan ke ${dumpPath}` };
  }
  console.log(`[${label}]   Form ditemukan, action: "${authorizeForm.action}", fields: ${Object.keys(authorizeForm.fields).join(", ")}`);
  if (authorizeForm.submit) console.log(`[${label}]   Submit button: ${authorizeForm.submit.name}=${authorizeForm.submit.value}`);

  // Step 4 — kirim field APA ADANYA dari form (bukan set manual 3 field),
  // lalu timpa oauth_token supaya konsisten dengan token yang kita pegang.
  console.log(`[${label}] Step 4: Submit authorize...`);
  const fieldsToSend = { ...authorizeForm.fields, oauth_token };
  // Buang field cancel — jangan ikut terkirim
  delete fieldsToSend["cancel"];
  // Kalau ada submit button yang bukan cancel, ikutkan; kalau null name, skip saja
  if (authorizeForm.submit && authorizeForm.submit.name && !/cancel|deny/i.test(authorizeForm.submit.value)) {
    fieldsToSend[authorizeForm.submit.name] = authorizeForm.submit.value;
  }
  const body = new URLSearchParams(fieldsToSend).toString();

  const postAction = (authorizeForm.action && authorizeForm.action.length > 0)
    ? new URL(authorizeForm.action, r2.finalUrl).href
    : r2.finalUrl; // action="" atau tidak ada action → submit ke URL halaman itu sendiri (spek HTML), BUKAN tebakan endpoint
  console.log(`[${label}]   POST ke: ${postAction}`);

  // Pakai ct0 TERBARU dari cookie jar (bisa di-rotate Twitter via Set-Cookie
  // di step 1/2), bukan nilai statis dari akun.txt — X-Csrf-Token wajib match
  // cookie ct0 yang aktif saat request, kalau tidak match, Twitter diam-diam
  // lempar balik ke halaman default x.com (bukan kasih pesan error).
  // Catatan: ini flow OAuth 1.0a form HTML biasa (bukan endpoint API modern
  // kayak x.com/i/api/2/oauth2/authorize), jadi CSRF-nya dihandle lewat field
  // tersembunyi di form itu sendiri (yang udah ikut ke-submit di `fieldsToSend`),
  // BUKAN lewat header X-Csrf-Token — makanya header itu dibuang, soalnya
  // nambahin header API-style ke request form-submit biasa bisa bikin server
  // curiga/nolak diam-diam.
  const r4 = await request(jar, postAction, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `https://x.com/oauth/authorize?oauth_token=${oauth_token}`,
      Origin: "https://x.com",
    },
    body,
  });
  console.log(`[${label}]   Status: ${r4.status} | URL: ${r4.finalUrl.slice(0, 80)}`);

  if (r4.finalUrl.includes("gotchafi.com")) return finishCallback(jar, r4.finalUrl, label);

  // X redirect via <meta http-equiv="refresh"> bukan HTTP 301/302
  const metaRefresh = r4.body.match(/content=["']0;url=([^"']+)["']/i);
  if (metaRefresh) {
    const callbackUrl = metaRefresh[1].replace(/&amp;/g, "&");
    console.log(`[${label}]   Meta-refresh → ${callbackUrl.slice(0, 80)}`);
    // PENTING: callbackUrl di sini cuma diekstrak dari HTML, belum pernah
    // benar-benar di-request. gf_sess di-set via Set-Cookie saat request INI
    // dijalankan — jadi jangan langsung ke finishCallback tanpa nge-fetch dulu,
    // walaupun URL-nya udah keliatan "gotchafi.com".
    const r4b = await request(jar, callbackUrl);
    console.log(`[${label}]   Follow meta: ${r4b.status} | ${r4b.finalUrl.slice(0, 80)}`);
    return finishCallback(jar, r4b.finalUrl, label);
  }

  // Gagal lagi? simpan body-nya biar bisa dibaca tanpa buka browser
  const failDumpPath = `debug_step4_${label}.html`;
  fs.writeFileSync(failDumpPath, r4.body);
  const looksLikeGenericShell = r4.body.includes("window.__INITIAL_STATE__");
  const hint = looksLikeGenericShell
    ? " (ini x.com app shell generik, bukan halaman authorize — kemungkinan CSRF/ct0 mismatch atau sesi ditolak diam-diam)"
    : "";
  console.log(`[${label}]   Body disimpan ke ${failDumpPath} (${r4.body.length} chars)${hint}`);
  return { label, status: "GAGAL", error: `Unexpected URL: ${r4.finalUrl}. Lihat ${failDumpPath}${hint}` };
}

// ─── Flow Task ──────────────────────────────────────────────────
async function runTasks(akun) {
  const { label, gf_sess } = akun;
  if (!gf_sess) {
    console.log(`[${label}] Skip task — tidak ada gf_sess`);
    return;
  }

  console.log(`[${label}] Mulai proses task... gf_sess: ${gf_sess.slice(0, 20)}...`);

  for (const task of TASKS) {
    try {
      const r = await requestTask(gf_sess, "/api/task", { task, code: REF_CODE });
      const b = r.body;
      if (typeof b === "object") {
        const done = b.done ? "✅" : "⏭";
        const already = b.already ? " (sudah dikerjakan)" : "";
        const cp = b.capsule?.cp !== undefined ? ` | cp: ${b.capsule.cp}` : "";
        console.log(`[${label}] ${done} ${task}${already}${cp}`);
      } else {
        console.log(`[${label}] ❓ ${task} | ${r.status} | ${String(b).slice(0, 100)}`);
      }
    } catch (e) {
      console.log(`[${label}] ❌ ${task} ERROR: ${e.message}`);
    }
    await sleep(DELAY_TASK);
  }
}

// ─── Gabungan: connect lalu langsung task untuk 1 akun ──────────
async function processAccount(account) {
  let result;
  try {
    result = await connectAccount(account);
  } catch (e) {
    result = { label: account.label, status: "ERROR", error: e.message };
  }

  if (result.status === "BERHASIL") {
    await runTasks(result);
  } else {
    console.log(`[${account.label}] ⏭ Skip task — connect gagal (${result.error || result.status})`);
  }

  return result;
}

// ─── Menu ─────────────────────────────────────────────────────
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, a => { rl.close(); resolve(a.trim()); }));
}

async function main() {
  const accounts = loadAccounts(AKUN_FILE);
  if (!accounts.length) { console.log("[!] Tidak ada akun."); return; }

  console.log("\nPilih mode:");
  console.log("  1 = 1 akun");
  console.log("  2 = semua");
  console.log("  3 = from X to end");
  const mode = await ask("Mode [1/2/3]: ");

  let targets = [];
  if (mode === "1") {
    const num = parseInt(await ask(`Nomor akun (1-${accounts.length}): `), 10);
    if (isNaN(num) || num < 1 || num > accounts.length) { console.log("[!] Tidak valid."); return; }
    targets = [accounts[num - 1]];
  } else if (mode === "2") {
    targets = accounts;
  } else if (mode === "3") {
    const from = parseInt(await ask(`From (1-${accounts.length}): `), 10);
    if (isNaN(from) || from < 1 || from > accounts.length) { console.log("[!] Tidak valid."); return; }
    targets = accounts.slice(from - 1);
    console.log(`[*] ${targets.length} akun (akun${from} → akun${accounts.length})`);
  } else {
    console.log("[!] Mode tidak valid."); return;
  }

  const results = [];
  for (const acc of targets) {
    const r = await processAccount(acc);
    results.push(r);
    if (acc !== targets[targets.length - 1]) await sleep(DELAY_AKUN);
  }

  console.log("\n========== SUMMARY ==========");
  for (const r of results) {
    if (r.status === "BERHASIL")
      console.log(`✅ ${r.label}: BERHASIL (connect + task) | gf_sess: ${r.gf_sess || "-"}`);
    else
      console.log(`❌ ${r.label}: ${r.status} | ${r.error || ""}`);
  }

  fs.writeFileSync("hasil_connect.json", JSON.stringify(results, null, 2));
  console.log("\nHasil disimpan ke hasil_connect.json");
}

main();
