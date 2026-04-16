/**
 * Automated OIDC login flow for University of Arizona Shibboleth + Duo 2FA.
 *
 * Reverse-engineered from Burp capture of chat.ai2s.org login flow.
 * Implements the 6-step chain:
 *
 *   1. GET  /oauth/oidc/login              → capture owui-session, follow redirect to Shibboleth
 *   2. POST execution=e1s1                 → submit NetID + password
 *   3. GET  execution=e1s2 → e1s3          → advance to Duo 2FA
 *      GET  /Authn/Duo/2FA/authorize       → get Duo OAuth URL
 *   4. Duo Universal Prompt v4             → submit passcode or trigger push, poll status
 *   5. GET  duo-callback → e1s3 → e1s4    → Shibboleth issues OIDC authorization code
 *   6. GET  /oauth/oidc/callback           → Open WebUI exchanges code for JWT
 */

import { log } from "../logger";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface OidcLoginOptions {
    baseUrl: string;                          // e.g. "https://chat.ai2s.org"
    username: string;                         // NetID
    password: string;                         // NetID password
    duoPasscode?: string;                     // 6-digit Duo Mobile passcode (skip push)
    duoMethod?: "push" | "passcode";          // default: passcode if duoPasscode set, else push
    pollIntervalMs?: number;                  // default: 2000
    pollTimeoutMs?: number;                   // default: 60000
}

export interface OidcLoginResult {
    token: string;                            // HS256 JWT from Open WebUI
    oauthIdToken: string;                     // RS256 id_token from Shibboleth
    oauthSessionId: string;                   // session UUID
    expiresAt: number;                        // unix ms from JWT exp claim
}

/* ------------------------------------------------------------------ */
/*  Cookie jar — minimal jar that tracks Set-Cookie across redirects   */
/* ------------------------------------------------------------------ */

class CookieJar {
    private cookies = new Map<string, Map<string, string>>();

    /** Parse Set-Cookie headers and store per-domain */
    capture(url: string, headers: Headers): void {
        const domain = new URL(url).hostname;
        if (!this.cookies.has(domain)) this.cookies.set(domain, new Map());
        const jar = this.cookies.get(domain)!;

        for (const raw of headers.getSetCookie?.() ?? []) {
            const [pair] = raw.split(";");
            const eqIdx = pair.indexOf("=");
            if (eqIdx < 0) continue;
            const name = pair.slice(0, eqIdx).trim();
            const value = pair.slice(eqIdx + 1).trim();
            if (value === "null" || raw.includes("expires=Thu, 01 Jan 1970")) {
                jar.delete(name);
            } else {
                jar.set(name, value);
            }
        }
    }

    /** Build Cookie header for a given URL */
    headerFor(url: string): string {
        const domain = new URL(url).hostname;
        const parts: string[] = [];
        // Include cookies from exact domain + parent domains
        for (const [d, jar] of this.cookies) {
            if (domain === d || domain.endsWith(`.${d}`)) {
                for (const [k, v] of jar) parts.push(`${k}=${v}`);
            }
        }
        return parts.join("; ");
    }

    /** Get a specific cookie value */
    get(domain: string, name: string): string | undefined {
        return this.cookies.get(domain)?.get(name);
    }
}

/* ------------------------------------------------------------------ */
/*  HTTP helpers                                                       */
/* ------------------------------------------------------------------ */

const UA = "Mozilla/5.0 (X11; Linux x86_64; rv:149.0) Gecko/20100101 Firefox/149.0";

async function request(
    jar: CookieJar,
    url: string,
    opts: {
        method?: string;
        body?: string;
        headers?: Record<string, string>;
        redirect?: "follow" | "error" | "manual";
    } = {},
): Promise<Response> {
    const headers: Record<string, string> = {
        "User-Agent": UA,
        Cookie: jar.headerFor(url),
        ...opts.headers,
    };
    if (opts.body && !headers["Content-Type"]) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const res = await fetch(url, {
        method: opts.method ?? (opts.body ? "POST" : "GET"),
        headers,
        body: opts.body,
        redirect: opts.redirect ?? "manual",
    });

    jar.capture(url, res.headers);
    return res;
}

/** Follow a chain of 3xx redirects, capturing cookies at each hop */
async function followRedirects(
    jar: CookieJar,
    url: string,
    opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
    maxHops = 10,
): Promise<{ res: Response; url: string; body: string }> {
    let currentUrl = url;
    let res = await request(jar, currentUrl, { ...opts, redirect: "manual" });

    for (let i = 0; i < maxHops; i++) {
        const location = res.headers.get("location");
        if (!location || (res.status !== 301 && res.status !== 302 && res.status !== 303 && res.status !== 307 && res.status !== 308)) {
            break;
        }
        // Consume the body so the connection is freed
        await res.text().catch(() => {});

        // Resolve relative redirects
        currentUrl = new URL(location, currentUrl).toString();
        // 303 always becomes GET; 301/302 typically do too for browsers
        const method = res.status === 307 || res.status === 308 ? (opts.method ?? "GET") : "GET";
        res = await request(jar, currentUrl, { method, redirect: "manual" });
    }

    const body = await res.text();
    return { res, url: currentUrl, body };
}

/* ------------------------------------------------------------------ */
/*  HTML parsing helpers                                               */
/* ------------------------------------------------------------------ */

function extractFormAction(html: string, url: string): string | undefined {
    // <form ... action="..." ...>
    const m = html.match(/<form[^>]*action="([^"]+)"/i);
    if (!m) return undefined;
    const action = m[1].replace(/&amp;/g, "&");
    return new URL(action, url).toString();
}

function extractHiddenFields(html: string): Record<string, string> {
    const fields: Record<string, string> = {};
    const re = /<input[^>]*type="hidden"[^>]*>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const nameMatch = m[0].match(/name="([^"]+)"/);
        const valueMatch = m[0].match(/value="([^"]*)"/);
        if (nameMatch) {
            fields[nameMatch[1]] = valueMatch?.[1]?.replace(/&amp;/g, "&") ?? "";
        }
    }
    return fields;
}

/* ------------------------------------------------------------------ */
/*  Step implementations                                               */
/* ------------------------------------------------------------------ */

/**
 * Step 1: Initiate OIDC login — GET /oauth/oidc/login
 * Returns the Shibboleth authorize URL we got redirected to.
 */
async function step1_initiateOidc(jar: CookieJar, baseUrl: string): Promise<string> {
    log("[oidc] Step 1: Initiating OIDC login");
    const { res, url: finalUrl } = await followRedirects(jar, `${baseUrl}/oauth/oidc/login`);
    if (!finalUrl.includes("shibboleth.arizona.edu") && !finalUrl.includes("webauth.arizona.edu")) {
        throw new Error(`Step 1: Expected redirect to Shibboleth, got ${finalUrl}`);
    }
    log(`[oidc] Step 1: Landed on ${finalUrl}`);
    return finalUrl;
}

/**
 * Step 2: Submit localStorage probe (e1s1) and credentials (e1s2) to Shibboleth.
 *
 * Shibboleth's Spring Web Flow uses two pages before the Duo handoff:
 *   e1s1 — localStorage probe (JS auto-submits with shib_idp_ls_* fields)
 *   e1s2 — actual NetID/password login form (j_username, j_password)
 */
async function step2_submitCredentials(
    jar: CookieJar,
    shibUrl: string,
    username: string,
    password: string,
): Promise<{ url: string; body: string }> {
    log("[oidc] Step 2a: Fetching localStorage probe (e1s1)");
    const { body: probeHtml, url: probeUrl } = await followRedirects(jar, shibUrl);

    const probeAction = extractFormAction(probeHtml, probeUrl);
    if (!probeAction) throw new Error("Step 2a: Could not find e1s1 form action");

    const probeFields = extractHiddenFields(probeHtml);
    probeFields["shib_idp_ls_supported"] = "true";
    probeFields["shib_idp_ls_success.shib_idp_session_ss"] = "true";
    probeFields["shib_idp_ls_success.shib_idp_persistent_ss"] = "true";
    if (!("_eventId_proceed" in probeFields)) probeFields["_eventId_proceed"] = "";

    log(`[oidc] Step 2a: Submitting localStorage probe → ${probeAction}`);
    const probeRes = await followRedirects(jar, probeAction, {
        body: new URLSearchParams(probeFields).toString(),
    });

    let loginHtml = probeRes.body;
    let loginUrl = probeRes.url;
    log(`[oidc] Step 2a: Advanced to ${loginUrl}`);

    if (!loginHtml.includes("j_username") || !loginHtml.includes("j_password")) {
        throw new Error(
            `Step 2a: Expected login form with j_username/j_password on ${loginUrl}`,
        );
    }

    const loginAction = extractFormAction(loginHtml, loginUrl);
    if (!loginAction) throw new Error("Step 2b: Could not find e1s2 login form action");

    log(`[oidc] Step 2b: Submitting credentials → ${loginAction}`);
    const loginFields: Record<string, string> = {
        ...extractHiddenFields(loginHtml),
        j_username: username,
        j_password: password,
        _eventId_proceed: "",
    };

    const { url: afterLogin, body } = await followRedirects(jar, loginAction, {
        body: new URLSearchParams(loginFields).toString(),
    });
    log(`[oidc] Step 2b: After credential submit → ${afterLogin}`);

    const bouncedBack = afterLogin.includes("execution=e1s2") && body.includes("j_password");
    const hasErrorMsg = body.includes("credentials you provided cannot be determined to be authentic")
        || body.includes("login-error");
    if (bouncedBack || hasErrorMsg) {
        throw new Error("Step 2b: Login failed — invalid NetID or password");
    }

    return { url: afterLogin, body };
}

/**
 * Step 3: Navigate through Shibboleth Web Flow to Duo handoff.
 * Follows e1s2 → e1s3 → /Authn/Duo/2FA/authorize → Duo OAuth URL.
 * Returns the Duo frameless URL plus the page body (to avoid re-fetch that
 * would burn the sid on Duo's side).
 */
async function step3_navigateToDuo(
    jar: CookieJar,
    currentUrl: string,
    currentBody: string,
): Promise<{ duoAuthorizeUrl: string; duoBody: string; shibConversationUrl: string }> {
    log("[oidc] Step 3: Navigating to Duo 2FA");

    let url = currentUrl;
    let body = currentBody;

    for (let i = 0; i < 8; i++) {
        if (body.includes("duosecurity.com") || url.includes("duosecurity.com")) break;

        // Look for the Duo authorize path in the current page FIRST (before auto-advancing)
        const duoAuthPath = body.match(/\/idp\/profile\/Authn\/Duo\/2FA\/authorize[^"'\s]*/);
        if (duoAuthPath) {
            const authUrl = new URL(duoAuthPath[0].replace(/&amp;/g, "&"), url).toString();
            log(`[oidc] Step 3: Found Duo authorize link → ${authUrl}`);
            const result = await followRedirects(jar, authUrl);
            url = result.url;
            body = result.body;
            continue;
        }

        // Check for Duo URL embedded in JS or HTML
        const duoEmbedded = body.match(/https:\/\/api-[a-f0-9]+\.duosecurity\.com\/[^"'\s]+/);
        if (duoEmbedded) break;

        // Check for JS auto-redirect
        const autoRedirect = body.match(/window\.location\s*(?:\.href\s*)?=\s*['"]([^'"]+)/i)
            ?? body.match(/http-equiv="refresh"\s+content="\d+;\s*url=([^"]+)"/i);
        if (autoRedirect) {
            const abs = new URL(autoRedirect[1].replace(/&amp;/g, "&"), url).toString();
            log(`[oidc] Step 3: Following JS/meta redirect → ${abs}`);
            const result = await followRedirects(jar, abs);
            url = result.url;
            body = result.body;
            continue;
        }

        // Look for form with _eventId_proceed (Shib Web Flow auto-advance)
        const formAction = extractFormAction(body, url);
        const hasEventProceed = body.includes("_eventId_proceed") || body.includes("_eventId=proceed");
        if (formAction && hasEventProceed) {
            const hidden = extractHiddenFields(body);
            if (!hidden._eventId_proceed) hidden._eventId_proceed = "";
            const postBody = new URLSearchParams(hidden).toString();
            log(`[oidc] Step 3: Submitting auto-proceed form → ${formAction}`);
            const result = await followRedirects(jar, formAction, { body: postBody });
            url = result.url;
            body = result.body;
            continue;
        }

        // Try incrementing the execution step manually (e1s2 → e1s3, etc.)
        const execMatch = url.match(/execution=e(\d+)s(\d+)/);
        if (execMatch) {
            const flow = execMatch[1];
            const step = Number.parseInt(execMatch[2]) + 1;
            const nextUrl = url.replace(/execution=e\d+s\d+/, `execution=e${flow}s${step}`);
            log(`[oidc] Step 3: Advancing to execution=e${flow}s${step}`);
            const result = await followRedirects(jar, nextUrl);
            url = result.url;
            body = result.body;
            continue;
        }

        break;
    }

    let duoUrl: string | undefined;

    if (url.includes("duosecurity.com")) {
        duoUrl = url;
    }

    if (!duoUrl) {
        const duoMatch = body.match(/https:\/\/api-[a-f0-9]+\.duosecurity\.com\/[^"'\s]+/);
        if (duoMatch) duoUrl = duoMatch[0].replace(/&amp;/g, "&");
    }

    if (!duoUrl) {
        const duoAuthMatch = body.match(/\/idp\/profile\/Authn\/Duo\/2FA\/authorize[^"'\s]*/);
        if (duoAuthMatch) {
            const authUrl = new URL(duoAuthMatch[0].replace(/&amp;/g, "&"), url).toString();
            log(`[oidc] Step 3: Following Duo authorize at ${authUrl}`);
            const result = await followRedirects(jar, authUrl);
            url = result.url;
            body = result.body;
            if (url.includes("duosecurity.com")) {
                duoUrl = url;
            }
        }
    }

    if (!duoUrl) {
        throw new Error(`Step 3: Could not find Duo authorize URL. Current URL: ${url}`);
    }

    const shibConversationUrl = url.includes("duosecurity.com")
        ? new URL(duoUrl).searchParams.get("redirect_uri") ?? ""
        : url;

    log(`[oidc] Step 3: Duo authorize URL found`);
    return { duoAuthorizeUrl: duoUrl, duoBody: body, shibConversationUrl };
}

/**
 * Browser features blob Duo expects (url-encoded JSON in several params).
 * Values captured from real Chrome traffic.
 */
const DUO_BROWSER_FEATURES = JSON.stringify({
    touch_supported: false,
    platform_authenticator_status: "unavailable",
    webauthn_supported: true,
    screen_resolution_height: 1200,
    screen_resolution_width: 1920,
    screen_color_depth: 24,
    is_uvpa_available: false,
    client_capabilities_uvpa: false,
});

/**
 * Fields that preauth.js's submitFormWithClientData() fills in on the plugin_form
 * before POSTing. Values match what a Chrome 146 on Linux sends (per Burp capture).
 * The HTML form pre-populates {tx, parent, _xsrf, version, akey, has_session_trust_analysis_feature}
 * with real values; the rest start empty and get overwritten below.
 */
const DUO_PLUGIN_FIELD_OVERRIDES: Record<string, string> = {
    screen_resolution_width: "1920",
    screen_resolution_height: "1200",
    color_depth: "24",
    has_touch_capability: "false",
    is_cef_browser: "false",
    is_ipad_os: "false",
    is_user_verifying_platform_authenticator_available: "false",
    react_support: "true",
    // Explicit empties (form HTML already has them empty, but we're defensive):
    java_version: "",
    flash_version: "",
    ch_ua_error: "",
    client_hints: "",
    is_ie_compatibility_mode: "",
    user_verifying_platform_authenticator_available_error: "",
    acting_ie_version: "",
    react_support_error_message: "",
    extension_instance_key: "",
    session_trust_extension_id: "",
};

/**
 * POST expecting a 3xx redirect. Returns the absolute Location URL.
 * Throws if the status isn't 3xx or the Location doesn't contain `locationMustInclude`.
 */
async function postExpectRedirect(
    jar: CookieJar,
    url: string,
    body: string,
    headers: Record<string, string>,
    locationMustInclude: string,
    label: string,
): Promise<{ location: string; status: number }> {
    const res = await request(jar, url, { method: "POST", body, headers, redirect: "manual" });
    const loc = res.headers.get("location");
    await res.text().catch(() => { /* drain */ });
    if (res.status < 300 || res.status >= 400) {
        throw new Error(`${label}: expected 3xx, got ${res.status}`);
    }
    if (!loc || !loc.includes(locationMustInclude)) {
        throw new Error(`${label}: expected Location containing "${locationMustInclude}", got "${loc ?? "(none)"}"`);
    }
    return { location: new URL(loc, url).toString(), status: res.status };
}

/**
 * Build the plugin_form POST body from a frameless page HTML.
 *
 * Takes all hidden inputs from the <form id="plugin_form">, overlays the
 * browser-fingerprint values that preauth.js would fill in via JS, and
 * url-encodes them. Both POSTs (1st → /preauth/healthcheck, 2nd → /auth/prompt)
 * use the same set of fields with identical values.
 */
function buildPluginFormBody(framelessHtml: string): string {
    const fields: Record<string, string> = {
        ...extractHiddenFields(framelessHtml),
        ...DUO_PLUGIN_FIELD_OVERRIDES,
    };
    return new URLSearchParams(fields).toString();
}

/**
 * Step 4: Complete Duo Universal Prompt v4 (frameless).
 *
 * Reverse-engineered from a real Burp capture of Chrome + chat.ai2s.org. The flow
 * involves TWO identical POSTs to /frame/frameless/v4/auth with a healthcheck cycle
 * in between — a single POST is insufficient, the server won't set the `trc|` cookie
 * that subsequent /prompt/data requires and you'll get `{"stat":"FAIL","message_enum":57}`.
 *
 * Sequence (matches Burp items 15-34 exactly):
 *
 *   a.  POST  /frame/frameless/v4/auth?sid=X&tx=Y  (plugin_form, manual redirect)
 *                                                  → 303 → /frame/v4/preauth/healthcheck
 *   b.  GET   /frame/v4/preauth/healthcheck        (App.js React shell, has xsrf_token)
 *   c.  GET   /frame/v4/preauth/healthcheck/data   (AJAX, needs X-Xsrftoken header)
 *   d.  GET   /frame/v4/return                     (manual redirect)
 *                                                  → 303 → /frame/frameless/v4/auth
 *   e.  POST  /frame/frameless/v4/auth?sid=X&tx=Y  (plugin_form AGAIN — identical body)
 *                                                  → 302 → /frame/v4/auth/prompt
 *                                                  (sets trc|AKEY|UKEY cookie, required!)
 *   f.  GET   /frame/v4/auth/prompt                (App.js React shell)
 *   g.  GET   /frame/v4/auth/prompt/data           (device list, needs X-Xsrftoken)
 *   h.  POST  /frame/v4/prompt                     (factor submission, returns txid)
 *   i.  POST  /frame/v4/status                     (poll until "allow" / "SUCCESS")
 *   j.  POST  /frame/v4/oidc/exit                  → 303 → shibboleth duo-callback
 */
async function step4_completeDuo(
    jar: CookieJar,
    framelessUrl: string,
    framelessBody: string,
    opts: OidcLoginOptions,
): Promise<string> {
    log("[oidc] Step 4: Starting Duo 2FA");

    const urlObj = new URL(framelessUrl);
    const duoHost = urlObj.origin;
    const sid = urlObj.searchParams.get("sid");
    if (!sid) throw new Error("Step 4: Could not extract Duo session ID (sid)");
    log(`[oidc] Step 4: duoHost=${duoHost} sid=${sid.slice(0, 40)}...`);

    // Grab _xsrf from the pre-populated form field in the frameless HTML.
    // (It's the base64-decoded payload of the _xsrf|SID cookie and is used as
    // the X-Xsrftoken header for every AJAX call to Duo.)
    const formFields0 = extractHiddenFields(framelessBody);
    const xsrfFromForm = formFields0._xsrf;
    if (!xsrfFromForm) {
        throw new Error("Step 4: could not find _xsrf hidden input in frameless HTML");
    }

    const pluginBody1 = buildPluginFormBody(framelessBody);
    const postHeaders = {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: duoHost,
        Referer: framelessUrl,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Upgrade-Insecure-Requests": "1",
    };

    // ---------- 4a: FIRST plugin_form POST → 303 → /preauth/healthcheck ----------
    log("[oidc] Step 4a: POST #1 plugin_form → expect 303 → /preauth/healthcheck");
    const { location: healthcheckUrl } = await postExpectRedirect(
        jar, framelessUrl, pluginBody1, postHeaders, "/preauth/healthcheck", "Step 4a",
    );
    log(`[oidc] Step 4a: 303 Location=${new URL(healthcheckUrl).pathname}`);

    // ---------- 4b: GET /preauth/healthcheck (App.js shell with base-data JSON) ----------
    const healthcheckPage = await followRedirects(jar, healthcheckUrl, {
        headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: framelessUrl,
        },
    });
    const xsrfFromHealthcheck = healthcheckPage.body.match(/"xsrf_token":\s*"([^"]+)"/)?.[1];
    const xsrf = xsrfFromHealthcheck ?? xsrfFromForm;
    if (!xsrf) throw new Error("Step 4b: could not extract xsrf_token");
    log(`[oidc] Step 4b: xsrf=${xsrf.slice(0, 12)}...`);

    // ---------- 4c: AJAX GET /preauth/healthcheck/data ----------
    const hcDataRes = await request(jar, `${duoHost}/frame/v4/preauth/healthcheck/data?sid=${encodeURIComponent(sid)}`, {
        method: "GET",
        headers: {
            Accept: "*/*",
            "X-Xsrftoken": xsrf,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Origin: duoHost,
            Referer: healthcheckUrl,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        },
    });
    await hcDataRes.text().catch(() => {});
    if (!hcDataRes.ok) {
        throw new Error(`Step 4c: /preauth/healthcheck/data returned ${hcDataRes.status}`);
    }
    log("[oidc] Step 4c: healthcheck/data OK");

    // ---------- 4d: GET /frame/v4/return → 303 → frameless/v4/auth (2nd visit) ----------
    const returnRes = await request(jar, `${duoHost}/frame/v4/return?sid=${encodeURIComponent(sid)}`, {
        method: "GET",
        headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: healthcheckUrl,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
            "Upgrade-Insecure-Requests": "1",
        },
        redirect: "manual",
    });
    const returnLoc = returnRes.headers.get("location");
    await returnRes.text().catch(() => {});
    if (returnRes.status < 300 || returnRes.status >= 400 || !returnLoc?.includes("/frame/frameless/v4/auth")) {
        throw new Error(`Step 4d: /return expected 303 → frameless, got ${returnRes.status} ${returnLoc ?? "(no location)"}`);
    }
    const framelessUrl2 = new URL(returnLoc, duoHost).toString();
    const frameless2 = await followRedirects(jar, framelessUrl2, {
        headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: healthcheckUrl,
        },
    });
    log(`[oidc] Step 4d: back on frameless (2nd visit)`);

    // ---------- 4e: SECOND plugin_form POST → 302 → /auth/prompt ----------
    // Rebuild the body from the 2nd-visit HTML (same structure, possibly same values,
    // but defensive against any server-side mutation of hidden fields between visits).
    const pluginBody2 = buildPluginFormBody(frameless2.body);
    const postHeaders2 = { ...postHeaders, Referer: framelessUrl2 };

    log("[oidc] Step 4e: POST #2 plugin_form → expect 302 → /auth/prompt");
    const { location: promptUrl } = await postExpectRedirect(
        jar, framelessUrl2, pluginBody2, postHeaders2, "/auth/prompt", "Step 4e",
    );
    log(`[oidc] Step 4e: 302 Location=${new URL(promptUrl).pathname} (trc cookie set)`);

    // ---------- 4f: GET /auth/prompt (App.js React shell) ----------
    const promptPage = await followRedirects(jar, promptUrl, {
        headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Referer: framelessUrl2,
        },
    });
    const xsrfPrompt = promptPage.body.match(/"xsrf_token":\s*"([^"]+)"/)?.[1] ?? xsrf;

    // ---------- 4g: GET /auth/prompt/data (device list) ----------
    const promptDataUrl = `${duoHost}/frame/v4/auth/prompt/data?post_auth_action=OIDC_EXIT`
        + `&browser_features=${encodeURIComponent(DUO_BROWSER_FEATURES)}`
        + `&sid=${encodeURIComponent(sid)}`;
    const promptDataRes = await request(jar, promptDataUrl, {
        method: "GET",
        headers: {
            Accept: "*/*",
            "X-Xsrftoken": xsrfPrompt,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Origin: duoHost,
            Referer: promptUrl,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        },
    });
    const promptData = await promptDataRes.json() as {
        stat: string;
        message_enum?: number;
        response: {
            phones?: { key: string; index: string; name?: string }[];
            auth_method_order?: { factor: string; deviceKey?: string }[];
        };
    };
    if (promptData.stat !== "OK") {
        throw new Error(`Step 4g: /prompt/data FAIL (message_enum=${promptData.message_enum ?? "?"}): ${JSON.stringify(promptData).slice(0, 300)}`);
    }
    const phones = promptData.response.phones ?? [];
    const authMethods = promptData.response.auth_method_order ?? [];
    log(`[oidc] Step 4g: Got ${phones.length} device(s), ${authMethods.length} method(s)`);

    // ---------- 4h: POST /frame/v4/prompt (factor submission → txid) ----------
    // Factor names verified in App.beautified.js line 27873-27876:
    //   FactorWithDevice.PUSH = "Duo Push"          → device=phoneN  (requires device)
    //   FactorWithDevice.SMS_PASSCODE = "SMS Passcode"  → device=phoneN
    //   FactorWithDevice.PHONE = "Phone Call"        → device=phoneN
    //   FactorWithoutDevice.PASSCODE = "Passcode"    → device=null   (no device — any passcode type)
    // "Duo Mobile Passcode" is only the UI LABEL in auth_method_order; when
    // submitting a Duo-Mobile-generated passcode App.js sends factor="Passcode"
    // and device=null (App.beautified.js line 35330-35332, startPasscodeRequest).
    // URLSearchParams converts JS null → literal string "null" on the wire.
    const usePasscode = opts.duoMethod === "passcode" || (opts.duoPasscode && opts.duoMethod !== "push");
    let factor: string;
    let device: string;
    const deviceKey = phones[0]?.key ?? "";
    let passcode: string | undefined;

    if (usePasscode && opts.duoPasscode) {
        factor = "Passcode";
        device = "null";
        passcode = opts.duoPasscode;
        log(`[oidc] Step 4h: Submitting Passcode (factor="${factor}", device=null)`);
    } else {
        factor = "Duo Push";
        device = phones[0]?.index ?? "phone1";
        log(`[oidc] Step 4h: Sending Duo Push to ${phones[0]?.name ?? device}`);
    }

    // Body field order matches App.js's initiateAuth + HTTP.prepareRequestBody:
    // additionalParameters (passcode) → device → factor → postAuthDestination →
    // browser_features → sid (always last, appended by the HTTP helper itself).
    const promptParams: Record<string, string> = {};
    if (passcode) promptParams.passcode = passcode;
    promptParams.device = device;
    promptParams.factor = factor;
    promptParams.postAuthDestination = "OIDC_EXIT";
    promptParams.browser_features = DUO_BROWSER_FEATURES;
    promptParams.sid = sid;

    const factorRes = await request(jar, `${duoHost}/frame/v4/prompt`, {
        method: "POST",
        body: new URLSearchParams(promptParams).toString(),
        headers: {
            Accept: "*/*",
            "X-Xsrftoken": xsrfPrompt,
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Origin: duoHost,
            Referer: promptUrl,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Dest": "empty",
        },
    });
    const factorData = await factorRes.json() as {
        stat: string;
        message_enum?: number;
        response?: { txid: string };
    };
    if (factorData.stat !== "OK" || !factorData.response?.txid) {
        throw new Error(`Step 4h: /prompt FAIL (message_enum=${factorData.message_enum ?? "?"}): ${JSON.stringify(factorData).slice(0, 300)}`);
    }
    const txid = factorData.response.txid;
    log(`[oidc] Step 4h: txid=${txid}`);

    // ---------- 4i: Poll /frame/v4/status until allow/deny ----------
    const pollInterval = opts.pollIntervalMs ?? 2000;
    const pollTimeout = opts.pollTimeoutMs ?? 60000;
    const deadline = Date.now() + pollTimeout;

    while (Date.now() < deadline) {
        const statusRes = await request(jar, `${duoHost}/frame/v4/status`, {
            method: "POST",
            body: new URLSearchParams({ txid, sid }).toString(),
            headers: {
                Accept: "*/*",
                "X-Xsrftoken": xsrfPrompt,
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                Origin: duoHost,
                Referer: promptUrl,
                "Sec-Fetch-Site": "same-origin",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Dest": "empty",
            },
        });
        const statusData = await statusRes.json() as {
            stat: string;
            response: {
                status_code: string;
                result?: string;
                reason?: string;
                post_auth_action?: string;
            };
        };

        if (statusData.response.result === "SUCCESS"
            || statusData.response.status_code === "allow") {
            log(`[oidc] Step 4i: Duo approved — ${statusData.response.reason ?? ""}`);
            break;
        }
        if (statusData.response.status_code === "deny") {
            throw new Error(`Step 4i: Duo denied — ${statusData.response.reason ?? "unknown"}`);
        }
        log(`[oidc] Step 4i: Polling... status=${statusData.response.status_code}`);
        await new Promise((r) => setTimeout(r, pollInterval));
    }
    if (Date.now() >= deadline) throw new Error("Step 4i: Duo approval timed out");

    // ---------- 4j: POST /oidc/exit → 303 to shibboleth duo-callback ----------
    const exitBody = new URLSearchParams({
        sid,
        txid,
        factor,
        device_key: deviceKey,
        _xsrf: xsrfPrompt,
        dampen_choice: "true",
    }).toString();

    const exitRes = await request(jar, `${duoHost}/frame/v4/oidc/exit`, {
        method: "POST",
        body: exitBody,
        headers: {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: duoHost,
            Referer: promptUrl,
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
            "Upgrade-Insecure-Requests": "1",
        },
        redirect: "manual",
    });
    const exitLocation = exitRes.headers.get("location");
    await exitRes.text().catch(() => {});
    if (!exitLocation || !exitLocation.includes("duo-callback")) {
        throw new Error(`Step 4j: expected duo-callback redirect, got status=${exitRes.status} loc=${exitLocation ?? "(none)"}`);
    }
    log("[oidc] Step 4j: Duo OIDC exit → Shibboleth duo-callback");
    return exitLocation;
}

/**
 * Step 5 + 6 combined: Follow Shibboleth post-Duo flow and extract the JWT.
 *
 * Per Burp items 34-39:
 *   34  GET 302  /idp/profile/Authn/Duo/2FA/duo-callback?state=...&code=...
 *   35  GET 302  /idp/profile/oidc/authorize?execution=e1s3&_eventId_proceed=1
 *   36  GET 200  /idp/profile/oidc/authorize?execution=e1s4    (localStorage save form)
 *   37  POST 302 /idp/profile/oidc/authorize?execution=e1s4    (shib_idp_ls form submit)
 *   38  GET 307  /oauth/oidc/callback?code=...                 (Set-Cookie: token=...)
 *   39  GET 200  /auth                                         (landing page)
 *
 * The token JWT is set as a cookie by /oauth/oidc/callback's response (step 38),
 * and the user is then redirected to /auth (step 39). We follow the whole chain
 * and pluck `token` from the cookie jar at the end — no matter whether we end
 * up on /oauth/oidc/callback, /auth, or any other chat.ai2s.org landing page.
 */
async function step5and6_completeShibbolethAndExtractToken(
    jar: CookieJar,
    duoCallbackUrl: string,
    baseUrl: string,
): Promise<OidcLoginResult> {
    log("[oidc] Step 5: Following Shibboleth post-Duo redirects");

    const host = new URL(baseUrl).hostname;
    let { url, body } = await followRedirects(jar, duoCallbackUrl);
    log(`[oidc] Step 5: After duo-callback → ${url}`);

    for (let i = 0; i < 8; i++) {
        if (jar.get(host, "token")) break;
        if (body.includes("shib_idp_ls_success") || body.includes("_eventId_proceed")) {
            const action = extractFormAction(body, url) ?? url;
            const hidden = extractHiddenFields(body);
            if (!hidden._eventId_proceed) hidden._eventId_proceed = "";
            if (!hidden["shib_idp_ls_success.shib_idp_session_ss"]) {
                hidden["shib_idp_ls_success.shib_idp_session_ss"] = "true";
            }
            if (!hidden["shib_idp_ls_exception.shib_idp_session_ss"]) {
                hidden["shib_idp_ls_exception.shib_idp_session_ss"] = "";
            }
            const result = await followRedirects(jar, action, {
                body: new URLSearchParams(hidden).toString(),
            });
            url = result.url;
            body = result.body;
            continue;
        }

        const nextUrl = body.match(/window\.location\s*=\s*['"]([^'"]+)/)?.[1]
            ?? body.match(/http-equiv="refresh"\s+content="\d+;url=([^"]+)"/i)?.[1];
        if (nextUrl) {
            const result = await followRedirects(jar, new URL(nextUrl, url).toString());
            url = result.url;
            body = result.body;
            continue;
        }

        if (url.includes("execution=") && !url.includes("_eventId_proceed")) {
            const proceedUrl = `${url}${url.includes("?") ? "&" : "?"}_eventId_proceed=1`;
            const result = await followRedirects(jar, proceedUrl);
            url = result.url;
            body = result.body;
            continue;
        }
        break;
    }

    const token = jar.get(host, "token");
    if (!token) {
        throw new Error(
            `Step 5: No token cookie received; ended at ${url}. `
            + `Chat.ai2s.org either didn't complete the OIDC exchange or `
            + `set the cookie under a different name.`,
        );
    }
    const oauthIdToken = jar.get(host, "oauth_id_token") ?? "";
    const oauthSessionId = jar.get(host, "oauth_session_id") ?? "";

    let expiresAt = Date.now() + 28 * 24 * 60 * 60 * 1000;
    const parts = token.split(".");
    if (parts.length === 3) {
        try {
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
            if (typeof payload.exp === "number") expiresAt = payload.exp * 1000;
        } catch { /* fallback expiry */ }
    }

    log(`[oidc] Step 5: Got token, expires ${new Date(expiresAt).toISOString()}`);
    return { token, oauthIdToken, oauthSessionId, expiresAt };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Run the complete 6-step OIDC login flow.
 *
 * @returns Fresh Open WebUI JWT + metadata
 */
export async function oidcLogin(opts: OidcLoginOptions): Promise<OidcLoginResult> {
    const jar = new CookieJar();
    const baseUrl = opts.baseUrl.replace(/\/$/, "");

    // Step 1: Initiate OIDC
    const shibUrl = await step1_initiateOidc(jar, baseUrl);

    // Step 2: Submit credentials
    const { url: afterCreds, body: afterCredsBody } = await step2_submitCredentials(
        jar, shibUrl, opts.username, opts.password,
    );

    // Step 3: Navigate to Duo
    const { duoAuthorizeUrl, duoBody } = await step3_navigateToDuo(jar, afterCreds, afterCredsBody);

    // Step 4: Complete Duo 2FA
    const duoCallbackUrl = await step4_completeDuo(jar, duoAuthorizeUrl, duoBody, opts);

    return step5and6_completeShibbolethAndExtractToken(jar, duoCallbackUrl, baseUrl);
}
