import { log } from "../logger";

/** Timeout for the entire browser login flow (5 minutes). */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Attempt to open a URL in the user's default browser.
 * Uses Bun.spawn to avoid shell interpretation of the URL.
 * Swallows errors — caller should provide fallback instructions.
 */
export function openBrowser(url: string): boolean {
    const cmds: Record<string, string[]> = {
        darwin: ["open", url],
        win32: ["cmd", "/c", "start", url.replace(/&/g, "^&")],
        linux: ["xdg-open", url],
    };
    const argv = cmds[process.platform] ?? cmds.linux;
    try {
        Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] });
        return true;
    } catch {
        return false;
    }
}

/**
 * Build the HTML bridge page served at localhost. Guides the user through:
 * 1. Click to sign in via SSO (opens in new tab)
 * 2. Copy token from browser console
 * 3. Paste token here and submit
 */
function buildBridgePage(baseUrl: string, callbackPort: number): string {
    const loginUrl = `${baseUrl}/oauth/oidc/login`;
    const tokenEndpoint = `http://127.0.0.1:${callbackPort}/token`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect OpenWebUI — opencode</title>
<style>
  :root {
    --bg: #09090b;
    --bg-card: #18181b;
    --border: #27272a;
    --text-main: #f4f4f5;
    --text-muted: #a1a1aa;
    --primary: #3b82f6;
    --primary-hover: #2563eb;
    --success: #22c55e;
    --error: #ef4444;
    --focus-ring: rgba(59, 130, 246, 0.5);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background-color: var(--bg);
    color: var(--text-main);
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 1.5rem;
    line-height: 1.5;
  }
  .container {
    max-width: 480px;
    width: 100%;
    position: relative;
  }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 2.5rem 2rem;
    box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.5);
    transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.4s ease;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 2rem;
  }
  .logo {
    width: 32px;
    height: 32px;
    background: linear-gradient(135deg, var(--primary), #8b5cf6);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: bold;
    font-size: 1.25rem;
    color: white;
  }
  h1 {
    font-size: 1.5rem;
    font-weight: 600;
    margin-bottom: 0.5rem;
    letter-spacing: -0.025em;
  }
  p {
    color: var(--text-muted);
    font-size: 0.9375rem;
    margin-bottom: 1.5rem;
  }
  .info-box {
    background: rgba(59, 130, 246, 0.1);
    border: 1px solid rgba(59, 130, 246, 0.2);
    border-radius: 8px;
    padding: 1rem;
    font-size: 0.875rem;
    color: #bfdbfe;
    margin-bottom: 2rem;
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
  }
  .info-box svg {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    color: var(--primary);
  }
  .btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.875rem 1.5rem;
    border: none;
    border-radius: 8px;
    font-size: 0.9375rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }
  .btn-primary {
    background: var(--primary);
    color: white;
  }
  .btn-primary:hover:not(:disabled) {
    background: var(--primary-hover);
  }
  .btn-primary:focus-visible {
    outline: 2px solid var(--primary);
    outline-offset: 2px;
  }
  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .step-container {
    display: none;
    opacity: 0;
    transform: translateY(10px);
    animation: slideUp 0.5s forwards ease-out;
  }
  .step-container.active {
    display: block;
  }
  @keyframes slideUp {
    to { opacity: 1; transform: translateY(0); }
  }
  .step-item {
    margin-bottom: 1.5rem;
  }
  .step-header {
    font-weight: 600;
    font-size: 0.9375rem;
    color: var(--text-main);
    margin-bottom: 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .step-num {
    background: var(--border);
    color: var(--text-muted);
    width: 24px;
    height: 24px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
  }
  .code-panel {
    background: #000;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.5rem;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.875rem;
    color: #38bdf8;
    padding: 0 0.5rem;
  }
  .btn-copy {
    background: var(--border);
    color: var(--text-main);
    border: none;
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .btn-copy:hover {
    background: #3f3f46;
  }
  textarea {
    width: 100%;
    background: #000;
    color: var(--text-main);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem;
    font-family: ui-monospace, monospace;
    font-size: 0.875rem;
    resize: vertical;
    min-height: 80px;
    transition: border-color 0.2s;
  }
  textarea:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  .status {
    margin-top: 1rem;
    font-size: 0.875rem;
    text-align: center;
    min-height: 1.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }
  .status.error { color: var(--error); }
  .status.success { color: var(--success); }
  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    display: none;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .btn-primary.loading .spinner { display: block; }
  .btn-primary.loading .btn-text { display: none; }
</style>
</head>
<body>

<div class="container">
  <!-- STEP 1 -->
  <div class="card" id="step1">
    <div class="brand">
      <div class="logo">oc</div>
      <div style="font-weight: 600; letter-spacing: 0.05em; color: var(--text-muted)">OPENCODE</div>
    </div>
    
    <h1>Connect OpenWebUI</h1>
    <p>Authenticate your CLI to access <strong>${escapeHtml(baseUrl)}</strong>.</p>
    
    <div class="info-box">
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
      </svg>
      <div>
        <strong>Local Connection</strong><br>
        This page is served securely by your local CLI to complete the login flow.
      </div>
    </div>

    <button id="startBtn" class="btn btn-primary">
      <span>Sign in via SSO</span>
      <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </button>
  </div>

  <!-- STEP 2 -->
  <div class="card step-container" id="step2">
    <h1>Extract your token</h1>
    <p>Follow these steps to securely pass your token back to the CLI.</p>
    
    <div class="step-item">
      <div class="step-header">
        <span class="step-num">1</span>
        Open the browser console
      </div>
      <p style="font-size: 0.875rem; margin-bottom: 0; padding-left: 2rem;">
        On the OpenWebUI page that just opened, press <strong>F12</strong> or right-click and select <strong>Inspect</strong>, then click the <strong>Console</strong> tab.
      </p>
    </div>

    <div class="step-item">
      <div class="step-header">
        <span class="step-num">2</span>
        Copy your token
      </div>
      <p style="font-size: 0.875rem; margin-bottom: 0; padding-left: 2rem;">
        Paste this command into the console and press Enter:
      </p>
      <div class="code-panel" style="margin-left: 2rem;">
        <code>copy(localStorage.token)</code>
        <button id="copyBtn" class="btn-copy">
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Copy
        </button>
      </div>
    </div>

    <div class="step-item">
      <div class="step-header">
        <span class="step-num">3</span>
        Paste token here
      </div>
      <div style="margin-left: 2rem;">
        <textarea id="tokenInput" placeholder="eyJhbGciOi..."></textarea>
        <button id="submitBtn" class="btn btn-primary" style="margin-top: 1rem;">
          <div class="spinner"></div>
          <span class="btn-text">Connect CLI</span>
        </button>
      </div>
    </div>
    
    <div id="status" class="status"></div>
  </div>
</div>

<script>
(function() {
  var LOGIN_URL = ${JSON.stringify(loginUrl)};
  var TOKEN_URL = ${JSON.stringify(tokenEndpoint)};
  
  var step1 = document.getElementById('step1');
  var step2 = document.getElementById('step2');
  var startBtn = document.getElementById('startBtn');
  var copyBtn = document.getElementById('copyBtn');
  var submitBtn = document.getElementById('submitBtn');
  var tokenInput = document.getElementById('tokenInput');
  var statusEl = document.getElementById('status');
  var sent = false;

  startBtn.addEventListener('click', function() {
    window.open(LOGIN_URL, '_blank', 'noopener');
    step1.style.display = 'none';
    step2.classList.add('active');
    setTimeout(function() { tokenInput.focus(); }, 100);
  });

  copyBtn.addEventListener('click', function() {
    navigator.clipboard.writeText('copy(localStorage.token)').then(function() {
      var originalText = copyBtn.innerHTML;
      copyBtn.innerHTML = '<svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="var(--success)" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg><span style="color:var(--success)">Copied</span>';
      setTimeout(function() { copyBtn.innerHTML = originalText; }, 2000);
    }).catch(function() {});
  });

  function setStatus(msg, type) {
    statusEl.textContent = msg;
    statusEl.className = 'status ' + (type || '');
  }

  function sendToken(token) {
    if (sent) return;
    token = (token || '').trim();
    
    if (token.startsWith('"') && token.endsWith('"')) {
      token = token.slice(1, -1);
    }
    
    if (!token || token.split('.').length !== 3) {
      setStatus('Invalid format — expected a JWT (three dot-separated parts).', 'error');
      tokenInput.focus();
      return;
    }
    
    sent = true;
    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    setStatus('Authenticating...', '');

    fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: token
    }).then(function(res) {
      if (res.ok) {
        setStatus('Authentication successful! You can close this tab.', 'success');
        document.title = "Connected!";
        submitBtn.classList.remove('loading');
        submitBtn.innerHTML = '<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg> Connected';
        submitBtn.style.background = 'var(--success)';
      } else {
        return res.text().then(function(msg) {
          setStatus('Error: ' + msg, 'error');
          sent = false;
          submitBtn.disabled = false;
          submitBtn.classList.remove('loading');
        });
      }
    }).catch(function() {
      setStatus('Could not reach CLI server. Is it still running?', 'error');
      sent = false;
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
    });
  }

  submitBtn.addEventListener('click', function() { sendToken(tokenInput.value); });
  
  tokenInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendToken(tokenInput.value);
    }
  });
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Start a local HTTP server, open the user's browser to the bridge page,
 * and wait for the token to arrive.
 *
 * Returns the raw JWT string on success; throws on timeout or server error.
 */
export async function browserLogin(baseUrl: string): Promise<string> {
    let resolveToken: (value: string) => void;
    let rejectToken: (reason: Error) => void;
    const tokenPromise = new Promise<string>((res, rej) => {
        resolveToken = res;
        rejectToken = rej;
    });

    let settled = false;
    let activePort = 0;

    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req): Response | Promise<Response> {
            const url = new URL(req.url);

            // Serve the bridge page
            if (
                req.method === "GET" &&
                (url.pathname === "/" || url.pathname === "")
            ) {
                return new Response(buildBridgePage(baseUrl, activePort), {
                    headers: { "Content-Type": "text/html; charset=utf-8" },
                });
            }

            // Receive the token (same-origin POST from the bridge page)
            if (req.method === "POST" && url.pathname === "/token") {
                return req.text().then((body): Response => {
                    const trimmed = body.trim();
                    if (!trimmed || trimmed.split(".").length !== 3) {
                        return new Response("Invalid JWT format", {
                            status: 400,
                        });
                    }
                    if (!settled) {
                        settled = true;
                        resolveToken(trimmed);
                        setTimeout(() => server.stop(), 500);
                    }
                    return new Response("OK", { status: 200 });
                });
            }

            return new Response("Not found", { status: 404 });
        },
    });

    activePort = server.port as number;
    const localUrl = `http://127.0.0.1:${activePort}`;
    log(`[browser-auth] listening on ${localUrl}`);

    const opened = openBrowser(localUrl);
    if (!opened) {
        log("[browser-auth] could not open browser automatically");
    }

    const timer = setTimeout(() => {
        if (!settled) {
            settled = true;
            server.stop();
            rejectToken(
                new Error(
                    `Browser login timed out after ${LOGIN_TIMEOUT_MS / 1000}s. ` +
                        "Complete the flow faster or use the CLI: opencode-openwebui-auth add <url> <token>",
                ),
            );
        }
    }, LOGIN_TIMEOUT_MS);

    return tokenPromise.finally(() => {
        clearTimeout(timer);
        try {
            server.stop();
        } catch {}
    });
}
