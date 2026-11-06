import { createHash } from 'node:crypto';
// The dashboard is one self-contained page: inline CSS + JS, no external resources. The inline
// blocks are whitelisted in the Content-Security-Policy by their SHA-256 hashes (computed below at
// load time), so no 'unsafe-inline' is needed. The client code builds every element through a tiny
// h() helper that assigns text with textContent - agent-supplied text is untrusted and is never
// parsed as HTML.
//
// NOTE for editors: STYLE, SCRIPT and BODY are String.raw templates - do not use backticks or
// dollar-brace sequences inside them.
const LOGO_PATHS = '<rect width="32" height="32" rx="8" fill="#4f46e5"/>' +
    '<path d="M16 10.5 9.5 21.5h13z" fill="none" stroke="#c7d2fe" stroke-width="2" stroke-linejoin="round"/>' +
    '<circle cx="16" cy="10.5" r="3.4" fill="#fff"/><circle cx="9.5" cy="21.5" r="3.4" fill="#fff"/>' +
    '<circle cx="22.5" cy="21.5" r="3.4" fill="#fff"/>';
/** Favicon served at /favicon.svg. */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${LOGO_PATHS}</svg>`;
const STYLE = String.raw `
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
:root{
  color-scheme:light;
  --bg:#f5f6f8;--surface:#fff;--surface-2:#f3f4f7;--surface-3:#eceef2;
  --border:#e4e7ec;--border-strong:#d0d5dd;
  --text:#101828;--muted:#5b6474;--faint:#98a2b3;
  --accent:#4f46e5;--accent-hover:#4338ca;--accent-text:#4338ca;--accent-soft:#eef2ff;--accent-contrast:#fff;
  --focus:#6366f1;--focus-ring:rgba(99,102,241,.28);--input-bg:#fff;
  --ok:#15803d;--ok-soft:#dcfce7;--info:#1d4ed8;--info-soft:#dbeafe;--warn:#b45309;--warn-soft:#fef3c7;
  --attn:#c2410c;--attn-soft:#ffedd5;--danger:#b91c1c;--danger-soft:#fee2e2;--danger-solid:#dc2626;
  --violet:#6d28d9;--violet-soft:#ede9fe;--neutral:#475467;--neutral-soft:#f2f4f7;
  --toast-bg:#101828;--toast-fg:#f9fafb;
  --shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.06);
  --shadow-lg:0 24px 48px -12px rgba(16,24,40,.28);
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans",sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  color-scheme:dark;
  --bg:#0c0e12;--surface:#15181e;--surface-2:#1b1f27;--surface-3:#232832;
  --border:#262b35;--border-strong:#363d4a;
  --text:#e8eaef;--muted:#a2abbb;--faint:#6b7486;
  --accent:#8b93ff;--accent-hover:#a5abff;--accent-text:#a5abff;--accent-soft:rgba(139,147,255,.14);--accent-contrast:#0c0e12;
  --focus:#8b93ff;--focus-ring:rgba(139,147,255,.32);--input-bg:#101319;
  --ok:#4ade80;--ok-soft:rgba(74,222,128,.13);--info:#60a5fa;--info-soft:rgba(96,165,250,.14);--warn:#fbbf24;--warn-soft:rgba(251,191,36,.13);
  --attn:#fb923c;--attn-soft:rgba(251,146,60,.14);--danger:#f87171;--danger-soft:rgba(248,113,113,.14);--danger-solid:#dc2626;
  --violet:#c4b5fd;--violet-soft:rgba(167,139,250,.16);--neutral:#a2abbb;--neutral-soft:rgba(162,171,187,.12);
  --toast-bg:#e8eaef;--toast-fg:#101828;
  --shadow:0 1px 2px rgba(0,0,0,.45);--shadow-lg:0 24px 48px -12px rgba(0,0,0,.7);
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0c0e12;--surface:#15181e;--surface-2:#1b1f27;--surface-3:#232832;
  --border:#262b35;--border-strong:#363d4a;
  --text:#e8eaef;--muted:#a2abbb;--faint:#6b7486;
  --accent:#8b93ff;--accent-hover:#a5abff;--accent-text:#a5abff;--accent-soft:rgba(139,147,255,.14);--accent-contrast:#0c0e12;
  --focus:#8b93ff;--focus-ring:rgba(139,147,255,.32);--input-bg:#101319;
  --ok:#4ade80;--ok-soft:rgba(74,222,128,.13);--info:#60a5fa;--info-soft:rgba(96,165,250,.14);--warn:#fbbf24;--warn-soft:rgba(251,191,36,.13);
  --attn:#fb923c;--attn-soft:rgba(251,146,60,.14);--danger:#f87171;--danger-soft:rgba(248,113,113,.14);--danger-solid:#dc2626;
  --violet:#c4b5fd;--violet-soft:rgba(167,139,250,.16);--neutral:#a2abbb;--neutral-soft:rgba(162,171,187,.12);
  --toast-bg:#e8eaef;--toast-fg:#101828;
  --shadow:0 1px 2px rgba(0,0,0,.45);--shadow-lg:0 24px 48px -12px rgba(0,0,0,.7);
}
.tone-ok{--tone:var(--ok);--tone-soft:var(--ok-soft)}
.tone-info{--tone:var(--info);--tone-soft:var(--info-soft)}
.tone-warn{--tone:var(--warn);--tone-soft:var(--warn-soft)}
.tone-attn{--tone:var(--attn);--tone-soft:var(--attn-soft)}
.tone-danger,.tone-error{--tone:var(--danger);--tone-soft:var(--danger-soft)}
.tone-violet{--tone:var(--violet);--tone-soft:var(--violet-soft)}
.tone-neutral{--tone:var(--neutral);--tone-soft:var(--neutral-soft)}

html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;font:14px/1.5 var(--sans);color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
#app{display:flex;flex-direction:column;flex:1;min-height:100vh}
h1,h2,h3,h4{margin:0;line-height:1.3}
p{margin:0}
code,pre,kbd{font-family:var(--mono);font-size:12.5px}
kbd{padding:1px 5px;border:1px solid var(--border-strong);border-bottom-width:2px;border-radius:5px;background:var(--surface);font-size:11px}
button,input,select,textarea{font:inherit;color:inherit}
a{color:var(--accent-text)}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:12px;top:-48px;z-index:100;padding:8px 12px;border-radius:8px;background:var(--accent);color:var(--accent-contrast);text-decoration:none;font-weight:600}
.skip:focus{top:12px}
.muted{color:var(--muted)}
.faint{color:var(--faint)}
.small{font-size:12.5px}
.icon{width:16px;height:16px;flex:none}

/* ---------- top bar */
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;padding:10px 20px;border-bottom:1px solid var(--border);background:var(--surface);background:color-mix(in srgb,var(--surface) 86%,transparent);-webkit-backdrop-filter:saturate(1.4) blur(12px);backdrop-filter:saturate(1.4) blur(12px)}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px;letter-spacing:-.01em;white-space:nowrap}
.brand svg{width:28px;height:28px;flex:none}
.brand .ver{font-weight:500;font-size:12px;color:var(--faint)}
.stats{display:flex;gap:6px;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none;padding:2px}
.stats::-webkit-scrollbar{display:none}
.stat{display:inline-flex;align-items:baseline;gap:6px;padding:4px 11px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--muted);font-size:12.5px;white-space:nowrap;cursor:pointer;transition:border-color .15s,background .15s}
.stat b{color:var(--text);font-size:13.5px;font-variant-numeric:tabular-nums}
.stat:hover{border-color:var(--border-strong);background:var(--surface-2)}
.stat[aria-pressed="true"]{border-color:var(--tone);background:var(--tone-soft)}
.stat.hot{border-color:var(--tone);background:var(--tone-soft);color:var(--tone)}
.stat.hot b{color:var(--tone)}
.top-actions{display:flex;align-items:center;gap:8px}
.conn{display:inline-flex;align-items:center;gap:7px;padding:4px 10px;border-radius:999px;font-size:12.5px;color:var(--muted);white-space:nowrap}
.conn .dot{width:8px;height:8px;border-radius:50%;background:var(--faint)}
.conn[data-state="live"] .dot{background:var(--ok);animation:ring-ok 2.4s infinite}
.conn[data-state="polling"] .dot{background:var(--warn)}
.conn[data-state="offline"]{color:var(--danger)}
.conn[data-state="offline"] .dot{background:var(--danger)}

/* ---------- buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;border:1px solid var(--border-strong);border-radius:8px;background:var(--surface);color:var(--text);font-weight:550;font-size:13px;line-height:1;white-space:nowrap;cursor:pointer;text-decoration:none;transition:background .15s,border-color .15s,box-shadow .15s,color .15s}
.btn:hover{background:var(--surface-2)}
.btn:active{transform:translateY(.5px)}
.btn:disabled{opacity:.55;cursor:not-allowed}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-contrast)}
.btn-primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn-danger{background:var(--danger-solid);border-color:var(--danger-solid);color:#fff}
.btn-danger:hover{filter:brightness(1.08);background:var(--danger-solid)}
.btn-warn{background:var(--warn);border-color:var(--warn);color:#fff}
:root[data-theme="dark"] .btn-warn{color:#1a1204}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .btn-warn{color:#1a1204}}
.btn-warn:hover{filter:brightness(1.06);background:var(--warn)}
.btn-quiet-danger{color:var(--danger)}
.btn-quiet-danger:hover{background:var(--danger-soft);border-color:var(--danger)}
.btn-ghost{background:transparent;border-color:transparent}
.btn-ghost:hover{background:var(--surface-2)}
.btn-sm{height:28px;padding:0 10px;font-size:12.5px}
.btn-xs{height:24px;padding:0 8px;font-size:12px;border-radius:6px}
.btn-icon{width:32px;padding:0}
.btn-icon.btn-sm{width:28px}

/* ---------- pills, badges, chips */
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px 2px 8px;border-radius:999px;background:var(--tone-soft);color:var(--tone);font-size:12px;font-weight:650;white-space:nowrap;line-height:1.6}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.pill.s-working::before{animation:blink 1.4s ease-in-out infinite}
.badge{display:inline-flex;align-items:center;gap:4px;padding:0 7px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--muted);font-size:11.5px;font-weight:600;line-height:1.7;white-space:nowrap}
.badge.tone-warn,.badge.tone-attn,.badge.tone-info,.badge.tone-violet,.badge.tone-ok,.badge.tone-danger{border-color:transparent;background:var(--tone-soft);color:var(--tone)}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{display:inline-flex;align-items:center;padding:1px 9px;border-radius:999px;background:var(--accent-soft);color:var(--accent-text);font-size:12px;font-weight:550;line-height:1.7;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.actor{font-family:var(--mono);font-size:12.5px;color:var(--text)}
.actor.you{font-family:var(--sans);font-weight:650;color:var(--accent-text)}
.actor.sys{font-family:var(--sans);color:var(--muted)}
.prio{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 5px;border-radius:6px;background:var(--surface-3);color:var(--muted);font-size:12px;font-weight:650;font-variant-numeric:tabular-nums}
.prio.high{background:var(--attn-soft);color:var(--attn)}
.prio.low{background:transparent;color:var(--faint)}

/* ---------- layout */
main{flex:1;width:100%;max-width:1600px;margin:0 auto;padding:20px}
.layout{display:grid;grid-template-columns:minmax(300px,390px) minmax(0,1fr);gap:20px;align-items:start}
.panel{min-width:0;border:1px solid var(--border);border-radius:14px;background:var(--surface);box-shadow:var(--shadow)}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px 12px;flex-wrap:wrap;padding:14px 16px;border-bottom:1px solid var(--border)}
.panel-head h2{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700}
.count{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 6px;border-radius:999px;background:var(--surface-3);color:var(--muted);font-size:12px;font-weight:650}
.count:empty{display:none}
#agents-panel{position:sticky;top:74px;display:flex;flex-direction:column;max-height:calc(100vh - 94px)}
.agent-list{display:flex;flex-direction:column;gap:10px;padding:12px;overflow-y:auto;min-height:0}

/* ---------- inputs */
input[type="text"],input[type="search"],input[type="password"],select,textarea{width:100%;min-height:34px;padding:6px 10px;border:1px solid var(--border-strong);border-radius:8px;background:var(--input-bg);color:var(--text);transition:border-color .15s,box-shadow .15s}
select{padding-right:28px}
textarea{min-height:84px;resize:vertical;line-height:1.5}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--focus);box-shadow:0 0 0 3px var(--focus-ring)}
input::placeholder,textarea::placeholder{color:var(--faint)}
.search{position:relative;display:block}
.search .icon{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--faint);pointer-events:none}
.search input{padding-left:30px}
.field{display:flex;flex-direction:column;gap:6px;margin:0 0 14px;min-width:0}
.field>label,.field>legend,.label{font-size:12.5px;font-weight:650;color:var(--muted)}
fieldset.field{border:0;padding:0}
fieldset.field>legend{padding:0;margin-bottom:6px}
.opt{font-weight:400;color:var(--faint)}
.field-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.hint{font-size:12.5px;color:var(--muted)}
.form-error{min-height:0;color:var(--danger);font-size:13px;font-weight:550}
.form-error:empty{display:none}
.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
.seg{align-self:flex-start;display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);max-width:100%}
.seg input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.seg label{padding:5px 12px;border-radius:7px;color:var(--muted);font-size:13px;font-weight:550;cursor:pointer;user-select:none}
.seg label:hover{color:var(--text)}
.seg input:checked+label{background:var(--surface);color:var(--text);box-shadow:var(--shadow),0 0 0 1px var(--border)}
.seg input:focus-visible+label{outline:2px solid var(--focus);outline-offset:1px}
.switch{position:relative;display:inline-flex;align-items:center;gap:8px;font-size:12.5px;font-weight:550;color:var(--muted);cursor:pointer;user-select:none}
.switch input{position:absolute;opacity:0;width:1px;height:1px}
.switch .track{position:relative;width:32px;height:18px;flex:none;border-radius:999px;background:var(--border-strong);transition:background .15s}
.switch .thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .15s}
.switch input:checked+.track{background:var(--warn)}
.switch input:checked+.track .thumb{transform:translateX(14px)}
.switch input:checked~.switch-text{color:var(--warn)}
.switch input:focus-visible+.track{outline:2px solid var(--focus);outline-offset:2px}
.switch input:disabled+.track{opacity:.5}

/* ---------- attention banners */
#attention:empty{display:none}
#attention{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;margin-bottom:20px}
.banner{display:flex;gap:14px;align-items:flex-start;padding:14px 16px;border:1px solid var(--tone);border-color:color-mix(in srgb,var(--tone) 45%,transparent);border-radius:14px;background:var(--tone-soft);box-shadow:var(--shadow)}
.banner>.icon{width:22px;height:22px;margin-top:1px;color:var(--tone)}
.banner-main{flex:1;min-width:0}
.banner-title{display:flex;align-items:center;justify-content:space-between;gap:8px 12px;flex-wrap:wrap}
.banner-title h2{font-size:15px;font-weight:700;color:var(--text)}
.banner-sub{margin-top:2px;color:var(--muted);font-size:13px}
.banner-list{display:grid;grid-template-columns:minmax(0,1fr);gap:6px;margin:12px 0 0;padding:0;list-style:none}
.banner-item{display:flex;align-items:center;gap:10px 12px;flex-wrap:wrap;padding:8px 10px 8px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
.banner-item .bi-main{flex:1 1 200px;min-width:0}
.bi-title{display:block;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;border:0;padding:0;cursor:pointer;color:var(--text);text-align:left;max-width:100%}
.bi-title:hover{color:var(--accent-text);text-decoration:underline}
.bi-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--muted);font-size:12.5px}
.bi-question{display:block;margin-top:2px;color:var(--text);font-size:13px;white-space:pre-wrap;word-break:break-word;max-height:4.6em;overflow:hidden}
.bi-actions{display:flex;gap:6px}

/* ---------- agents */
.agent-card{display:flex;flex-direction:column;gap:9px;padding:13px 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface);transition:border-color .15s,box-shadow .15s}
.agent-card:hover{border-color:var(--border-strong);box-shadow:var(--shadow)}
.agent-card.p-offline{background:var(--surface-2)}
.agent-top{display:flex;align-items:flex-start;gap:10px}
.agent-names{flex:1;min-width:0}
.agent-name{font-size:14.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.agent-id{display:block;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pdot{position:relative;width:10px;height:10px;margin-top:6px;flex:none;border-radius:50%;background:var(--faint)}
.pdot.listening{background:var(--ok);animation:ring-ok 2s infinite}
.pdot.active{background:var(--ok)}
.pdot.connected{background:transparent;box-shadow:inset 0 0 0 2px var(--ok)}
.pdot.idle{background:var(--warn)}
.pdot.offline{background:var(--faint)}
.agent-presence{display:flex;align-items:center;gap:6px;flex-wrap:wrap;color:var(--muted);font-size:12.5px}
.agent-presence .st-busy{color:var(--attn);font-weight:600}
.agent-presence .st-away,.agent-presence .st-offline{color:var(--faint);font-weight:600}
.agent-desc{color:var(--muted);font-size:13px;display:-webkit-box;-webkit-line-clamp:3;line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.counts{display:flex;flex-wrap:wrap;gap:5px}
.agent-more{border-top:1px dashed var(--border);padding-top:8px}
.agent-more summary{display:inline-flex;align-items:center;gap:6px;color:var(--accent-text);font-size:12.5px;font-weight:600;cursor:pointer;list-style:none;border-radius:6px}
.agent-more summary::-webkit-details-marker{display:none}
.agent-more summary::before{content:"";width:6px;height:6px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);transition:transform .15s;margin-right:2px}
.agent-more[open] summary::before{transform:rotate(45deg)}
.instructions{max-height:300px;overflow:auto;margin:8px 0 10px;padding:10px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2);font:13px/1.55 var(--sans);white-space:pre-wrap;word-break:break-word}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;margin:0;font-size:12.5px}
.kv dt{color:var(--muted)}
.kv dd{margin:0;min-width:0;word-break:break-word}
.sessions{display:flex;flex-direction:column;gap:6px}
.sessions-title{color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.session-list{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.session{display:flex;align-items:flex-start;gap:9px;padding:7px 6px 7px 10px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)}
.sdot{width:8px;height:8px;margin-top:6px;flex:none;border-radius:50%;box-shadow:inset 0 0 0 2px var(--ok)}
.sdot.listening{background:var(--ok);box-shadow:none;animation:ring-ok 2s infinite}
.s-main{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.s-name{display:flex;align-items:center;gap:4px 6px;flex-wrap:wrap;font-size:13px}
.s-name strong{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:650}
.s-ws{display:flex;flex-wrap:wrap;gap:4px}
.chip-ws{background:var(--surface-3);color:var(--text);font-family:var(--mono);font-size:11.5px;font-weight:500}
.s-meta{color:var(--faint);font-size:12px}
.s-meta code{font-size:11.5px}
.s-actions{display:flex;gap:2px}
.unreg{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px dashed var(--border-strong);border-radius:10px;color:var(--muted);font-size:12.5px}
.unreg>.icon{margin-top:2px;color:var(--info)}
.unreg strong{color:var(--text)}
.agent-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;padding-top:9px;border-top:1px solid var(--border)}
.agent-btns{display:flex;gap:6px}

/* ---------- tasks */
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)}
.filters .search{flex:1 1 220px}
.filters select{width:auto;flex:0 1 190px}
.table-wrap{overflow-x:auto}
table.tasks{width:100%;border-collapse:separate;border-spacing:0;font-size:13.5px}
.tasks th{position:sticky;top:0;padding:9px 12px;border-bottom:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:11.5px;font-weight:650;letter-spacing:.04em;text-align:left;text-transform:uppercase;white-space:nowrap}
.tasks td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top}
.tasks tbody tr{cursor:pointer;transition:background .1s}
.tasks tbody tr:hover{background:var(--surface-2)}
.tasks tbody tr:last-child td{border-bottom:0}
.tasks tr.s-awaiting_approval td:first-child{box-shadow:inset 3px 0 0 var(--warn)}
.tasks tr.s-input_required td:first-child{box-shadow:inset 3px 0 0 var(--attn)}
.c-task{min-width:220px;width:46%}
.row-link{display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;max-width:100%;padding:0;border:0;background:none;color:var(--text);font-weight:650;text-align:left;cursor:pointer;overflow:hidden;word-break:break-word;border-radius:4px}
.row-link:hover{color:var(--accent-text)}
.t-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px;color:var(--muted);font-size:12px}
.t-sub code{color:var(--faint);font-size:11.5px}
.t-msg{min-width:0;max-width:34ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.route{display:inline-flex;align-items:center;gap:4px 6px;flex-wrap:wrap}
.route>*{white-space:nowrap}
.route .icon{width:14px;height:14px;color:var(--faint)}
.c-status{white-space:nowrap}
.pct{margin-left:6px;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.c-age{color:var(--muted);white-space:nowrap}
.more{display:flex;justify-content:center;padding:12px;border-top:1px solid var(--border)}

/* ---------- PC control */
#pc-panel{margin-top:20px;scroll-margin-top:84px}
.pc-top{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:16px 24px;padding:16px}
.pc-kill{display:flex;flex-direction:column;align-items:flex-start;gap:10px;min-width:0}
.pc-kill-row{display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap}
.btn-lg{height:44px;padding:0 18px;border-radius:10px;font-size:14.5px;font-weight:650}
.btn-lg .icon{width:18px;height:18px}
.pc-stopped{display:flex;gap:12px;align-items:flex-start;width:100%;padding:12px 14px;border:1px solid var(--tone);border-color:color-mix(in srgb,var(--tone) 45%,transparent);border-radius:12px;background:var(--tone-soft)}
.pc-stopped>.icon{width:20px;height:20px;margin-top:1px;color:var(--tone)}
.pc-stopped strong{display:block;color:var(--tone);font-size:14.5px;letter-spacing:.02em}
.pc-keys{display:inline-flex;gap:3px;vertical-align:baseline}
.pc-helper{display:flex;flex-direction:column;gap:8px;min-width:0}
.pc-badges{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.pc-section{border-top:1px solid var(--border)}
.pc-section-head{display:flex;align-items:center;justify-content:space-between;gap:6px 12px;flex-wrap:wrap;padding:14px 16px 10px}
.pc-section-head .section-title{margin:0}
.pc-section-head .hint{flex:1 1 260px;text-align:right}
.pc-log-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.pc-log-tools select{width:auto;min-height:30px;padding:3px 28px 3px 9px;font-size:12.5px}
table.pc-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
.pc-table th{padding:8px 12px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--surface-2);color:var(--muted);font-size:11.5px;font-weight:650;letter-spacing:.04em;text-align:left;text-transform:uppercase;white-space:nowrap}
.pc-table td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:middle}
.pc-table tbody tr:last-child td{border-bottom:0}
.pc-table tbody tr:hover{background:var(--surface-2)}
.pc-agent{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.pc-agent-name{font-weight:650}
.pc-err{display:block;max-width:46ch;margin-top:5px;color:var(--danger);font-size:12px;font-weight:550;white-space:normal;word-break:break-word}
.switch.pending input~.switch-text{color:var(--attn);font-weight:650}
.pc-time{white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums}
.pc-table .actor{white-space:nowrap}
.pc-args{display:block;max-width:36ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--mono);font-size:12px;color:var(--muted)}
.pc-result{display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;min-width:16ch;max-width:52ch;overflow:hidden;word-break:break-word}
.pc-c-dur{white-space:nowrap;color:var(--faint);font-variant-numeric:tabular-nums;text-align:right}
.pc-c-shot{width:1%}
.pc-thumb{display:block;padding:0;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);cursor:zoom-in;overflow:hidden;line-height:0;transition:border-color .15s,box-shadow .15s}
.pc-thumb:hover{border-color:var(--accent);box-shadow:0 0 0 3px var(--focus-ring)}
.pc-thumb img{display:block;width:88px;height:auto;max-height:66px;object-fit:cover;object-position:top}
.pc-o-refused td:first-child{box-shadow:inset 3px 0 0 var(--warn)}
.pc-o-error td:first-child{box-shadow:inset 3px 0 0 var(--danger)}
.modal.modal-shot{width:min(760px,calc(100% - 32px))}
.modal-shot .modal-body{padding-bottom:16px}
.pc-shot-img{display:block;max-width:100%;height:auto;margin:10px auto 0;border:1px solid var(--border);border-radius:10px;background:var(--surface-2)}
@media (max-width:960px){.pc-top{grid-template-columns:minmax(0,1fr)}.pc-section-head .hint{text-align:left}}
@media (max-width:820px){.pc-c-args,.pc-c-dur{display:none}}
@media (max-width:560px){.pc-top-label{display:none}.pc-top{padding:14px}}

/* ---------- empty states */
.empty{padding:40px 24px;text-align:center;color:var(--muted)}
.empty .e-icon{display:grid;place-items:center;width:44px;height:44px;margin:0 auto 12px;border-radius:12px;background:var(--surface-2);color:var(--faint)}
.empty .e-icon .icon{width:22px;height:22px}
.empty h3{margin-bottom:6px;color:var(--text);font-size:15px}
.empty p{max-width:420px;margin:0 auto}
.empty .btn{margin-top:14px}
.empty-sm{padding:24px 16px}
.code-row{display:inline-flex;align-items:center;gap:6px;max-width:100%;margin-top:14px;padding:4px 4px 4px 12px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)}
.code-row code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
.empty .tip{margin-top:12px;font-size:12.5px}

/* ---------- dialogs */
dialog{padding:0;border:0;background:var(--surface);color:var(--text)}
dialog::backdrop{background:rgba(9,11,15,.5);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px)}
.drawer{inset:0 0 0 auto;width:min(700px,100%);max-width:100%;height:100%;max-height:100%;margin:0;border-left:1px solid var(--border);box-shadow:var(--shadow-lg)}
.drawer[open]{animation:drawer-in .2s ease-out}
.drawer-inner{display:flex;flex-direction:column;height:100%}
.drawer-head{padding:14px 20px 14px;border-bottom:1px solid var(--border)}
.drawer-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.drawer-top .tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.drawer-head h2{font-size:18px;font-weight:700;letter-spacing:-.01em;word-break:break-word}
.drawer-sub{display:flex;align-items:center;gap:6px;margin-top:6px;color:var(--muted)}
.drawer-body{flex:1;overflow-y:auto;padding:18px 20px 40px}
.callout{display:flex;gap:10px;align-items:flex-start;margin-bottom:16px;padding:12px 14px;border:1px solid var(--tone);border-color:color-mix(in srgb,var(--tone) 40%,transparent);border-radius:11px;background:var(--tone-soft)}
.callout>.icon{width:18px;height:18px;margin-top:1px;color:var(--tone)}
.callout-body{flex:1;min-width:0}
.callout-body strong{display:block;margin-bottom:2px}
.callout-text{white-space:pre-wrap;word-break:break-word}
.action-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.action-row:empty{display:none}
.inline-form{margin-bottom:18px;padding:12px;border:1px solid var(--border);border-radius:11px;background:var(--surface-2)}
.inline-form textarea{min-height:72px;background:var(--surface)}
.meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:7px 18px;margin:0 0 20px;font-size:13px}
.meta dt{color:var(--muted)}
.meta dd{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0;min-width:0;word-break:break-word}
.meta progress{width:140px;height:8px}
.block{margin:0 0 18px}
.block h3,.section-title{margin-bottom:7px;color:var(--muted);font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}
.prose{max-height:460px;overflow:auto;margin:0;padding:11px 13px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);font:13.5px/1.6 var(--sans);white-space:pre-wrap;word-break:break-word}
.prose.result{border-color:color-mix(in srgb,var(--ok) 35%,var(--border));background:var(--ok-soft)}
.prose.error{border-color:color-mix(in srgb,var(--danger) 35%,var(--border));background:var(--danger-soft)}
pre.json{max-height:360px;overflow:auto;margin:0;padding:11px 13px;border:1px solid var(--border);border-radius:10px;background:var(--surface-2);white-space:pre;tab-size:2}
.empty-text{color:var(--faint);font-style:italic}
progress{appearance:none;-webkit-appearance:none;height:8px;border:0;border-radius:999px;background:var(--surface-3);overflow:hidden}
progress::-webkit-progress-bar{background:var(--surface-3);border-radius:999px}
progress::-webkit-progress-value{background:var(--violet);border-radius:999px}
progress::-moz-progress-bar{background:var(--violet);border-radius:999px}
.timeline{position:relative;margin:0 0 18px;padding:0;list-style:none}
.timeline li{position:relative;padding:0 0 16px 24px}
.timeline li::before{content:"";position:absolute;left:5px;top:18px;bottom:0;width:2px;background:var(--border)}
.timeline li:last-child::before{display:none}
.tl-dot{position:absolute;left:0;top:5px;width:12px;height:12px;border-radius:50%;background:var(--tone);box-shadow:0 0 0 3px var(--surface)}
.tl-head{display:flex;align-items:baseline;gap:4px 8px;flex-wrap:wrap;font-size:13px}
.tl-head time{color:var(--faint);font-size:12px}
.tl-msg{margin-top:5px;padding:8px 11px;border-radius:9px;background:var(--surface-2);font-size:13px;white-space:pre-wrap;word-break:break-word}
.tl-data summary{margin-top:4px;color:var(--muted);font-size:12px;cursor:pointer}
.tl-data pre{margin-top:4px}
.modal{width:min(580px,calc(100% - 32px));max-height:calc(100% - 48px);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-lg)}
.modal[open]{animation:pop .16s ease-out}
.modal.modal-sm{width:min(440px,calc(100% - 32px))}
.modal form{display:flex;flex-direction:column;max-height:calc(100vh - 48px)}
.modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px 12px}
.modal-head h2{font-size:17px;font-weight:700}
.modal-body{padding:4px 20px 6px;overflow-y:auto}
.modal-body>p{margin-bottom:12px;color:var(--muted)}
.modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border);background:var(--surface-2);border-radius:0 0 16px 16px}
#confirm .modal-body{padding-top:20px}
#confirm h2{font-size:16px;margin-bottom:8px}

/* ---------- toasts */
.toasts{position:fixed;right:16px;bottom:16px;z-index:200;display:flex;flex-direction:column;gap:8px;width:min(420px,calc(100vw - 32px));pointer-events:none}
.toast{display:flex;align-items:flex-start;gap:10px;padding:11px 12px 11px 14px;border-radius:11px;background:var(--toast-bg);color:var(--toast-fg);box-shadow:var(--shadow-lg);font-size:13.5px;pointer-events:auto;animation:pop .18s ease-out}
.toast>.icon{margin-top:2px}
.toast.tone-ok>.icon{color:#4ade80}
.toast.tone-warn>.icon{color:#fbbf24}
.toast.tone-error>.icon{color:#f87171}
:root[data-theme="dark"] .toast.tone-ok>.icon{color:#15803d}
:root[data-theme="dark"] .toast.tone-warn>.icon{color:#b45309}
:root[data-theme="dark"] .toast.tone-error>.icon{color:#b91c1c}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]) .toast.tone-ok>.icon{color:#15803d}
  :root:not([data-theme="light"]) .toast.tone-warn>.icon{color:#b45309}
  :root:not([data-theme="light"]) .toast.tone-error>.icon{color:#b91c1c}
}
.toast-msg{flex:1;min-width:0;word-break:break-word}
.toast-x{display:inline-flex;padding:2px;border:0;border-radius:5px;background:none;color:inherit;opacity:.65;cursor:pointer}
.toast-x:hover{opacity:1}

/* ---------- locked */
.locked{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:24px;background:var(--bg)}
.locked-card{width:min(430px,100%);padding:30px;border:1px solid var(--border);border-radius:18px;background:var(--surface);box-shadow:var(--shadow-lg)}
.locked-card .l-icon{display:grid;place-items:center;width:44px;height:44px;margin-bottom:14px;border-radius:12px;background:var(--accent-soft);color:var(--accent-text)}
.locked-card .l-icon .icon{width:22px;height:22px}
.locked-card .hint{margin:16px 0 0}
.locked-card h1{margin-bottom:6px;font-size:20px}
.locked-card p{margin-bottom:16px;color:var(--muted)}
.locked-card form{display:flex;flex-direction:column;gap:10px}

/* ---------- footer */
.foot{display:flex;align-items:center;justify-content:center;gap:6px 14px;flex-wrap:wrap;padding:16px 20px 24px;color:var(--faint);font-size:12.5px}
.foot code{color:var(--muted)}
.foot .sep{opacity:.5}

/* ---------- motion */
@keyframes ring-ok{0%{box-shadow:0 0 0 0 rgba(34,197,94,.55)}70%{box-shadow:0 0 0 7px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
@keyframes blink{50%{opacity:.35}}
@keyframes drawer-in{from{transform:translateX(28px);opacity:.4}to{transform:none;opacity:1}}
@keyframes pop{from{transform:translateY(6px) scale(.98);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}

/* ---------- responsive */
@media (max-width:1280px){
  .topbar{flex-wrap:wrap;row-gap:8px}
  .stats{order:3;flex-basis:100%}
  .top-actions{margin-left:auto}
  #agents-panel{top:112px;max-height:calc(100vh - 132px)}
}
@media (max-width:1100px){
  .layout{grid-template-columns:minmax(0,1fr)}
  #agents-panel{position:static;max-height:none}
  .agent-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));overflow:visible}
}
@media (max-width:820px){
  .topbar{gap:10px;padding:10px 14px}
  main{padding:14px}
  .tasks thead{display:none}
  .tasks,.tasks tbody,.tasks tr,.tasks td{display:block}
  .tasks tbody tr{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"task task" "route route" "status age" "pri assignee";gap:6px 12px;padding:12px 14px;border-bottom:1px solid var(--border)}
  .tasks td{padding:0;border:0}
  .tasks tr.s-awaiting_approval td:first-child,.tasks tr.s-input_required td:first-child{box-shadow:none}
  .tasks tr.s-awaiting_approval{box-shadow:inset 3px 0 0 var(--warn)}
  .tasks tr.s-input_required{box-shadow:inset 3px 0 0 var(--attn)}
  .c-task{grid-area:task;width:auto;min-width:0;max-width:none}
  .c-route{grid-area:route}
  .c-status{grid-area:status}
  .c-age{grid-area:age;text-align:right}
  .c-pri{grid-area:pri}
  .c-assignee{grid-area:assignee;text-align:right}
  .c-pri::before,.c-assignee::before{content:attr(data-label) ": ";color:var(--faint);font-size:12px}
}
@media (max-width:560px){
  .conn .conn-label{display:none}
  .new-label{display:none}
  .field-row{grid-template-columns:1fr}
  .meta{grid-template-columns:minmax(0,1fr);gap:2px}
  .meta dd{margin-bottom:8px}
  .agent-list{grid-template-columns:minmax(0,1fr)}
  .drawer-head,.drawer-body{padding-left:16px;padding-right:16px}
  .filters select{flex:1 1 140px}
}
`;
const BODY = String.raw `
<a class="skip" href="#main">Skip to content</a>
<div id="app">
<header class="topbar">
  <div class="brand">
    <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">__LOGO__</svg>
    <span>Bruce Comm</span><span class="ver" id="ver"></span>
  </div>
  <nav class="stats" id="stats" aria-label="Queue summary"></nav>
  <div class="top-actions">
    <button id="pc-top" class="btn btn-sm btn-danger" type="button" hidden></button>
    <span id="conn" class="conn" data-state="connecting" role="status" title="Connecting"><span class="dot" aria-hidden="true"></span><span class="conn-label">Connecting…</span></span>
    <button id="theme-btn" class="btn btn-ghost btn-icon" type="button" aria-label="Color theme: automatic" title="Color theme: automatic"></button>
    <button id="new-task-btn" class="btn btn-primary" type="button" title="New task (N)" aria-label="New task" data-icon="plus"><span class="new-label">New task</span></button>
  </div>
</header>

<main id="main" tabindex="-1">
  <div id="attention" aria-live="polite"></div>
  <div class="layout">
    <section class="panel" id="agents-panel" aria-labelledby="agents-h">
      <div class="panel-head">
        <h2 id="agents-h">Agents <span class="count" id="agents-count"></span></h2>
        <label class="search" id="agent-search-wrap" data-icon="search" hidden><span class="sr-only">Filter agents</span><input id="agent-q" type="search" placeholder="Filter agents" autocomplete="off" spellcheck="false"></label>
      </div>
      <div id="agents" class="agent-list"><div class="empty empty-sm"><p>Loading agents…</p></div></div>
    </section>

    <section class="panel" id="tasks-panel" aria-labelledby="tasks-h">
      <div class="panel-head">
        <h2 id="tasks-h">Tasks</h2>
        <span class="muted small" id="tasks-count" aria-live="polite"></span>
      </div>
      <form class="filters" id="filters" role="search" aria-label="Filter tasks">
        <label class="search" data-icon="search"><span class="sr-only">Search tasks</span><input id="task-q" type="search" placeholder="Search title, id, agent…  ( / )" autocomplete="off" spellcheck="false"></label>
        <label><span class="sr-only">Status</span>
          <select id="f-status">
            <option value="">All statuses</option>
            <option value="active">Open (not finished)</option>
            <option value="awaiting_approval">Awaiting approval</option>
            <option value="queued">Queued</option>
            <option value="working">Working</option>
            <option value="input_required">Needs input</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="rejected">Rejected</option>
            <option value="canceled">Canceled</option>
            <option value="expired">Expired</option>
            <option value="terminal">Finished (any)</option>
          </select>
        </label>
        <label><span class="sr-only">Agent</span><select id="f-agent"><option value="">All agents</option><option value="human">You (human)</option></select></label>
        <button class="btn btn-ghost btn-sm" type="reset" id="f-clear">Clear</button>
      </form>
      <div class="table-wrap" id="table-wrap">
        <table class="tasks">
          <caption class="sr-only">Tasks, newest first. Activate a title to open details.</caption>
          <thead><tr><th scope="col">Task</th><th scope="col">Route</th><th scope="col">Status</th><th scope="col">Pri</th><th scope="col">Assignee</th><th scope="col">Age</th></tr></thead>
          <tbody id="task-rows"></tbody>
        </table>
      </div>
      <div id="tasks-empty" hidden></div>
      <div class="more" id="more-wrap" hidden><button class="btn btn-sm" type="button" id="more-btn">Load more</button></div>
    </section>
  </div>

  <section class="panel" id="pc-panel" aria-labelledby="pc-h">
    <div class="panel-head">
      <h2 id="pc-h">PC control <span class="pill tone-neutral" id="pc-state">Loading…</span></h2>
      <span class="muted small">Agents operating this Mac (screen, mouse, keyboard) through the BruceControl helper</span>
    </div>
    <div class="pc-top">
      <div class="pc-kill" id="pc-kill" aria-live="polite"><p class="muted">Loading PC control…</p></div>
      <div class="pc-helper" id="pc-helper"></div>
    </div>
    <div class="pc-section">
      <div class="pc-section-head">
        <h3 class="section-title" id="pc-agents-h">Agents allowed to control this Mac</h3>
        <span class="hint">Off by default. Switching an agent on asks for Touch ID (or your login password) on this Mac.</span>
      </div>
      <div class="table-wrap" id="pc-agents-wrap" hidden>
        <table class="pc-table">
          <caption class="sr-only">Agents and whether each may control this Mac</caption>
          <thead><tr><th scope="col">Agent</th><th scope="col">PC control</th><th scope="col">Helper grant</th><th scope="col">Changed</th></tr></thead>
          <tbody id="pc-agent-rows"></tbody>
        </table>
      </div>
      <div id="pc-agents-empty" hidden></div>
    </div>
    <div class="pc-section">
      <div class="pc-section-head">
        <h3 class="section-title" id="pc-log-h">Action log</h3>
        <div class="pc-log-tools">
          <span class="muted small" id="pc-log-count" aria-live="polite"></span>
          <label><span class="sr-only">Filter the action log by agent</span><select id="pc-log-agent"><option value="">All agents</option></select></label>
        </div>
      </div>
      <div class="table-wrap" id="pc-log-wrap" hidden>
        <table class="pc-table">
          <caption class="sr-only">PC control actions, newest first. Activate a screenshot to enlarge it.</caption>
          <thead><tr><th scope="col">Screen</th><th scope="col">Time</th><th scope="col">Agent</th><th scope="col">Tool</th><th scope="col" class="pc-c-args">Arguments</th><th scope="col">Outcome</th><th scope="col">Result</th><th scope="col" class="pc-c-dur">Took</th></tr></thead>
          <tbody id="pc-log-rows"></tbody>
        </table>
      </div>
      <div id="pc-log-empty" hidden></div>
      <div class="more" id="pc-more-wrap" hidden><button class="btn btn-sm" type="button" id="pc-more-btn">Load older</button></div>
    </div>
  </section>
</main>

<footer class="foot">
  <span>Bruce Comm <span id="foot-ver"></span></span><span class="sep" aria-hidden="true">•</span>
  <span>MCP endpoint <code id="mcp-url"></code></span>
  <button class="btn btn-ghost btn-xs" type="button" id="copy-mcp" data-icon="copy">Copy</button><span class="sep" aria-hidden="true">•</span>
  <span>Shortcuts: <kbd>N</kbd> new task, <kbd>/</kbd> search</span>
</footer>
</div>

<dialog id="drawer" class="drawer" aria-labelledby="d-title">
  <div class="drawer-inner">
    <div class="drawer-head">
      <div class="drawer-top">
        <div class="tags" id="d-tags"></div>
        <button class="btn btn-ghost btn-icon btn-sm" type="button" id="d-close" aria-label="Close details" data-icon="x"></button>
      </div>
      <h2 id="d-title">Task</h2>
      <div class="drawer-sub"><code id="d-id"></code><button class="btn btn-ghost btn-xs" type="button" id="d-copy" data-icon="copy">Copy id</button></div>
    </div>
    <div class="drawer-body" id="d-body">
      <div id="d-callout"></div>
      <div class="action-row" id="d-actions"></div>
      <form class="inline-form" id="d-answer" hidden>
        <div class="field"><label for="d-answer-text">Your answer</label><textarea id="d-answer-text" required maxlength="20000" placeholder="Answer the question so the agent can continue…"></textarea></div>
        <div class="form-actions"><button class="btn btn-primary btn-sm" type="submit" data-icon="send">Send answer</button></div>
      </form>
      <dl class="meta" id="d-meta"></dl>
      <div id="d-content"></div>
      <h3 class="section-title">Timeline</h3>
      <ol class="timeline" id="d-timeline"></ol>
      <form class="inline-form" id="d-note">
        <div class="field"><label for="d-note-text">Add a note <span class="opt">visible to sender and assignee</span></label><textarea id="d-note-text" required maxlength="20000" placeholder="Leave a comment on this task…"></textarea></div>
        <div class="form-actions"><button class="btn btn-sm" type="submit">Add note</button></div>
      </form>
    </div>
  </div>
</dialog>

<dialog id="new-task" class="modal" aria-labelledby="nt-h">
  <form id="nt-form" novalidate>
    <div class="modal-head"><h2 id="nt-h">New task</h2><button class="btn btn-ghost btn-icon btn-sm" type="button" data-close aria-label="Close" data-icon="x"></button></div>
    <div class="modal-body">
      <fieldset class="field">
        <legend>Send to</legend>
        <div class="seg">
          <input type="radio" name="route" id="r-agent" value="agent" checked><label for="r-agent">Agent</label>
          <input type="radio" name="route" id="r-skill" value="skill"><label for="r-skill">Skill</label>
          <input type="radio" name="route" id="r-any" value="any"><label for="r-any">Anyone</label>
          <input type="radio" name="route" id="r-all" value="all"><label for="r-all">Everyone</label>
        </div>
        <p class="hint" id="route-hint"></p>
      </fieldset>
      <div class="field" id="nt-agent-field"><label for="nt-agent">Agent</label><select id="nt-agent"></select></div>
      <div class="field" id="nt-target-field" hidden>
        <label for="nt-target">Deliver to</label>
        <select id="nt-target"></select>
        <input type="text" id="nt-workspace" list="nt-workspaces" autocomplete="off" spellcheck="false" placeholder="Folder path or name, e.g. web-app" aria-label="Workspace" hidden>
        <datalist id="nt-workspaces"></datalist>
        <p class="hint" id="nt-target-hint"></p>
      </div>
      <div class="field" id="nt-skill-field" hidden><label for="nt-skill">Skill</label><input type="text" id="nt-skill" list="nt-skills" autocomplete="off" spellcheck="false" placeholder="e.g. code-review"><datalist id="nt-skills"></datalist></div>
      <fieldset class="field">
        <legend>Kind</legend>
        <div class="seg">
          <input type="radio" name="kind" id="k-task" value="task" checked><label for="k-task">Task</label>
          <input type="radio" name="kind" id="k-message" value="message"><label for="k-message">Message</label>
        </div>
        <p class="hint" id="kind-hint"></p>
      </fieldset>
      <div class="field"><label for="nt-title">Title</label><input type="text" id="nt-title" maxlength="300" required autocomplete="off" placeholder="What should be done?"></div>
      <div class="field"><label for="nt-body">Details <span class="opt">optional</span></label><textarea id="nt-body" rows="6" maxlength="100000" placeholder="Context, constraints, expected output…"></textarea></div>
      <div class="field-row">
        <div class="field"><label for="nt-priority">Priority</label>
          <select id="nt-priority">
            <option value="9">9 · Highest</option><option value="8">8</option><option value="7">7 · High</option><option value="6">6</option>
            <option value="5" selected>5 · Normal</option><option value="4">4</option><option value="3">3 · Low</option><option value="2">2</option>
            <option value="1">1</option><option value="0">0 · Lowest</option>
          </select>
        </div>
        <div class="field"><label for="nt-expires">Expires if unclaimed</label>
          <select id="nt-expires">
            <option value="">Never</option><option value="900">After 15 minutes</option><option value="3600">After 1 hour</option>
            <option value="14400">After 4 hours</option><option value="86400">After 1 day</option><option value="604800">After 7 days</option>
          </select>
        </div>
      </div>
      <p class="form-error" id="nt-error" role="alert"></p>
    </div>
    <div class="modal-foot"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit" id="nt-submit" data-icon="send">Send</button></div>
  </form>
</dialog>

<dialog id="confirm" class="modal modal-sm" aria-labelledby="cf-title" aria-describedby="cf-msg">
  <form method="dialog">
    <div class="modal-body">
      <h2 id="cf-title"></h2>
      <p id="cf-msg"></p>
      <div class="field" id="cf-field" hidden><label for="cf-input" id="cf-label"></label><textarea id="cf-input" rows="3" maxlength="20000"></textarea></div>
    </div>
    <div class="modal-foot"><button class="btn" value="cancel" id="cf-cancel">Cancel</button><button class="btn btn-danger" value="ok" id="cf-ok">Confirm</button></div>
  </form>
</dialog>

<dialog id="pc-shot" class="modal modal-shot" aria-labelledby="ps-title">
  <div class="modal-head"><h2 id="ps-title">Screen after the action</h2><button class="btn btn-ghost btn-icon btn-sm" type="button" id="ps-close" aria-label="Close" data-icon="x"></button></div>
  <div class="modal-body">
    <p class="muted small" id="ps-meta"></p>
    <img id="ps-img" class="pc-shot-img" alt="">
  </div>
  <div class="modal-foot"><a class="btn" id="ps-open" href="/" target="_blank" rel="noopener">Open in a new tab</a><button class="btn btn-primary" type="button" id="ps-done">Close</button></div>
</dialog>

<div id="locked" class="locked" hidden>
  <div class="locked-card">
    <div class="l-icon" data-icon="lock"></div>
    <h1>Bruce Comm is locked</h1>
    <p>This gateway was started with an access token. Enter it once to open the dashboard in this browser.</p>
    <form id="unlock-form">
      <label class="label" for="unlock-token">Access token</label>
      <input type="password" id="unlock-token" autocomplete="off" required>
      <p class="form-error" id="unlock-error" role="alert"></p>
      <button class="btn btn-primary" type="submit">Unlock</button>
    </form>
    <p class="hint">It is the value of <code>BRUCE_COMM_TOKEN</code> (or <code>--token</code>) the daemon was started with.</p>
  </div>
</div>

<div id="toasts" class="toasts" aria-live="polite"></div>
<noscript><p class="empty">The Bruce Comm dashboard needs JavaScript.</p></noscript>
`.replace('__LOGO__', LOGO_PATHS);
const SCRIPT = String.raw `
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const STATUS = {
    awaiting_approval: ['Awaiting approval', 'warn'],
    queued: ['Queued', 'info'],
    working: ['Working', 'violet'],
    input_required: ['Needs input', 'attn'],
    completed: ['Completed', 'ok'],
    failed: ['Failed', 'danger'],
    canceled: ['Canceled', 'neutral'],
    rejected: ['Rejected', 'danger'],
    expired: ['Expired', 'neutral'],
  };
  const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected', 'expired']);
  const PRESENCE = { listening: 'Listening for tasks', active: 'Active', connected: 'Connected', idle: 'Idle', offline: 'Offline' };
  const PRESENCE_ORDER = { listening: 0, active: 1, connected: 2, idle: 3, offline: 4 };
  const presenceLabel = (p) => PRESENCE[p] || p;
  const presenceRank = (p) => (p in PRESENCE_ORDER ? PRESENCE_ORDER[p] : 9);
  const EVENTS = {
    created: ['Created', 'info'], claimed: ['Claimed', 'violet'], delivered: ['Delivered', 'ok'],
    progress: ['Progress', 'violet'], input_requested: ['Asked a question', 'attn'], input_provided: ['Answered', 'info'],
    completed: ['Completed', 'ok'], failed: ['Failed', 'danger'], retrying: ['Retrying', 'warn'],
    rejected: ['Rejected', 'danger'], released: ['Released', 'neutral'], lease_expired: ['Lease expired', 'warn'],
    canceled: ['Canceled', 'neutral'], expired: ['Expired', 'neutral'], approved: ['Approved', 'ok'],
    denied: ['Denied', 'danger'], note: ['Note', 'neutral'], rerouted: ['Rerouted', 'info'],
  };
  const ROUTE_HINTS = {
    agent: 'Delivered only to the agent you pick.',
    skill: 'Any agent offering this skill (or tag) can claim it.',
    any: 'The first available agent claims it.',
    all: 'One copy goes to every registered agent (broadcast).',
  };
  const KIND_HINTS = {
    task: 'The recipient works on it and reports a result.',
    message: 'Informational: delivered once, no result expected.',
  };
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_ICON = { auto: 'auto', light: 'sun', dark: 'moon' };
  const THEME_LABEL = { auto: 'automatic', light: 'light', dark: 'dark' };
  const ICONS = {
    plus: ['M12 5v14', 'M5 12h14'],
    x: ['M18 6 6 18', 'M6 6l12 12'],
    copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
    check: ['M5 12.5l4.5 4.5L19 7'],
    alert: ['M12 3.5 2.5 20h19L12 3.5z', 'M12 10v4.5', 'M12 17.5h.01'],
    shield: ['M12 3l8 3v6c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V6l8-3z', 'M9 12l2 2 4-4.5'],
    question: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M9.6 9a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.6', 'M12 17h.01'],
    bot: ['M12 4v3', 'M5 8h14v11H5z', 'M9 13h.01', 'M15 13h.01', 'M2 13v2', 'M22 13v2'],
    inbox: ['M3 13l3-8h12l3 8v6H3z', 'M3 13h5l1.5 2h5l1.5-2h5'],
    send: ['M21 3 10 14', 'M21 3l-7 18-4-7-7-4 18-7z'],
    sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4'],
    moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
    auto: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', ['M12 3a9 9 0 0 1 0 18z', true]],
    lock: ['M6 11h12v10H6z', 'M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11'],
    arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
    search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
    filter: ['M4 5h16l-6 7v6l-4 2v-8L4 5z'],
    stop: ['M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z', 'M8.5 12h7'],
  };

  // ---------------------------------------------------------------- tiny DOM toolkit (text only, never HTML)
  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = String(value);
        else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
        else el.setAttribute(key, value === true ? '' : String(value));
      }
    }
    appendAll(el, children);
    return el;
  }

  /** Replace el's children; null/false entries are skipped (replaceChildren would print "null"). */
  function fill(el, ...children) {
    el.replaceChildren();
    appendAll(el, children);
    return el;
  }

  function appendAll(el, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) appendAll(el, child);
      else el.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attrs = { viewBox: '0 0 24 24', class: 'icon' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', focusable: 'false',
      fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    for (const key of Object.keys(attrs)) svg.setAttribute(key, attrs[key]);
    for (const part of ICONS[name] || []) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', Array.isArray(part) ? part[0] : part);
      if (Array.isArray(part) && part[1]) path.setAttribute('fill', 'currentColor');
      svg.appendChild(path);
    }
    return svg;
  }

  // ---------------------------------------------------------------- formatting
  function rel(ts) {
    const diff = Date.now() - ts;
    const future = diff < 0;
    const s = Math.round(Math.abs(diff) / 1000);
    if (s < 10) return future ? 'in a few seconds' : 'just now';
    let v;
    if (s < 60) v = s + 's';
    else if (s < 3600) v = Math.floor(s / 60) + 'm';
    else if (s < 86400) v = Math.floor(s / 3600) + 'h';
    else if (s < 86400 * 45) v = Math.floor(s / 86400) + 'd';
    else return new Date(ts).toLocaleDateString();
    return future ? 'in ' + v : v + ' ago';
  }

  function timeEl(ts) {
    if (ts === null || ts === undefined) return h('span', { class: 'faint', text: '—' });
    return h('time', { datetime: new Date(ts).toISOString(), title: new Date(ts).toLocaleString(), 'data-ts': ts, text: rel(ts) });
  }

  function tickTimes() {
    for (const el of document.querySelectorAll('time[data-ts]')) el.textContent = rel(Number(el.getAttribute('data-ts')));
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  function pill(status) {
    const s = STATUS[status] || [status, 'neutral'];
    return h('span', { class: 'pill tone-' + s[1] + ' s-' + status, text: s[0] });
  }

  function agentById(id) { return state.agents.find((a) => a.id === id) || null; }

  function actorEl(id) {
    if (id === 'human') return h('span', { class: 'actor you', text: 'You' });
    if (id === 'system') return h('span', { class: 'actor sys', text: 'System' });
    const agent = agentById(id);
    return h('span', { class: 'actor', title: agent ? agent.name : 'not registered', text: id });
  }

  function targetEl(t) {
    if (t.to_agent) return actorEl(t.to_agent);
    if (t.to_skill) return h('span', { class: 'chip', title: 'Any agent with this skill', text: 'skill: ' + t.to_skill });
    return h('span', { class: 'muted', text: 'anyone' });
  }

  function routeEl(t) {
    return h('span', { class: 'route' }, actorEl(t.from_agent), icon('arrow'), targetEl(t));
  }

  function prioEl(p) {
    return h('span', { class: 'prio' + (p >= 7 ? ' high' : p <= 2 ? ' low' : ''), title: 'Priority ' + p + ' (0 lowest – 9 highest)', text: String(p) });
  }

  function folderName(ws) { return String(ws).split('/').filter(Boolean).pop() || String(ws); }

  function clientText(s) { return s.client_name ? s.client_name + (s.client_version ? ' ' + s.client_version : '') : s.transport; }

  function sessionText(s) {
    const parts = [s.label || clientText(s)];
    if (s.workspaces && s.workspaces.length) parts.push(s.workspaces.map(folderName).join(', '));
    return parts.join(' · ');
  }

  function findSession(id) {
    for (const a of state.agents) for (const s of a.sessions || []) if (s.id === id) return s;
    return null;
  }

  function pinBadges(t) {
    return [
      t.to_session ? h('span', { class: 'badge tone-info', title: 'Only session ' + t.to_session + ' may claim it while it is connected; otherwise the workspace / other sessions of the agent may', text: 'session ' + t.to_session }) : null,
      t.to_workspace ? h('span', { class: 'badge tone-info', title: 'Only a session with workspace "' + t.to_workspace + '" may claim it', text: 'in ' + folderName(t.to_workspace) }) : null,
    ];
  }

  function jsonText(value) {
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }

  // ---------------------------------------------------------------- storage (per browser, best effort)
  const prefs = {
    get(key, fallback) {
      try { const v = localStorage.getItem('bruce-comm.' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('bruce-comm.' + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
    },
  };

  // ---------------------------------------------------------------- state
  const state = {
    status: null, agents: [], unregistered: [], tasks: [], approvals: [], questions: [],
    filter: { q: '', status: prefs.get('filter.status', ''), agent: prefs.get('filter.agent', '') },
    agentQuery: '',
    limit: 100,
    openTaskId: null,
    openTask: null,
    conn: 'connecting',
    locked: false,
  };
  const snapshots = {};
  function changed(key, value) {
    const s = JSON.stringify(value);
    if (snapshots[key] === s) return false;
    snapshots[key] = s;
    return true;
  }

  // ---------------------------------------------------------------- API
  class ApiError extends Error {
    constructor(message, status, code, hint) { super(message); this.status = status; this.code = code; this.hint = hint; }
  }

  async function api(method, path, body) {
    const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, init); } catch (e) { throw new ApiError('Cannot reach Bruce Comm.', 0, 'offline'); }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (res.status === 401) { lock(); throw new ApiError('This gateway requires a token.', 401, 'unauthorized'); }
    if (!res.ok) {
      const err = (data && data.error) || {};
      throw new ApiError(err.message || ('Request failed (HTTP ' + res.status + ').'), res.status, err.code, err.hint);
    }
    return data;
  }

  function taskPath(id, action) { return '/api/tasks/' + enc(id) + (action ? '/' + action : ''); }

  // ---------------------------------------------------------------- refresh loop
  let refreshTimer = null;
  let refreshing = false;
  let refreshAgain = false;

  function scheduleRefresh(delay) {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, delay === undefined ? 200 : delay);
  }

  function taskQuery() {
    const p = new URLSearchParams();
    p.set('limit', String(state.limit));
    if (state.filter.status) p.set('status', state.filter.status);
    if (state.filter.agent) p.set('agent', state.filter.agent);
    return p.toString();
  }

  async function refresh() {
    if (state.locked) return;
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
      const results = await Promise.all([
        api('GET', '/api/status'),
        api('GET', '/api/agents'),
        api('GET', '/api/tasks?' + taskQuery()),
        api('GET', '/api/tasks?status=awaiting_approval&limit=50'),
        api('GET', '/api/tasks?agent=human&role=sent&status=input_required&limit=50'),
      ]);
      state.status = results[0];
      state.agents = results[1].agents;
      state.unregistered = results[1].unregistered_sessions || [];
      state.tasks = results[2].tasks;
      state.approvals = results[3].tasks;
      state.questions = results[4].tasks;
      render();
      if (state.conn === 'offline' || state.conn === 'connecting') setConn(es && es.readyState === 1 ? 'live' : 'polling');
      if (!es && !esRetry) connectEvents();
      if (state.openTaskId && state.conn !== 'live') loadDrawer();
    } catch (e) {
      if (e.status !== 401) setConn('offline');
    } finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; scheduleRefresh(); }
    }
  }

  function render() {
    if (changed('status', state.status)) renderStatus();
    if (changed('agents', [state.agents, state.unregistered, state.agentQuery])) { renderAgents(); fillAgentOptions(); }
    if (changed('tasks', [state.tasks, state.filter, state.agents.length])) renderTasks();
    if (changed('attention', [state.approvals, state.questions])) renderAttention();
  }

  // ---------------------------------------------------------------- live updates (SSE, with polling fallback)
  let es = null;
  let esRetry = null;
  let pollTimer = null;
  let drawerTimer = null;

  function setConn(mode) {
    state.conn = mode;
    const el = $('conn');
    el.dataset.state = mode;
    const labels = { connecting: 'Connecting…', live: 'Live', polling: 'Polling', offline: 'Offline' };
    const titles = {
      connecting: 'Connecting to Bruce Comm…',
      live: 'Live: updates arrive instantly',
      polling: 'Live updates unavailable: refreshing every 5 seconds',
      offline: 'Cannot reach Bruce Comm: retrying every 5 seconds',
    };
    el.querySelector('.conn-label').textContent = labels[mode];
    el.title = titles[mode];
    el.setAttribute('aria-label', 'Connection: ' + labels[mode]);
    if (mode === 'live') stopPolling(); else startPolling();
  }

  function startPolling() {
    if (!pollTimer && !state.locked) pollTimer = setInterval(() => refresh(), 5000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function connectEvents() {
    clearTimeout(esRetry);
    esRetry = null;
    if (state.locked) return;
    if (!('EventSource' in window)) { setConn('polling'); return; }
    if (es) es.close();
    const source = new EventSource('/api/events');
    es = source;
    source.addEventListener('open', () => { setConn('live'); scheduleRefresh(0); });
    source.addEventListener('change', (ev) => {
      let data = null;
      try { data = JSON.parse(ev.data); } catch (e) { data = null; }
      scheduleRefresh();
      const ids = data && Array.isArray(data.taskIds) ? data.taskIds : [];
      if (state.openTaskId && (ids.length === 0 || ids.indexOf(state.openTaskId) >= 0)) scheduleDrawer();
    });
    source.addEventListener('error', () => {
      if (es !== source) return;
      if (source.readyState === 2) {
        source.close();
        es = null;
        if (!state.locked) esRetry = setTimeout(connectEvents, 5000);
      }
      if (state.conn === 'live' || state.conn === 'connecting') setConn('polling');
    });
  }

  function scheduleDrawer() {
    clearTimeout(drawerTimer);
    drawerTimer = setTimeout(loadDrawer, 200);
  }

  // ---------------------------------------------------------------- header & status
  function renderStatus() {
    const s = state.status;
    if (!s) return;
    const t = s.stats.tasks;
    const a = s.stats.agents;
    const online = a.listening + a.active + (a.connected || 0);
    $('ver').textContent = 'v' + s.version;
    $('foot-ver').textContent = 'v' + s.version;
    $('mcp-url').textContent = s.mcp_url;
    const items = [
      { label: 'agents online', value: online + '/' + a.total, tone: online ? 'ok' : 'neutral', title: 'Agents waiting for tasks, active in the last 2 minutes, or with an open connection' },
      s.stats.sessions ? { label: s.stats.sessions.connected === 1 ? 'session' : 'sessions', value: s.stats.sessions.connected, tone: 'neutral', title: 'Open connections (IDE windows, app instances, runners); ' + s.stats.sessions.listening + ' waiting for tasks' } : null,
      { label: 'awaiting approval', value: t.awaiting_approval, tone: 'warn', status: 'awaiting_approval', hot: t.awaiting_approval > 0 },
      { label: 'needs input', value: t.input_required, tone: 'attn', status: 'input_required', hot: t.input_required > 0 },
      { label: 'queued', value: t.queued, tone: 'info', status: 'queued' },
      { label: 'working', value: t.working, tone: 'violet', status: 'working' },
      { label: 'completed', value: t.completed, tone: 'ok', status: 'completed' },
      { label: 'failed', value: t.failed, tone: 'danger', status: 'failed' },
    ];
    $('stats').replaceChildren(...items.filter(Boolean).map((item) => h('button', {
      type: 'button',
      class: 'stat tone-' + item.tone + (item.hot ? ' hot' : ''),
      title: item.title || ('Show ' + item.label + ' tasks'),
      'aria-pressed': item.status ? String(state.filter.status === item.status) : null,
      onclick: () => {
        if (!item.status) { $('agents-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        setStatusFilter(state.filter.status === item.status ? '' : item.status);
        $('tasks-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }, h('b', { text: String(item.value) }), h('span', { text: item.label }))));
    const attention = t.awaiting_approval + state.questions.length;
    document.title = (attention ? '(' + attention + ') ' : '') + 'Bruce Comm';
  }

  // ---------------------------------------------------------------- attention banners
  // Built once and then updated in place: a row whose task did not change keeps its DOM node, so a refresh can never
  // swap an Approve / Deny / Answer button out from under a click (mousedown and mouseup must hit the same node).
  function renderAttention() {
    const box = $('attention');
    syncBanner(box, 'approvals', state.approvals, {
      section: () => h('section', { class: 'banner tone-warn', 'aria-labelledby': 'appr-h' },
        icon('shield'),
        h('div', { class: 'banner-main' },
          h('div', { class: 'banner-title' },
            h('h2', { id: 'appr-h' }),
            h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { setStatusFilter('awaiting_approval'); $('tasks-panel').scrollIntoView({ behavior: 'smooth' }); } }, 'Review all')),
          h('p', { class: 'banner-sub', text: 'These agents require your approval before they may see work from other agents.' }),
          h('ul', { class: 'banner-list' }),
          h('p', { class: 'banner-sub banner-more', hidden: true }))),
      title: (n) => plural(n, 'task') + ' awaiting your approval',
      key: (t) => t.id,
      item: (t) => h('li', { class: 'banner-item' },
        h('div', { class: 'bi-main' },
          h('button', { type: 'button', class: 'bi-title', onclick: () => openTask(t.id), text: t.title }),
          h('span', { class: 'bi-meta' }, routeEl(t), h('span', { class: 'faint' }, 'sent ', timeEl(t.created_at)))),
        h('div', { class: 'bi-actions' },
          h('button', { type: 'button', class: 'btn btn-sm btn-warn', 'data-action': 'approve', onclick: (ev) => approveTask(t, ev.currentTarget) }, icon('check'), 'Approve'),
          h('button', { type: 'button', class: 'btn btn-sm btn-quiet-danger', 'data-action': 'deny', onclick: () => denyTask(t) }, 'Deny'))),
    });
    syncBanner(box, 'questions', state.questions, {
      section: () => h('section', { class: 'banner tone-attn', 'aria-labelledby': 'q-h' },
        icon('question'),
        h('div', { class: 'banner-main' },
          h('div', { class: 'banner-title' }, h('h2', { id: 'q-h' })),
          h('p', { class: 'banner-sub', text: 'Tasks you sent are paused until you answer.' }),
          h('ul', { class: 'banner-list' }),
          h('p', { class: 'banner-sub banner-more', hidden: true }))),
      title: (n) => n === 1 ? 'An agent asked you a question' : n + ' agents asked you questions',
      // The question text and who asks can change while the task stays paused: then the row is rebuilt.
      key: (t) => JSON.stringify([t.id, t.assignee, t.status_message]),
      item: (t) => h('li', { class: 'banner-item' },
        h('div', { class: 'bi-main' },
          h('button', { type: 'button', class: 'bi-title', onclick: () => openTask(t.id), text: t.title }),
          h('span', { class: 'bi-meta' }, t.assignee ? actorEl(t.assignee) : null, h('span', { text: 'asks:' })),
          h('span', { class: 'bi-question', text: t.status_message || '(no question text)' })),
        h('div', { class: 'bi-actions' },
          h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => openTask(t.id, { focus: 'answer' }) }, 'Answer'))),
    });
  }

  /** One attention banner: created on first use, removed when empty, otherwise updated in place (approvals first). */
  function syncBanner(box, name, tasks, spec) {
    let section = box.querySelector(':scope > section[data-banner="' + name + '"]');
    if (!tasks.length) { if (section) section.remove(); return; }
    if (!section) {
      section = spec.section();
      section.dataset.banner = name;
      if (name === 'approvals') box.prepend(section); else box.append(section);
    }
    const n = tasks.length;
    const title = section.querySelector('h2');
    if (title.textContent !== spec.title(n)) title.textContent = spec.title(n);
    const more = section.querySelector('.banner-more');
    more.hidden = n <= 4;
    if (n > 4) more.textContent = '…and ' + (n - 4) + ' more.';
    syncKeyed(section.querySelector('ul.banner-list'), tasks.slice(0, 4), spec.key, spec.item);
  }

  /** Make el's children match items: nodes with an unchanged key stay untouched (not even moved when in place). */
  function syncKeyed(el, items, keyOf, make) {
    const old = new Map(Array.from(el.children).map((child) => [child.dataset.key, child]));
    const keys = items.map(keyOf);
    for (const [key, child] of old) if (keys.indexOf(key) < 0) child.remove();
    let prev = null;
    items.forEach((item, i) => {
      let node = old.get(keys[i]);
      if (!node) { node = make(item); node.dataset.key = keys[i]; }
      const at = prev ? prev.nextSibling : el.firstChild;
      if (node !== at) el.insertBefore(node, at);
      prev = node;
    });
  }

  // ---------------------------------------------------------------- agents
  function preserveUi(container, draw) {
    const open = new Set(Array.from(container.querySelectorAll('details[open][data-key]')).map((d) => d.dataset.key));
    const active = document.activeElement;
    const focusKey = active && container.contains(active) ? active.getAttribute('data-focus') : null;
    const scroll = container.scrollTop;
    draw();
    for (const key of open) {
      const d = container.querySelector('details[data-key="' + CSS.escape(key) + '"]');
      if (d) d.open = true;
    }
    if (focusKey) {
      const el = container.querySelector('[data-focus="' + CSS.escape(focusKey) + '"]');
      if (el) el.focus({ preventScroll: true });
    }
    container.scrollTop = scroll;
  }

  function agentHaystack(a) {
    return [a.id, a.name, a.platform, a.description, a.tags.join(' '), a.skills.map((s) => s.id + ' ' + (s.name || '')).join(' ')].join('\n').toLowerCase();
  }

  function renderAgents() {
    const container = $('agents');
    const all = state.agents;
    $('agents-count').textContent = all.length ? String(all.length) : '';
    $('agent-search-wrap').hidden = all.length < 4;
    const q = state.agentQuery.trim().toLowerCase();
    const list = all
      .filter((a) => !q || agentHaystack(a).includes(q))
      .sort((x, y) => presenceRank(x.presence) - presenceRank(y.presence) || x.name.localeCompare(y.name));
    preserveUi(container, () => {
      const hint = unregisteredHint();
      if (!all.length) fill(container, hint, emptyAgents());
      else if (!list.length) fill(container, hint, h('div', { class: 'empty empty-sm' }, h('p', { text: 'No agents match "' + state.agentQuery.trim() + '".' })));
      else fill(container, hint, list.map(agentCard));
    });
  }

  function unregisteredHint() {
    const n = state.unregistered.length;
    if (!n) return null;
    return h('div', { class: 'unreg', role: 'note' },
      icon('bot'),
      h('div', null,
        h('strong', { text: plural(n, 'connected client') + ' not registered yet' }),
        h('div', { text: state.unregistered.slice(0, 4).map(clientText).join(', ') + (n > 4 ? ', …' : '') }),
        h('div', { class: 'faint', text: 'They become agents once they call register_agent (or connect with ?agent=<id>).' })));
  }

  function mcpUrl() { return state.status ? state.status.mcp_url : location.origin + '/mcp'; }

  function emptyAgents() {
    return h('div', { class: 'empty' },
      h('div', { class: 'e-icon' }, icon('bot')),
      h('h3', { text: 'No agents yet' }),
      h('p', { text: 'Connect an AI client (Claude Desktop, VS Code Copilot, Cursor, Claude Code…) to Bruce Comm, then ask it to call register_agent.' }),
      h('div', { class: 'code-row' }, h('code', { text: mcpUrl() }), copyButton(mcpUrl(), 'Copy MCP URL')),
      h('p', { class: 'tip', text: 'Tip: run "bruce-comm config <client>" for a ready-to-paste client configuration.' }));
  }

  function copyButton(text, label) {
    return h('button', { type: 'button', class: 'btn btn-ghost btn-xs', 'aria-label': label || 'Copy', title: label || 'Copy', onclick: () => copy(text) }, icon('copy'));
  }

  function agentCard(a) {
    const counts = a.counts || {};
    const countBadges = [
      counts.tasks ? h('span', { class: 'badge tone-info', text: counts.tasks + ' waiting' }) : null,
      counts.working ? h('span', { class: 'badge tone-violet', text: counts.working + ' working' }) : null,
      counts.awaiting_approval ? h('span', { class: 'badge tone-warn', text: counts.awaiting_approval + ' awaiting approval' }) : null,
      counts.waiting_for_answer ? h('span', { class: 'badge tone-attn', text: counts.waiting_for_answer + ' waiting for an answer' }) : null,
    ].filter(Boolean);
    const statusText = a.status !== 'online' ? h('span', { class: 'st-' + a.status, text: a.status }) : null;
    const switchInput = h('input', { type: 'checkbox', role: 'switch', 'data-focus': 'appr-' + a.id, 'aria-describedby': 'appr-hint-' + a.id });
    switchInput.checked = a.require_approval;
    switchInput.addEventListener('change', () => toggleApproval(a, switchInput));
    const details = [
      ['Accepts from', a.accept_from.join(', ')],
      ['Max concurrent', String(a.max_concurrent_tasks)],
      ['Workspace', a.workspace], ['Owner', a.owner], ['Version', a.version],
      ['Registered', timeEl(a.registered_at)], ['Last seen', timeEl(a.last_seen_at)],
    ].filter((row) => row[1] !== null && row[1] !== undefined && row[1] !== '');
    return h('article', { class: 'agent-card p-' + a.presence, 'aria-label': a.name },
      h('div', { class: 'agent-top' },
        h('span', { class: 'pdot ' + a.presence, title: presenceLabel(a.presence), 'aria-hidden': 'true' }),
        h('div', { class: 'agent-names' }, h('h3', { class: 'agent-name', text: a.name }), h('code', { class: 'agent-id', text: a.id })),
        h('span', { class: 'badge', title: 'Platform', text: a.platform })),
      h('div', { class: 'agent-presence' },
        h('span', { text: presenceLabel(a.presence) }),
        h('span', { 'aria-hidden': 'true', text: '·' }),
        h('span', null, 'seen ', timeEl(a.last_seen_at)),
        a.connected_sessions ? [h('span', { 'aria-hidden': 'true', text: '·' }), h('span', { title: 'Open MCP connections (IDE windows / app instances)', text: plural(a.connected_sessions, 'session') + ' open' })] : null,
        statusText ? [h('span', { 'aria-hidden': 'true', text: '·' }), statusText] : null,
        a.status_message ? h('span', { class: 'faint', text: '“' + a.status_message + '”' }) : null),
      a.description ? h('p', { class: 'agent-desc', text: a.description }) : null,
      a.skills.length ? h('div', { class: 'chips', 'aria-label': 'Skills' }, a.skills.map((s) => h('span', { class: 'chip', title: s.description || s.id, text: s.name || s.id }))) : null,
      countBadges.length ? h('div', { class: 'counts' }, countBadges) : null,
      sessionList(a),
      h('details', { class: 'agent-more', 'data-key': 'more-' + a.id },
        h('summary', { 'data-focus': 'sum-' + a.id }, 'Instructions & details'),
        h('pre', { class: 'instructions', 'aria-label': 'Instructions for other agents', text: a.instructions }),
        h('dl', { class: 'kv' }, details.map((row) => [h('dt', { text: row[0] }), h('dd', null, row[1])]))),
      h('div', { class: 'agent-foot' },
        h('label', { class: 'switch', title: 'When on, tasks from other agents wait for your approval before this agent can see them.' },
          switchInput, h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'thumb' })),
          h('span', { class: 'switch-text', id: 'appr-hint-' + a.id, text: 'Require approval' })),
        h('div', { class: 'agent-btns' },
          h('button', { type: 'button', class: 'btn btn-sm', 'data-focus': 'send-' + a.id, onclick: () => openNewTask({ agent: a.id }) }, icon('send'), 'Send task'),
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost btn-quiet-danger', 'data-focus': 'del-' + a.id, onclick: () => unregisterAgent(a) }, 'Unregister'))));
  }

  function sessionList(a) {
    const sessions = a.sessions || [];
    if (!sessions.length) return null;
    return h('section', { class: 'sessions', 'aria-label': 'Open sessions of ' + a.name },
      h('div', { class: 'sessions-title', text: plural(sessions.length, 'open session') }),
      h('ul', { class: 'session-list' }, sessions.map((s) => h('li', { class: 'session' },
        h('span', { class: 'sdot' + (s.listening ? ' listening' : ''), title: s.listening ? 'Waiting for tasks right now' : 'Connected', 'aria-hidden': 'true' }),
        h('div', { class: 's-main' },
          h('div', { class: 's-name' },
            h('strong', { title: clientText(s), text: s.label || clientText(s) }),
            s.label ? h('span', { class: 'muted small', text: clientText(s) }) : null,
            h('span', { class: 'badge', text: s.transport })),
          s.workspaces.length ? h('div', { class: 's-ws' }, s.workspaces.map((w) => h('span', { class: 'chip chip-ws', title: w, text: folderName(w) }))) : null,
          h('div', { class: 's-meta' }, h('code', { text: s.id }), ' · ', s.listening ? 'listening now' : ['last active ', timeEl(s.last_active_at || s.started_at)])),
        h('div', { class: 's-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost btn-xs', title: 'Send a task to this session', 'aria-label': 'Send a task to session ' + s.id, 'data-focus': 'ss-' + s.id, onclick: () => openNewTask({ agent: a.id, session: s.id }) }, icon('send')),
          h('button', { type: 'button', class: 'btn btn-ghost btn-xs btn-quiet-danger', title: 'Close this session', 'aria-label': 'Close session ' + s.id, 'data-focus': 'sx-' + s.id, onclick: () => closeSession(s) }, icon('x')))))));
  }

  async function closeSession(s) {
    const answer = await confirmDialog({
      title: 'Close session ' + s.id + '?',
      message: sessionText(s) + '. Work pinned to it goes back to the agent’s other sessions. If this daemon hosts the connection it is disconnected; the app can reconnect at any time.',
      confirm: 'Close session', danger: true,
    });
    if (!answer) return;
    try {
      const r = await api('DELETE', '/api/sessions/' + enc(s.id));
      toast(r.already_closed ? 'Session ' + s.id + ' was already closed.' : 'Closed session ' + s.id + (r.disconnected ? ' and disconnected it.' : '.'), 'ok');
    } catch (e) { showError(e); }
    scheduleRefresh(0);
  }

  async function toggleApproval(agent, input) {
    const want = input.checked;
    input.disabled = true;
    try {
      await api('PATCH', '/api/agents/' + enc(agent.id), { require_approval: want });
      toast(want ? 'Tasks for ' + agent.name + ' now need your approval.' : agent.name + ' no longer needs approval.', 'ok');
    } catch (e) {
      input.checked = !want;
      showError(e);
    } finally {
      input.disabled = false;
      scheduleRefresh(0);
    }
  }

  async function unregisterAgent(agent) {
    const answer = await confirmDialog({
      title: 'Unregister ' + agent.name + '?',
      message: 'It disappears from the directory. Unfinished tasks addressed only to it are canceled; other work it holds goes back to the queue. The agent can register again at any time.',
      confirm: 'Unregister', danger: true,
    });
    if (!answer) return;
    try {
      const r = await api('DELETE', '/api/agents/' + enc(agent.id));
      toast('Unregistered ' + agent.id + ' (' + plural(r.canceled, 'task') + ' canceled, ' + r.requeued + ' re-queued).', 'ok');
    } catch (e) { showError(e); }
    scheduleRefresh(0);
  }

  // ---------------------------------------------------------------- tasks
  function taskHaystack(t) {
    return [t.id, t.title, t.body_preview, t.from_agent, t.to_agent || '', t.to_skill || '', t.assignee || '', t.status, t.thread_id].join('\n').toLowerCase();
  }

  function renderTasks() {
    const q = state.filter.q.trim().toLowerCase();
    const rows = state.tasks.filter((t) => !q || taskHaystack(t).includes(q));
    const body = $('task-rows');
    preserveUi(body, () => body.replaceChildren(...rows.map(taskRow)));
    const empty = $('tasks-empty');
    const filtered = Boolean(state.filter.status || state.filter.agent || q);
    $('table-wrap').hidden = rows.length === 0;
    if (rows.length) {
      empty.hidden = true;
    } else if (!filtered) {
      empty.replaceChildren(h('div', { class: 'empty' },
        h('div', { class: 'e-icon' }, icon('inbox')),
        h('h3', { text: 'No tasks yet' }),
        h('p', { text: 'Agents delegate work to each other with send_task, and it shows up here. You can also hand out work yourself.' }),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openNewTask() }, icon('plus'), 'New task')));
      empty.hidden = false;
    } else {
      empty.replaceChildren(h('div', { class: 'empty' },
        h('div', { class: 'e-icon' }, icon('filter')),
        h('h3', { text: 'No tasks match these filters' }),
        h('button', { type: 'button', class: 'btn', onclick: clearFilters }, 'Clear filters')));
      empty.hidden = false;
    }
    $('tasks-count').textContent = rows.length === state.tasks.length ? plural(rows.length, 'task') : rows.length + ' of ' + state.tasks.length + ' tasks';
    $('more-wrap').hidden = state.tasks.length < state.limit || state.limit >= 500;
  }

  function taskRow(t) {
    const open = () => openTask(t.id);
    const live = !TERMINAL.has(t.status);
    return h('tr', { class: 's-' + t.status, onclick: (ev) => { if (!ev.target.closest('button, a, input, select, textarea')) open(); } },
      h('td', { class: 'c-task' },
        h('button', { type: 'button', class: 'row-link', 'data-focus': 'row-' + t.id, title: t.title, onclick: open, text: t.title }),
        h('div', { class: 't-sub' },
          h('code', { text: t.id }),
          t.kind === 'message' ? h('span', { class: 'badge', text: 'message' }) : null,
          t.broadcast_id ? h('span', { class: 'badge', text: 'broadcast' }) : null,
          pinBadges(t),
          live && t.status_message ? h('span', { class: 't-msg', title: t.status_message, text: t.status_message }) : null)),
      h('td', { class: 'c-route', 'data-label': 'Route' }, routeEl(t)),
      h('td', { class: 'c-status', 'data-label': 'Status' }, pill(t.status), t.status === 'working' && t.progress !== null ? h('span', { class: 'pct', text: t.progress + '%' }) : null),
      h('td', { class: 'c-pri', 'data-label': 'Priority' }, prioEl(t.priority)),
      h('td', { class: 'c-assignee', 'data-label': 'Assignee' }, t.assignee ? actorEl(t.assignee) : h('span', { class: 'faint', text: '—' })),
      h('td', { class: 'c-age', 'data-label': 'Age' }, timeEl(t.created_at)));
  }

  function setStatusFilter(value) {
    state.filter.status = value;
    $('f-status').value = value;
    prefs.set('filter.status', value);
    state.limit = 100;
    snapshots.status = null;
    scheduleRefresh(0);
  }

  function clearFilters() {
    state.filter = { q: '', status: '', agent: '' };
    $('task-q').value = '';
    $('f-status').value = '';
    $('f-agent').value = '';
    prefs.set('filter.status', '');
    prefs.set('filter.agent', '');
    state.limit = 100;
    snapshots.status = null;
    scheduleRefresh(0);
  }

  function fillAgentOptions() {
    const select = $('f-agent');
    const current = state.filter.agent;
    const ids = state.agents.map((a) => a.id);
    if (current && current !== 'human' && ids.indexOf(current) < 0) ids.push(current);
    select.replaceChildren(
      h('option', { value: '', text: 'All agents' }),
      h('option', { value: 'human', text: 'You (human)' }),
      ...ids.map((id) => h('option', { value: id, text: id })));
    select.value = current;
  }

  // ---------------------------------------------------------------- task drawer
  const drawer = $('drawer');

  async function openTask(id, opts) {
    if (state.openTaskId !== id) {
      $('d-answer-text').value = '';
      $('d-note-text').value = '';
      state.openTask = null;
      $('d-title').textContent = 'Loading…';
      $('d-id').textContent = id;
      for (const part of ['d-tags', 'd-callout', 'd-actions', 'd-meta', 'd-content', 'd-timeline']) $(part).replaceChildren();
      $('d-answer').hidden = true;
    }
    state.openTaskId = id;
    showDialog(drawer);
    $('d-body').scrollTop = 0;
    await loadDrawer();
    if (opts && opts.focus === 'answer' && !$('d-answer').hidden) $('d-answer-text').focus();
  }

  drawer.addEventListener('close', () => { state.openTaskId = null; state.openTask = null; });

  async function loadDrawer() {
    const id = state.openTaskId;
    if (!id) return;
    try {
      const data = await api('GET', taskPath(id));
      if (state.openTaskId === id) renderDrawer(data.task, data.events);
    } catch (e) {
      if (state.openTaskId !== id) return;
      if (e.status === 404) {
        $('d-title').textContent = 'Task not found';
        $('d-callout').replaceChildren(callout('neutral', 'alert', 'This task no longer exists', 'It may have been purged from the history.'));
      } else if (e.status !== 401) {
        showError(e);
      }
    }
  }

  function callout(tone, iconName, title, text) {
    return h('div', { class: 'callout tone-' + tone, role: tone === 'danger' ? 'alert' : null },
      icon(iconName),
      h('div', { class: 'callout-body' }, h('strong', { text: title }), text ? h('div', { class: 'callout-text', text: text }) : null));
  }

  function renderDrawer(t, events) {
    state.openTask = t;
    fill($('d-tags'), pill(t.status),
      t.kind === 'message' ? h('span', { class: 'badge', text: 'message' }) : h('span', { class: 'badge', text: 'task' }),
      t.broadcast_id ? h('span', { class: 'badge', text: 'broadcast' }) : null,
      prioEl(t.priority));
    $('d-title').textContent = t.title;
    $('d-id').textContent = t.id;

    let note = null;
    const target = t.to_agent || (t.to_skill ? 'agents with skill "' + t.to_skill + '"' : 'any agent');
    if (t.status === 'awaiting_approval') note = callout('warn', 'shield', 'Waiting for your approval', 'Sent by ' + t.from_agent + '. ' + target + ' will not see it until you approve it.');
    else if (t.status === 'input_required') note = callout('attn', 'question', (t.assignee || 'The assignee') + ' asked a question', t.status_message || '');
    else if (t.status === 'failed') note = callout('danger', 'alert', 'Failed', t.error || '');
    else if (t.status === 'rejected') note = callout('danger', 'alert', t.approved_by === null && events.some((e) => e.type === 'denied') ? 'Denied' : 'Rejected', t.error || '');
    else if (t.status === 'canceled' || t.status === 'expired') note = callout('neutral', 'alert', STATUS[t.status][0], t.status_message || '');
    $('d-callout').replaceChildren(...(note ? [note] : []));

    const actions = [];
    if (t.status === 'awaiting_approval') {
      actions.push(h('button', { type: 'button', class: 'btn btn-warn', onclick: () => approveTask(t) }, icon('check'), 'Approve'));
      actions.push(h('button', { type: 'button', class: 'btn btn-quiet-danger', onclick: () => denyTask(t) }, 'Deny'));
    }
    if (!TERMINAL.has(t.status)) actions.push(h('button', { type: 'button', class: 'btn btn-quiet-danger btn-ghost', onclick: () => cancelTask(t) }, 'Cancel task'));
    $('d-actions').replaceChildren(...actions);

    const answerForm = $('d-answer');
    const canAnswer = t.status === 'input_required';
    answerForm.hidden = !canAnswer;

    const meta = [
      ['From', actorEl(t.from_agent)],
      ['To', [targetEl(t), t.broadcast_id ? h('span', { class: 'badge', text: 'broadcast' }) : null]],
      ['Assignee', t.assignee ? actorEl(t.assignee) : h('span', { class: 'faint', text: 'not claimed yet' })],
      t.to_session ? ['Only for session', sessionRef(t.to_session)] : null,
      t.to_workspace ? ['Only for workspace', h('code', { text: t.to_workspace })] : null,
      t.assignee_session ? ['Claimed by session', sessionRef(t.assignee_session)] : null,
      ['Attempts', t.attempts + ' of ' + t.max_attempts],
      t.progress !== null && !TERMINAL.has(t.status) ? ['Progress', [h('progress', { max: '100', value: String(t.progress), 'aria-label': 'Progress' }), h('span', { class: 'muted', text: t.progress + '%' })]] : null,
      ['Created', timeEl(t.created_at)],
      ['Updated', timeEl(t.updated_at)],
      t.claimed_at ? ['Claimed', timeEl(t.claimed_at)] : null,
      t.status === 'working' && t.lease_expires_at ? ['Lease expires', timeEl(t.lease_expires_at)] : null,
      t.not_before && t.not_before > Date.now() ? ['Not before', timeEl(t.not_before)] : null,
      t.expires_at && !TERMINAL.has(t.status) ? ['Expires', timeEl(t.expires_at)] : null,
      t.completed_at ? ['Finished', timeEl(t.completed_at)] : null,
      t.approved_by ? ['Approved by', actorEl(t.approved_by)] : null,
      ['Thread', h('code', { text: t.thread_id })],
      t.parent_task_id ? ['Parent task', h('button', { type: 'button', class: 'btn btn-ghost btn-xs', onclick: () => openTask(t.parent_task_id) }, t.parent_task_id)] : null,
      t.depth ? ['Delegation depth', String(t.depth)] : null,
    ].filter(Boolean);
    $('d-meta').replaceChildren(...meta.map((row) => [h('dt', { text: row[0] }), h('dd', null, row[1])]).flat());

    const blocks = [block('Details', t.body ? h('div', { class: 'prose', text: t.body }) : h('p', { class: 'empty-text', text: 'No details were provided.' }))];
    if (t.input !== null && t.input !== undefined) blocks.push(block('Input', h('pre', { class: 'json', text: jsonText(t.input) })));
    if (t.result) blocks.push(block('Result', h('div', { class: 'prose result', text: t.result })));
    if (t.result_data !== null && t.result_data !== undefined) blocks.push(block('Result data', h('pre', { class: 'json', text: jsonText(t.result_data) })));
    if (t.error && t.status !== 'failed' && t.status !== 'rejected') blocks.push(block('Last error', h('div', { class: 'prose error', text: t.error })));
    if (t.status_message && (t.status === 'queued' || t.status === 'working')) blocks.push(block('Status', h('div', { class: 'prose', text: t.status_message })));
    $('d-content').replaceChildren(...blocks);

    $('d-timeline').replaceChildren(...events.map(timelineItem));
  }

  function sessionRef(id) {
    const s = findSession(id);
    return [h('code', { text: id }), s ? h('span', { class: 'muted', text: sessionText(s) }) : h('span', { class: 'faint', text: 'not connected' })];
  }

  function block(title, content) {
    return h('section', { class: 'block' }, h('h3', { text: title }), content);
  }

  function timelineItem(ev) {
    const info = EVENTS[ev.type] || [ev.type, 'neutral'];
    const pct = ev.data && typeof ev.data === 'object' && typeof ev.data.percent === 'number' ? ev.data.percent : null;
    const extra = ev.data !== null && ev.data !== undefined && pct === null;
    return h('li', { class: 'tone-' + info[1] },
      h('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
      h('div', { class: 'tl-head' }, h('strong', { text: info[0] }), h('span', { class: 'muted' }, 'by ', actorEl(ev.actor)), timeEl(ev.at),
        pct !== null ? h('span', { class: 'badge tone-violet', text: pct + '%' }) : null),
      ev.message ? h('div', { class: 'tl-msg', text: ev.message }) : null,
      extra ? h('details', { class: 'tl-data' }, h('summary', { text: 'Attached data' }), h('pre', { class: 'json', text: jsonText(ev.data) })) : null);
  }

  async function approveTask(t, button) {
    if (button) button.disabled = true;
    try {
      const data = await api('POST', taskPath(t.id, 'approve'), {});
      const status = data && data.task ? data.task.status : null;
      // Trust the task the server returns, not the click: say plainly when it is still held.
      if (status && status !== 'awaiting_approval') toast('Approved: "' + t.title + '" is now ' + (STATUS[status] ? STATUS[status][0].toLowerCase() : status) + '.', 'ok');
      else toast('Not approved: "' + t.title + '" is still awaiting approval. Refresh the page and try again, or run: bruce-comm approve ' + t.id, 'error');
    } catch (e) {
      showError(e);
    } finally {
      if (button && button.isConnected) button.disabled = false;
    }
    afterWrite(t.id);
  }

  async function denyTask(t) {
    const answer = await confirmDialog({
      title: 'Deny this task?',
      message: '"' + t.title + '" from ' + t.from_agent + ' will be rejected and never delivered.',
      confirm: 'Deny task', danger: true, input: 'Reason (optional, shown to the sender)',
    });
    if (!answer) return;
    try {
      await api('POST', taskPath(t.id, 'deny'), answer.value ? { reason: answer.value } : {});
      toast('Denied "' + t.title + '".', 'ok');
    } catch (e) { showError(e); }
    afterWrite(t.id);
  }

  async function cancelTask(t) {
    const answer = await confirmDialog({
      title: 'Cancel this task?',
      message: 'The assignee is told to stop and the task will not be retried.',
      confirm: 'Cancel task', cancel: 'Keep it', danger: true, input: 'Reason (optional)',
    });
    if (!answer) return;
    try {
      await api('POST', taskPath(t.id, 'cancel'), answer.value ? { reason: answer.value } : {});
      toast('Canceled "' + t.title + '".', 'ok');
    } catch (e) { showError(e); }
    afterWrite(t.id);
  }

  function afterWrite(id) {
    scheduleRefresh(0);
    if (state.openTaskId === id) loadDrawer();
  }

  $('d-answer').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const t = state.openTask;
    const text = $('d-answer-text').value.trim();
    if (!t || !text) { $('d-answer-text').focus(); return; }
    const btn = ev.submitter || $('d-answer').querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('POST', taskPath(t.id, 'input'), { answer: text });
      $('d-answer-text').value = '';
      toast('Answer sent. ' + (t.assignee || 'The assignee') + ' can continue.', 'ok');
    } catch (e) { showError(e); }
    btn.disabled = false;
    afterWrite(t.id);
  });

  $('d-note').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const t = state.openTask;
    const text = $('d-note-text').value.trim();
    if (!t || !text) { $('d-note-text').focus(); return; }
    const btn = ev.submitter || $('d-note').querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await api('POST', taskPath(t.id, 'notes'), { note: text });
      $('d-note-text').value = '';
      toast('Note added.', 'ok');
    } catch (e) { showError(e); }
    btn.disabled = false;
    afterWrite(t.id);
  });

  // ---------------------------------------------------------------- new task
  const newTask = $('new-task');

  function selectedRadio(name) {
    const el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : '';
  }

  function fillTargetOptions(preferred) {
    const select = $('nt-target');
    const keep = preferred || select.value;
    const agent = agentById($('nt-agent').value);
    const sessions = agent ? agent.sessions || [] : [];
    fill(select,
      h('option', { value: '', text: sessions.length > 1 ? 'Any of its ' + sessions.length + ' sessions' : 'Any session of this agent' }),
      sessions.map((s) => h('option', { value: 'S:' + s.id, text: 'Session ' + s.id + ' · ' + sessionText(s) + (s.listening ? ' · listening' : '') })),
      h('option', { value: 'W', text: 'A session with a specific workspace…' }));
    select.value = Array.from(select.options).some((o) => o.value === keep) ? keep : '';
    const folders = new Set();
    for (const s of sessions) {
      for (const w of s.workspaces) { folders.add(w); folders.add(folderName(w)); }
      if (s.label) folders.add(s.label);
    }
    fill($('nt-workspaces'), Array.from(folders).map((w) => h('option', { value: w })));
    syncTarget();
  }

  function syncTarget() {
    const value = $('nt-target').value;
    $('nt-workspace').hidden = value !== 'W';
    $('nt-target-hint').textContent = value === 'W'
      ? 'Only a session that has this folder (path or name) or label open can claim it; it waits until one connects.'
      : value ? 'Only that session can claim it while it is connected. If it disconnects or goes quiet first, the task falls back to the agent’s other sessions.'
        : 'Whichever session of the agent asks for work first.';
  }

  function syncNewTaskForm() {
    const route = selectedRadio('route');
    $('nt-agent-field').hidden = route !== 'agent';
    $('nt-target-field').hidden = route !== 'agent' || !$('nt-agent').value;
    $('nt-skill-field').hidden = route !== 'skill';
    $('route-hint').textContent = ROUTE_HINTS[route] || '';
    $('kind-hint').textContent = KIND_HINTS[selectedRadio('kind')] || '';
  }

  function fillNewTaskOptions(preferred) {
    const select = $('nt-agent');
    const keep = preferred || select.value;
    const agents = state.agents.slice().sort((x, y) => presenceRank(x.presence) - presenceRank(y.presence) || x.name.localeCompare(y.name));
    if (!agents.length) {
      select.replaceChildren(h('option', { value: '', text: 'No agents registered yet' }));
      select.disabled = true;
    } else {
      select.disabled = false;
      select.replaceChildren(...agents.map((a) => h('option', { value: a.id, text: a.name + ' (' + a.id + ') · ' + presenceLabel(a.presence).toLowerCase() })));
      if (keep && agents.some((a) => a.id === keep)) select.value = keep;
    }
    const keys = new Map();
    for (const a of state.agents) {
      for (const s of a.skills) if (!keys.has(s.id)) keys.set(s.id, s.name || s.id);
      for (const tag of a.tags) if (!keys.has(tag)) keys.set(tag, 'tag');
    }
    $('nt-skills').replaceChildren(...[...keys.entries()].map((entry) => h('option', { value: entry[0], label: entry[1] })));
  }

  function openNewTask(preset) {
    if (state.locked) return;
    $('nt-error').textContent = '';
    if (preset && preset.agent) $('r-agent').checked = true;
    fillNewTaskOptions(preset && preset.agent);
    fillTargetOptions(preset && preset.session ? 'S:' + preset.session : '');
    syncNewTaskForm();
    showDialog(newTask);
    $('nt-title').focus();
  }

  document.querySelectorAll('input[name="route"], input[name="kind"]').forEach((el) => el.addEventListener('change', syncNewTaskForm));
  $('nt-agent').addEventListener('change', () => { fillTargetOptions(''); syncNewTaskForm(); });
  $('nt-target').addEventListener('change', () => { syncTarget(); if ($('nt-target').value === 'W') $('nt-workspace').focus(); });

  $('nt-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('nt-error');
    err.textContent = '';
    const route = selectedRadio('route');
    const kind = selectedRadio('kind') || 'task';
    const title = $('nt-title').value.trim();
    const body = $('nt-body').value.trim();
    const payload = { kind: kind, title: title, priority: Number($('nt-priority').value) };
    if (body) payload.body = body;
    if ($('nt-expires').value) payload.expires_in_seconds = Number($('nt-expires').value);
    if (route === 'agent') {
      if (!$('nt-agent').value) { err.textContent = 'Choose an agent (none are registered yet).'; return; }
      payload.to_agent = $('nt-agent').value;
      const target = $('nt-target').value;
      if (target.startsWith('S:')) payload.to_session = target.slice(2);
      else if (target === 'W') {
        const ws = $('nt-workspace').value.trim();
        if (!ws) { err.textContent = 'Enter the workspace folder (path or name), or pick another delivery option.'; $('nt-workspace').focus(); return; }
        payload.to_workspace = ws;
      }
    } else if (route === 'skill') {
      const skill = $('nt-skill').value.trim();
      if (!skill) { err.textContent = 'Enter the skill to route by.'; $('nt-skill').focus(); return; }
      payload.to_skill = skill;
    } else if (route === 'any') {
      payload.to_agent = '*';
    } else {
      payload.broadcast = true;
    }
    if (!title) { err.textContent = 'Give the ' + kind + ' a title.'; $('nt-title').focus(); return; }
    const submit = $('nt-submit');
    submit.disabled = true;
    try {
      const r = await api('POST', '/api/tasks', payload);
      newTask.close();
      $('nt-title').value = '';
      $('nt-body').value = '';
      const n = r.tasks.length;
      toast(n === 1 ? (kind === 'message' ? 'Message ' : 'Task ') + r.tasks[0].id + ' sent.' : 'Sent to ' + n + ' agents.', 'ok');
      for (const w of r.warnings || []) toast(w, 'warn');
      scheduleRefresh(0);
      if (n === 1) openTask(r.tasks[0].id);
    } catch (e) {
      err.textContent = e.message + (e.hint ? ' ' + e.hint : '');
    } finally {
      submit.disabled = false;
    }
  });

  // ---------------------------------------------------------------- PC control
  const PC_OUTCOME = { ok: ['ok', 'ok'], refused: ['refused', 'warn'], error: ['error', 'danger'] };
  const PC_BY = { human: 'you', cli: 'the command line', hotkey: 'the hotkey', menu: 'the menu bar', helper: 'the helper', daemon: 'Bruce Comm' };
  const PC_PAGE = 50;
  const pc = {
    status: null, log: [], error: null,
    pending: {}, errors: {}, killPending: null, permPending: false, warning: null,
    agent: '', limit: PC_PAGE, visible: false, loading: false, again: false, timer: null,
  };

  function pcPath(rest) { return '/api/pc-control' + (rest || ''); }
  function pcThumbUrl(id) { return pcPath('/log/' + enc(String(id)) + '/thumbnail'); }
  function pcBy(by) { return PC_BY[by] || by; }
  function pcStopped(s) { return Boolean(s && (s.killed || s.helper.killed === true)); }
  function pcOn(s) { return s ? s.agents.filter((a) => a.enabled) : []; }

  function pcLogQuery() {
    if (!pc.agent && pc.limit <= PC_PAGE) return '';
    const p = new URLSearchParams();
    p.set('limit', String(pc.limit));
    if (pc.agent) p.set('agent', pc.agent);
    return p.toString();
  }

  function schedulePc(delay) {
    clearTimeout(pc.timer);
    pc.timer = setTimeout(loadPc, delay);
  }

  /** Every 5 s while the panel is on screen, every 30 s otherwise (for the top-bar stop button); paused in hidden tabs. */
  async function loadPc() {
    clearTimeout(pc.timer);
    pc.timer = null;
    if (state.locked || document.hidden) return;
    if (pc.loading) { pc.again = true; return; }
    pc.loading = true;
    try {
      const q = pcLogQuery();
      const results = await Promise.all([api('GET', pcPath()), q ? api('GET', pcPath('/log?' + q)) : null]);
      pc.status = results[0];
      pc.log = results[1] ? results[1].log : results[0].log;
      pc.error = null;
    } catch (e) {
      pc.error = e.status === 401 ? null : e;
    } finally {
      pc.loading = false;
    }
    renderPc();
    if (state.locked) return;
    const again = pc.again;
    pc.again = false;
    schedulePc(again ? 0 : pc.visible ? 5000 : 30000);
  }

  function renderPc() {
    const s = pc.status;
    const head = s ? [s.killed, s.killed_updated_at, s.killed_updated_by, s.helper, s.platform_supported, s.hotkey, pcOn(s).map((a) => a.agent_id)] : null;
    if (changed('pc-head', [head, s ? s.kill_db_error : null, pc.error ? pc.error.message : null, pc.killPending, pc.permPending, pc.warning])) {
      renderPcKill();
      renderPcHelper();
      renderPcTop();
    }
    if (!s) return;
    if (changed('pc-agents', [s.agents, pc.pending, pc.errors])) { renderPcAgents(); fillPcAgentFilter(); }
    if (changed('pc-log', [pc.log, s.log_total, pc.limit, pc.agent])) renderPcLog();
  }

  function hotkeyHint() {
    return h('p', { class: 'hint' }, 'Emergency stop from any app: ',
      h('span', { class: 'pc-keys', title: 'Control + Option + Command + K' }, h('kbd', { text: '⌃' }), h('kbd', { text: '⌥' }), h('kbd', { text: '⌘' }), h('kbd', { text: 'K' })),
      ' (while BruceControl runs; also in its menu bar item, or run ', h('code', { text: 'bruce-comm pc-control stop' }), ').');
  }

  function renderPcKill() {
    const box = $('pc-kill');
    const stateEl = $('pc-state');
    const s = pc.status;
    preserveUi(box, () => {
      if (!s) {
        stateEl.className = 'pill tone-neutral';
        stateEl.textContent = pc.error ? 'Unavailable' : 'Loading…';
        fill(box, pc.error
          ? callout('danger', 'alert', 'Could not load PC control', pc.error.message + (pc.error.hint ? ' ' + pc.error.hint : ''))
          : h('p', { class: 'muted', text: 'Loading PC control…' }));
        return;
      }
      const stopped = pcStopped(s);
      const on = pcOn(s).length;
      stateEl.className = 'pill ' + (stopped ? 'tone-danger' : on ? 'tone-attn' : 'tone-neutral');
      stateEl.textContent = stopped ? 'Stopped' : on ? 'Active · ' + plural(on, 'agent') : 'Off';
      const warn = pc.warning ? callout('warn', 'alert', pc.warning.title, pc.warning.text) : null;
      if (stopped) {
        const who = s.killed ? pcBy(s.killed_updated_by || 'someone') : 'the helper’s own kill switch';
        fill(box,
          warn,
          h('div', { class: 'pc-stopped tone-danger', role: 'status' }, icon('stop'),
            h('div', { class: 'callout-body' },
              h('strong', { text: 'PC control is STOPPED' }),
              h('div', { class: 'muted small' }, 'Stopped by ' + who, s.killed && s.killed_updated_at ? [' ', timeEl(s.killed_updated_at)] : null,
                '. Every pc_* call is refused, whatever the agent switches say.'),
              s.kill_db_error ? h('div', { class: 'small', text: 'Not saved in the database (' + s.kill_db_error + '): only this Bruce Comm daemon and BruceControl (if it was told) know about this stop.' }) : null)),
          h('div', { class: 'pc-kill-row' },
            h('button', { type: 'button', class: 'btn btn-lg btn-primary', 'data-focus': 'pc-release', disabled: pc.killPending ? true : null, onclick: () => pcSetKilled(false) },
              icon('shield'), pc.killPending === 'release' ? 'Waiting for Touch ID…' : 'Re-enable (Touch ID)'),
            h('span', { class: 'hint', text: 'Needs your fingerprint or login password on this Mac.' })));
        return;
      }
      fill(box,
        warn,
        h('div', { class: 'pc-kill-row' },
          h('button', { type: 'button', class: 'btn btn-lg btn-danger', 'data-focus': 'pc-stop', disabled: pc.killPending ? true : null, onclick: () => pcSetKilled(true) },
            icon('stop'), pc.killPending === 'stop' ? 'Stopping…' : 'Stop all PC control'),
          h('span', { class: 'hint', text: on ? plural(on, 'agent') + ' may control this Mac right now.' : 'No agent may control this Mac right now.' })),
        hotkeyHint());
    });
  }

  function pcCheck(label, value, missingTip) {
    if (value === undefined || value === null) return h('span', { class: 'badge', title: label + ': unknown until the helper runs', text: label + ' ?' });
    return h('span', { class: 'badge tone-' + (value ? 'ok' : 'danger'), title: value ? label + ': granted' : missingTip, text: label + (value ? ' ✓' : ' ✗') });
  }

  function renderPcHelper() {
    const box = $('pc-helper');
    const s = pc.status;
    if (!s) { box.replaceChildren(); return; }
    const hp = s.helper;
    const badges = [];
    let note = null;
    if (!s.platform_supported) {
      badges.push(h('span', { class: 'badge tone-danger', text: 'macOS only' }));
      note = h('p', { class: 'hint', text: 'PC control works on macOS only; this daemon runs on another system.' });
    } else {
      if (hp.reachable && hp.mismatch) badges.push(h('span', { class: 'badge tone-danger', title: hp.error || '', text: 'Helper serves another data folder' }));
      else if (hp.reachable) badges.push(h('span', { class: 'badge tone-ok', title: hp.app_path + (hp.pid ? ' (pid ' + hp.pid + ')' : ''), text: 'Helper running' + (hp.version ? ' · v' + hp.version : '') }));
      else if (hp.installed) badges.push(h('span', { class: 'badge', title: hp.error || hp.app_path, text: 'Helper not running' }));
      else badges.push(h('span', { class: 'badge tone-danger', title: hp.app_path, text: 'Helper not installed' }));
      const tip = (name) => 'Missing: grant BruceControl "' + name + '" in System Settings > Privacy & Security';
      badges.push(pcCheck('Accessibility', hp.accessibility, tip('Accessibility')));
      badges.push(pcCheck('Screen Recording', hp.screen_recording, tip('Screen & System Audio Recording')));
      if (hp.reachable) {
        badges.push(hp.hotkey_registered === false
          ? h('span', { class: 'badge tone-warn', title: 'The global hotkey could not be registered; use the stop button or the menu bar item', text: 'Hotkey ✗' })
          : h('span', { class: 'badge tone-ok', title: 'Control+Option+Command+K stops everything', text: 'Hotkey ✓' }));
      }
      if (hp.state_loading) {
        badges.push(h('span', { class: 'badge', title: 'BruceControl is still reading its state (Keychain or the Bruce Comm database); it refuses actions until it is done.', text: 'Loading state…' }));
      } else if (hp.signature_ok === false) {
        badges.push(h('span', { class: 'badge tone-danger', title: 'BruceControl could not read its state from the Keychain, so it refuses everything (fail closed). Re-enabling or switching an agent on rewrites it.', text: 'Helper state unreadable' }));
      }
      if (hp.reachable && hp.mismatch) {
        note = h('p', { class: 'hint', text: 'BruceControl is running for another Bruce Comm data folder' + (hp.home ? ' (' + hp.home + ')' : '') +
          '; this Bruce Comm (' + s.home + ') cannot use it. Quit it from its menu bar item; the next PC action starts it for this folder.' });
      } else if (!hp.installed) {
        note = h('p', { class: 'hint' }, 'Build and install it with ', h('code', { text: 'npm run build:helper' }),
          ' in the Bruce Comm folder, then grant BruceControl Accessibility and Screen & System Audio Recording in System Settings > Privacy & Security.');
      } else if (hp.accessibility === false || hp.screen_recording === false) {
        note = h('p', { class: 'hint', text: 'Grant BruceControl the missing permission in System Settings > Privacy & Security (after a rebuild, remove it there and add it again). Request permissions shows the macOS prompts.' });
      } else if (!hp.reachable) {
        note = h('p', { class: 'hint', text: 'It starts on the first PC action, or when you request permissions.' });
      }
    }
    const canRequest = s.platform_supported && hp.installed;
    preserveUi(box, () => fill(box,
      h('div', { class: 'label', text: 'Helper and macOS permissions' }),
      h('div', { class: 'pc-badges' }, badges,
        canRequest ? h('button', { type: 'button', class: 'btn btn-xs', 'data-focus': 'pc-perm', disabled: pc.permPending ? true : null, onclick: pcRequestPermissions },
          pc.permPending ? 'Asking macOS…' : 'Request permissions') : null),
      note));
  }

  function renderPcTop() {
    const btn = $('pc-top');
    const s = pc.status;
    const stopped = pcStopped(s);
    const on = pcOn(s).length;
    if (!s || (!stopped && !on)) { btn.hidden = true; return; }
    const label = stopped ? 'PC control stopped' : 'Stop PC control';
    const title = stopped ? 'PC control is stopped. Show the PC control panel.' : 'Stop all PC control now (' + plural(on, 'agent') + ' switched on). Hotkey: Control+Option+Command+K';
    btn.className = 'btn btn-sm ' + (stopped ? 'btn-quiet-danger' : 'btn-danger');
    btn.disabled = !stopped && Boolean(pc.killPending);
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.replaceChildren(icon('stop'), h('span', { class: 'pc-top-label', text: label }));
    btn.hidden = false;
  }

  function renderPcAgents() {
    const list = pc.status.agents.slice().sort((x, y) => (x.name || x.agent_id).localeCompare(y.name || y.agent_id) || x.agent_id.localeCompare(y.agent_id));
    const body = $('pc-agent-rows');
    preserveUi(body, () => body.replaceChildren(...list.map(pcAgentRow)));
    $('pc-agents-wrap').hidden = list.length === 0;
    const empty = $('pc-agents-empty');
    empty.hidden = list.length > 0;
    if (!list.length) empty.replaceChildren(h('div', { class: 'empty empty-sm' }, h('p', { text: 'No agents registered yet. They appear here once they call register_agent, each one switched off.' })));
  }

  function pcAgentRow(a) {
    const pending = pc.pending[a.agent_id];
    const err = pc.errors[a.agent_id];
    const input = h('input', { type: 'checkbox', role: 'switch', 'data-focus': 'pc-sw-' + a.agent_id, 'aria-label': 'PC control for ' + a.agent_id });
    input.checked = pending ? pending === 'on' : a.enabled;
    input.disabled = Boolean(pending) || (!a.registered && !a.enabled);
    input.addEventListener('change', () => pcToggle(a, input));
    const text = pending === 'on' ? 'Waiting for Touch ID…' : pending === 'off' ? 'Switching off…' : a.enabled ? 'On' : 'Off';
    let grant;
    if (a.granted === null || a.granted === undefined) grant = h('span', { class: 'faint', title: 'Unknown while the helper is not running', text: '?' });
    else if (a.granted) grant = h('span', { class: 'badge tone-ok', title: 'Granted in BruceControl’s own state in the Keychain (approved with Touch ID)', text: 'granted' });
    else if (a.enabled) grant = h('span', { class: 'badge tone-warn', title: 'On here but not granted in BruceControl’s Keychain state (approved with Touch ID), so BruceControl refuses its actions. Switch it off and on again.', text: 'not granted' });
    else grant = h('span', { class: 'faint', text: '—' });
    return h('tr', null,
      h('td', null,
        h('div', { class: 'pc-agent' },
          h('span', { class: 'pc-agent-name', text: a.name || a.agent_id }),
          a.platform ? h('span', { class: 'badge', title: 'Platform', text: a.platform }) : null,
          a.registered ? null : h('span', { class: 'badge tone-warn', title: 'Unregistered while still switched on: switch it off.', text: 'unregistered' })),
        h('code', { class: 'agent-id', text: a.agent_id })),
      h('td', null,
        h('label', { class: 'switch' + (pending ? ' pending' : ''), title: 'When on, this agent may see the screen and use the mouse and keyboard. Switching on needs Touch ID.' },
          input, h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'thumb' })),
          h('span', { class: 'switch-text', text: text })),
        err ? h('span', { class: 'pc-err', role: 'alert', text: err }) : null),
      h('td', null, grant),
      h('td', { class: 'pc-time' }, a.updated_at
        ? [timeEl(a.updated_at), a.updated_by ? h('span', { class: 'faint', text: ' by ' + pcBy(a.updated_by) }) : null]
        : h('span', { class: 'faint', text: 'never' })));
  }

  function fillPcAgentFilter() {
    const select = $('pc-log-agent');
    const ids = pc.status.agents.map((a) => a.agent_id).sort();
    if (pc.agent && ids.indexOf(pc.agent) < 0) ids.push(pc.agent);
    select.replaceChildren(h('option', { value: '', text: 'All agents' }), ...ids.map((id) => h('option', { value: id, text: id })));
    select.value = pc.agent;
  }

  function argsSummary(args) {
    if (args === null || args === undefined) return '';
    if (typeof args !== 'object' || Array.isArray(args)) return jsonText(args);
    return Object.keys(args).map((key) => {
      const v = args[key];
      if (typeof v === 'string') return key + '="' + (v.length > 40 ? v.slice(0, 39) + '…' : v) + '"';
      if (Array.isArray(v)) return key + '=[' + v.length + ']';
      if (v && typeof v === 'object') return key + '={…}';
      return key + '=' + String(v);
    }).join(' ');
  }

  function clockEl(ts) {
    const d = new Date(ts);
    const today = d.toDateString() === new Date().toDateString();
    return h('time', { datetime: d.toISOString(), title: d.toLocaleString(), text: today ? d.toLocaleTimeString() : d.toLocaleString() });
  }

  function durText(ms) { return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s'; }

  function renderPcLog() {
    const s = pc.status;
    const rows = pc.log || [];
    const body = $('pc-log-rows');
    preserveUi(body, () => body.replaceChildren(...rows.map(pcLogRow)));
    $('pc-log-wrap').hidden = rows.length === 0;
    const empty = $('pc-log-empty');
    empty.hidden = rows.length > 0;
    if (!rows.length) {
      empty.replaceChildren(h('div', { class: 'empty empty-sm' }, h('p', { text: pc.agent
        ? 'No PC actions by ' + pc.agent + ' in the log.'
        : 'No PC actions yet. Every pc_* call, allowed or refused, shows up here with a screenshot of the result.' })));
    }
    $('pc-log-count').textContent = !rows.length ? ''
      : pc.agent ? plural(rows.length, 'entry', 'entries') + ' by ' + pc.agent
        : 'Latest ' + rows.length + ' of ' + s.log_total + ' · kept 30 days';
    $('pc-more-wrap').hidden = rows.length < pc.limit || pc.limit >= 500;
  }

  function pcLogRow(r) {
    const o = PC_OUTCOME[r.outcome] || [r.outcome, 'neutral'];
    const shot = r.thumbnail
      ? h('button', { type: 'button', class: 'pc-thumb', title: 'Show the screen after this action', 'aria-label': 'Enlarge the screenshot of log entry ' + r.id, 'data-focus': 'pc-th-' + r.id, onclick: () => openPcShot(r) },
        h('img', { src: pcThumbUrl(r.id), alt: '', loading: 'lazy', decoding: 'async', width: '88', height: '55' }))
      : h('span', { class: 'faint', text: '—' });
    return h('tr', { class: 'pc-o-' + r.outcome },
      h('td', { class: 'pc-c-shot' }, shot),
      h('td', { class: 'pc-time' }, clockEl(r.at)),
      h('td', null, r.agent_id ? actorEl(r.agent_id) : h('span', { class: 'faint', title: 'The client had no configured agent identity', text: 'no identity' })),
      h('td', null, h('code', { text: r.tool })),
      h('td', { class: 'pc-c-args' }, h('span', { class: 'pc-args', title: jsonText(r.args), text: argsSummary(r.args) || '—' })),
      h('td', null, h('span', { class: 'pill tone-' + o[1], text: o[0] })),
      h('td', null, r.result ? h('span', { class: 'pc-result', title: r.result, text: r.result }) : h('span', { class: 'faint', text: '—' })),
      h('td', { class: 'pc-c-dur' }, r.duration_ms === null || r.duration_ms === undefined ? '' : durText(r.duration_ms)));
  }

  function openPcShot(r) {
    const url = pcThumbUrl(r.id);
    $('ps-title').textContent = r.tool + ' · ' + (r.agent_id || 'no identity');
    $('ps-meta').textContent = new Date(r.at).toLocaleString() + (r.result ? ' · ' + r.result : '');
    $('ps-img').alt = 'Screen after ' + r.tool + ' (log entry ' + r.id + ')';
    $('ps-img').src = url;
    $('ps-open').href = url;
    showDialog($('pc-shot'));
    $('ps-done').focus();
  }

  async function pcSetKilled(killed) {
    if (pc.killPending) return;
    pc.killPending = killed ? 'stop' : 'release';
    renderPc();
    pc.warning = null;
    try {
      const r = await api('POST', pcPath('/kill'), { killed: killed });
      if (pc.status) { pc.status.killed = killed; if (!killed) pc.status.helper.killed = false; }
      if (!killed) toast('PC control re-enabled. Agents that are switched on may act again.', 'ok');
      else if (r.db_error) {
        pc.warning = { title: 'Stop not saved in the database', text: 'The database could not be written (' + r.db_error + '). BruceControl was told and refuses every action; this daemon refuses every call until you re-enable PC control.' };
        toast('PC control stopped by BruceControl, but the stop is not in the database.', 'warn');
      } else if (r.helper_notified === false) {
        pc.warning = { title: 'BruceControl was not told', text: 'Bruce Comm refuses every pc_* call. BruceControl was not told; it will apply the stop when it next starts. (' + (r.helper_error || 'not reachable') + ')' };
        toast('PC control stopped in Bruce Comm. BruceControl was not told; it will apply the stop when it next starts.', 'warn');
      } else toast('All PC control stopped: Bruce Comm and BruceControl refuse every pc_* call until you re-enable it.', 'ok');
    } catch (e) { showError(e); }
    pc.killPending = null;
    renderPc();
    loadPc();
  }

  async function pcToggle(a, input) {
    const want = input.checked;
    pc.pending[a.agent_id] = want ? 'on' : 'off';
    delete pc.errors[a.agent_id];
    pc.warning = null;
    renderPc();
    try {
      const r = await api('POST', pcPath('/agents/' + enc(a.agent_id)), { enabled: want });
      const row = pc.status && pc.status.agents.find((x) => x.agent_id === a.agent_id);
      if (row) row.enabled = want;
      if (want) toast(a.agent_id + ' may now control this Mac.', 'ok');
      else if (r.db_error) {
        pc.warning = { title: a.agent_id + ': switch-off not saved in the database', text: 'The database could not be written (' + r.db_error + '). BruceControl was told and refuses this agent’s actions.' };
        toast(a.agent_id + ' was switched off in BruceControl, but not in the database.', 'warn');
      } else if (r.helper_notified === false) {
        pc.warning = { title: a.agent_id + ': BruceControl was not told', text: 'Bruce Comm refuses this agent’s calls. BruceControl was not told; it will drop the agent’s grant when it next starts. (' + (r.helper_error || 'not reachable') + ')' };
        toast(a.agent_id + ' is switched off in Bruce Comm. BruceControl was not told; it will drop the grant when it next starts.', 'warn');
      } else toast(a.agent_id + ' may no longer control this Mac.', 'ok');
    } catch (e) {
      if (e.status !== 401) pc.errors[a.agent_id] = e.message + (e.hint ? ' ' + e.hint : '');
    }
    delete pc.pending[a.agent_id];
    renderPc();
    loadPc();
  }

  async function pcRequestPermissions() {
    if (pc.permPending) return;
    pc.permPending = true;
    renderPc();
    try {
      const r = await api('POST', pcPath('/permissions'), {});
      const p = r.permissions || {};
      const missing = [p.accessibility === false ? 'Accessibility' : null, p.screen_recording === false ? 'Screen Recording' : null].filter(Boolean);
      if (missing.length) toast('BruceControl still needs ' + missing.join(' and ') + ': allow it in System Settings > Privacy & Security, then come back here.', 'warn');
      else toast('BruceControl has the permissions it needs.', 'ok');
    } catch (e) { showError(e); }
    pc.permPending = false;
    renderPc();
    loadPc();
  }

  function initPc() {
    $('pc-top').addEventListener('click', () => {
      if (pcStopped(pc.status)) $('pc-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      else pcSetKilled(true);
    });
    $('pc-log-agent').addEventListener('change', (ev) => { pc.agent = ev.target.value; pc.limit = PC_PAGE; loadPc(); });
    $('pc-more-btn').addEventListener('click', () => { pc.limit = Math.min(500, pc.limit + PC_PAGE); loadPc(); });
    $('ps-close').addEventListener('click', () => $('pc-shot').close());
    $('ps-done').addEventListener('click', () => $('pc-shot').close());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) loadPc(); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        const appeared = visible && !pc.visible;
        pc.visible = visible;
        if (appeared) loadPc();
      }).observe($('pc-panel'));
    } else {
      pc.visible = true;
    }
    loadPc();
  }

  // ---------------------------------------------------------------- confirm dialog
  function confirmDialog(opts) {
    const dlg = $('confirm');
    $('cf-title').textContent = opts.title;
    $('cf-msg').textContent = opts.message;
    $('cf-ok').textContent = opts.confirm || 'Confirm';
    $('cf-ok').className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
    $('cf-cancel').textContent = opts.cancel || 'Cancel';
    $('cf-field').hidden = !opts.input;
    $('cf-label').textContent = opts.input || '';
    $('cf-input').value = '';
    dlg.returnValue = '';
    return new Promise((resolve) => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? { value: $('cf-input').value.trim() } : null), { once: true });
      showDialog(dlg);
      (opts.input ? $('cf-input') : $('cf-cancel')).focus();
    });
  }

  // ---------------------------------------------------------------- toasts, clipboard
  function topDialog() {
    const open = document.querySelectorAll('dialog[open]');
    return open.length ? open[open.length - 1] : null;
  }

  /** Modal dialogs live in the top layer and make the page inert: keep toasts inside the topmost one. */
  function rehomeToasts() {
    const box = $('toasts');
    const host = topDialog() || document.body;
    if (box.parentNode !== host) host.appendChild(box);
  }

  function showDialog(dlg) {
    if (!dlg.open) dlg.showModal();
    rehomeToasts();
  }

  function toast(message, tone) {
    const box = $('toasts');
    rehomeToasts();
    const kind = tone || 'neutral';
    const el = h('div', { class: 'toast tone-' + kind },
      icon(kind === 'ok' ? 'check' : 'alert'),
      h('div', { class: 'toast-msg', text: message }),
      h('button', { type: 'button', class: 'toast-x', 'aria-label': 'Dismiss notification', onclick: () => el.remove() }, icon('x')));
    // Errors stay until dismissed, so a failed action is never missed; the rest fade after 5 s.
    if (kind === 'error') el.setAttribute('role', 'alert');
    box.appendChild(el);
    if (kind !== 'error') setTimeout(() => el.remove(), 5000);
  }

  function showError(e) {
    if (e && e.status === 401) return;
    toast((e && e.message ? e.message : String(e)) + (e && e.hint ? ' ' + e.hint : ''), 'error');
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard.', 'ok');
    } catch (e) {
      toast('Could not copy automatically; select the text and copy it manually.', 'warn');
    }
  }

  // ---------------------------------------------------------------- token lock screen
  function lock() {
    if (state.locked) return;
    state.locked = true;
    stopPolling();
    if (es) { es.close(); es = null; }
    clearTimeout(esRetry);
    for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
    $('app').hidden = true;
    $('locked').hidden = false;
    $('unlock-token').focus();
  }

  $('unlock-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const token = $('unlock-token').value.trim();
    if (!token) { $('unlock-error').textContent = 'Enter the access token.'; return; }
    location.replace('/?token=' + enc(token));
  });

  // ---------------------------------------------------------------- theme
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
    const btn = $('theme-btn');
    btn.replaceChildren(icon(THEME_ICON[theme] || 'auto'));
    const label = 'Color theme: ' + (THEME_LABEL[theme] || 'automatic') + ' (click to change)';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  // ---------------------------------------------------------------- wiring
  function closeOnBackdrop(dlg) {
    dlg.addEventListener('click', (ev) => {
      if (ev.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
      if (!inside) dlg.close();
    });
  }

  function init() {
    for (const el of document.querySelectorAll('[data-icon]')) el.prepend(icon(el.getAttribute('data-icon')));
    let theme = prefs.get('theme', 'auto');
    applyTheme(theme);
    $('theme-btn').addEventListener('click', () => {
      theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
      prefs.set('theme', theme);
      applyTheme(theme);
    });
    $('new-task-btn').addEventListener('click', () => openNewTask());
    $('d-close').addEventListener('click', () => drawer.close());
    $('d-copy').addEventListener('click', () => { if (state.openTaskId) copy(state.openTaskId); });
    $('copy-mcp').addEventListener('click', () => copy(mcpUrl()));
    for (const btn of newTask.querySelectorAll('[data-close]')) btn.addEventListener('click', () => newTask.close());
    for (const dlg of [drawer, newTask, $('confirm'), $('pc-shot')]) {
      closeOnBackdrop(dlg);
      dlg.addEventListener('close', rehomeToasts);
    }

    $('f-status').value = state.filter.status;
    fillAgentOptions();
    $('f-status').addEventListener('change', (ev) => setStatusFilter(ev.target.value));
    $('f-agent').addEventListener('change', (ev) => {
      state.filter.agent = ev.target.value;
      prefs.set('filter.agent', state.filter.agent);
      state.limit = 100;
      scheduleRefresh(0);
    });
    $('task-q').addEventListener('input', (ev) => { state.filter.q = ev.target.value; renderTasks(); });
    $('filters').addEventListener('submit', (ev) => ev.preventDefault());
    $('filters').addEventListener('reset', (ev) => { ev.preventDefault(); clearFilters(); });
    $('agent-q').addEventListener('input', (ev) => { state.agentQuery = ev.target.value; renderAgents(); });
    $('more-btn').addEventListener('click', () => { state.limit = Math.min(500, state.limit + 100); scheduleRefresh(0); });

    document.addEventListener('keydown', (ev) => {
      if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || state.locked) return;
      if (ev.target instanceof Element && ev.target.closest('input, textarea, select, [contenteditable]')) return;
      if (topDialog()) return;
      if (ev.key === 'n' || ev.key === 'N') { ev.preventDefault(); openNewTask(); }
      else if (ev.key === '/') { ev.preventDefault(); $('task-q').focus(); }
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(0); });

    const params = new URLSearchParams(location.search);
    if (params.get('login') === 'failed') {
      $('unlock-error').textContent = 'That token was not accepted. Check it and try again.';
      history.replaceState(null, '', '/');
    }

    setInterval(tickTimes, 15000);
    setConn('connecting');
    refresh();
    initPc();
  }

  init();
})();
`;
function cspHash(text) {
    return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}
/** The complete dashboard document. */
export const DASHBOARD_HTML = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light dark">\n<meta name="referrer" content="no-referrer">\n' +
    '<title>Bruce Comm</title>\n<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n' +
    `<style>${STYLE}</style>\n</head>\n<body>${BODY}<script>${SCRIPT}</script>\n</body>\n</html>\n`;
/**
 * Content-Security-Policy for the dashboard: nothing external, inline blocks allowed only by
 * hash, network access only to this origin, never framed.
 */
export const DASHBOARD_CSP = [
    "default-src 'none'",
    `script-src ${cspHash(SCRIPT)}`,
    `style-src ${cspHash(STYLE)}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');
//# sourceMappingURL=page.js.map