const https = require("https");
const fs = require("fs");
const readline = require("readline");

// ============================================================
const REF_CODE = "V7WYF9"; // ref lo
const AKUN_FILE = "akun.txt";
// ============================================================

const HEADERS_BASE = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "Upgrade-Insecure-Requests": "1",
};

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

// ─── HTTP Request ─────────────────────────────────────────────
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

// ─── HTML parser minimal ──────────────────────────────────────
function extractInputValue(html, name) {
  const re = new RegExp(`<input[^>]+name=["']${name}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0] || "";
  return tag.match(/value=["']([^"']*)["']/i)?.[1] ?? null;
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

// ─── Flow ─────────────────────────────────────────────────────
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
  console.log(`[${label}] Mulai proses...`);

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
  const r2 = await request(jar, `https://api.twitter.com/oauth/authenticate?oauth_token=${oauth_token}`, {
    headers: { Referer: "https://gotchafi.com/" },
  });
  console.log(`[${label}]   Status: ${r2.status} | URL: ${r2.finalUrl.slice(0, 80)}`);

  if (r2.finalUrl.includes("gotchafi.com") && r2.finalUrl.includes("oauth_verifier")) {
    console.log(`[${label}]   Auto-authorized!`);
    return finishCallback(jar, r2.finalUrl, label);
  }

  // Step 3
  console.log(`[${label}] Step 3: Parse form authorize...`);
  const authenticity_token = extractInputValue(r2.body, "authenticity_token");
  if (!authenticity_token) {
    if (r2.finalUrl.includes("login") || r2.finalUrl.includes("x.com"))
      return { label, status: "GAGAL", error: "Cookie expired / tidak valid" };
    return { label, status: "GAGAL", error: `Tidak bisa parse form. URL: ${r2.finalUrl}` };
  }
  console.log(`[${label}]   Got authenticity_token ✓`);

  // Step 4
  console.log(`[${label}] Step 4: Submit authorize...`);
  const body = new URLSearchParams({
    authenticity_token,
    oauth_token,
    redirect_after_login: `https://api.twitter.com/oauth/authenticate?oauth_token=${oauth_token}`,
  }).toString();

  const r4 = await request(jar, "https://api.twitter.com/oauth/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `https://api.twitter.com/oauth/authenticate?oauth_token=${oauth_token}`,
      Origin: "https://api.twitter.com",
      "X-Csrf-Token": account.ct0,
    },
    body,
  });
  console.log(`[${label}]   Status: ${r4.status} | URL: ${r4.finalUrl.slice(0, 80)}`);

  if (r4.finalUrl.includes("gotchafi.com")) return finishCallback(jar, r4.finalUrl, label);

  return { label, status: "GAGAL", error: `Unexpected URL: ${r4.finalUrl}` };
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
    accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.label}`));
    const num = parseInt(await ask("Nomor akun: "), 10);
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
    try { results.push(await connectAccount(acc)); }
    catch (e) { results.push({ label: acc.label, status: "ERROR", error: e.message }); }
  }

  console.log("\n========== SUMMARY ==========");
  for (const r of results) {
    if (r.status === "BERHASIL")
      console.log(`✅ ${r.label}: BERHASIL | gf_sess: ${r.gf_sess || "-"}`);
    else
      console.log(`❌ ${r.label}: ${r.status} | ${r.error || ""}`);
  }

  fs.writeFileSync("hasil_connect.json", JSON.stringify(results, null, 2));
  console.log("\nHasil disimpan ke hasil_connect.json");
}

main();
