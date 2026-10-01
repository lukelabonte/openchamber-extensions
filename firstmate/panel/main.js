(()=>{var s="openchamber.sdk",i=1;var we=`
:root {
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 40%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 65%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [data-oc-scrolling] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [data-oc-scrolling] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [data-oc-scrolling]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [data-oc-scrolling] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;function ct(e){let n=e.documentElement;if(n.hasAttribute("data-oc-scrollbar-activity"))return;n.setAttribute("data-oc-scrollbar-activity","");let E=new WeakMap;e.addEventListener("scroll",(L)=>{let h=L.target===e?n:L.target;if(!(h instanceof Element))return;if(!h.hasAttribute("data-oc-scrolling"))h.setAttribute("data-oc-scrolling","");let w=E.get(h);if(w!==void 0)clearTimeout(w);E.set(h,setTimeout(()=>{E.delete(h),h.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Pt=`(${ct.toString()})(document);`;var Ie=128,ve=65536;var ae=20000000,ce=256;var Ce=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,dt=(e,n)=>{if(e.path!==n.path||e.readOnly!==n.readOnly)return!1;if(e.encoding==="text"||n.encoding==="text")return e.encoding==="text"&&n.encoding==="text"&&e.content===n.content;if(e.bytes.byteLength!==n.bytes.byteLength)return!1;for(let E=0;E<e.bytes.byteLength;E+=1)if(e.bytes[E]!==n.bytes[E])return!1;return!0};var pt=["file","directory","other","missing"],Me=(e)=>Boolean(e&&"sessionId"in e),Ge=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var ut=/^[0-9a-f]{7,64}$/i,Le=(e)=>ut.test(e),de=500,le=32000,Et=16000,ft=128,_t=200,mt=2000,St=16000,Tt=80,xt=200,ht=16000;var At=2000;var Ne=20000,pe=1024,ue=2000000;var Ee=64000,fe=8000,Pe=4000;var De=90000;var bt=999,kt=1e4,te=500,gt=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],yt=["stopped","starting","ready","failed"],Dt=new Set(gt),Ot=(e)=>Dt.has(e),Rt=(e)=>e&&Ot(e)?e:"HOST_REJECTED",K=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(K);if(Object(e)===e)return Object.values(e).every(K);return!1},wt=(e)=>K(e)&&JSON.stringify(e).length<=ht,lt=(e)=>e?.trim().slice(0,xt)??"",j=(e)=>{let n=e.id.trim().slice(0,ft),E=e.title.trim().slice(0,_t),L=e.url.trim().slice(0,mt),h=e.text?.trim().slice(0,St),w=e.author?.trim().slice(0,Tt),N=e.kind==="pull"?"pull":"issue",I={providerId:e.providerId.trim(),id:n,title:E||n,url:L,kind:N};if(h)I.text=h;if(w)I.author=w;if(N==="pull"){let P=lt(e.branches?.head),D=lt(e.branches?.base);if(P&&D)I.branches={head:P,base:D}}if(wt(e.data))I.data=e.data;return I},$e=(e)=>{let n=j(e);if(e.projectId)n.projectId=e.projectId;if(e.navigation)n.navigation=e.navigation;if(e.worktree)n.worktree=e.worktree;return n},Fe=(e)=>{let n={text:e.text.trim().slice(0,Et)};if(e.send)n.send=!0;return n},He=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(bt,Math.max(0,Math.round(e)))},Xe=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(kt,Math.max(0,Math.ceil(e)))};var W=(e)=>e.length>0&&e.length<=pe&&!e.includes("\x00")&&!e.includes("\\");var _e=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>At)return!1;return!e.split("/").some((E)=>E==="."||E==="..")},$t=new Set(yt),Be=(e)=>Boolean(e&&"status"in e&&$t.has(String(e.status))&&!("body"in e)),me=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),ze=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),Ve=(e)=>Boolean(e&&"written"in e&&e.written===!0),Ke=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Ft=new Set(pt),je=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Ft.has(String(e.kind))&&Number.isFinite(e.size)),We=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),Ht=new Set(["workspace","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","file-open","file-snapshot","file-saved"]),Xt=(e)=>Object(e)===e?e:null,Ue=(e)=>String(e)===e&&e.length>0,Bt=(e)=>{if(!Ue(e.id))return null;if(e.ok===!0){let n={channel:s,v:i,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)n.payload=e.payload;return n}if(e.ok===!1&&Ue(e.error))return{channel:s,v:i,type:"result",id:e.id,ok:!1,error:e.error,code:Rt(Ue(e.code)?e.code:void 0)};return null},Je=(e)=>{let n=Xt(e);if(!n||n.channel!==s||n.v!==i)return null;if(n.type==="result")return Bt(n);if(!Ht.has(String(n.type))||Object(n.payload)!==n.payload)return null;return n};var zt=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Vt=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class r extends Error{code;constructor(e,n){super(n);this.name="HostRequestError",this.code=e}}var It=()=>Promise.reject(new r("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),Se=()=>Promise.reject(new r("BAD_PATH",`File path must be 1 to ${pe} characters without NUL or backslash.`)),d=(e)=>(e.value+=1,`oc-${e.value}`),Ye=(e={})=>{let n=e.target??("window"in globalThis?window:null);if(!n)throw new r("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let E=e.acceptSource??((t)=>t===n.parent),L=e.requestTimeoutMs??Ne,h=new Set,w=new Set,N=new Set,I=new Set,P=new Set,D=new Set,Y=new Set,Q=null,Z=null,re=new Set,se=new Set,q=null,ee=null,ge=!1,z=new Map,V=new Map,F=!1,c={value:0},l=null,U=null,rt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},M=(t)=>{n.parent.postMessage(t,"*")},T=(t,o)=>{for(let a of t)try{a(o)}catch(p){console.error(p)}},st=(t)=>{if(!(t instanceof MessageEvent))return;if(!E(t.source))return;let o=Je(t.data);if(!o)return;if(o.type==="workspace"){let p=V.get(o.payload.subscriptionId);if(p)T([p],o.payload.snapshot);return}if(o.type==="ready"){if(l=o.payload,U=rt(o.payload.session),T(h,o.payload),T(w,o.payload.directory),T(N,o.payload.session),U)T(I,U);T(P,o.payload.connection),T(D,o.payload.settings),T(Y,o.payload.item);return}if(o.type==="directory"){if(l)l={...l,directory:o.payload.directory};T(w,o.payload.directory);return}if(o.type==="session"){if(l)l={...l,session:o.payload.session};if(!o.payload.session)U=null;else if(U?.sessionId!==o.payload.session.id)U=rt(o.payload.session);T(N,o.payload.session);return}if(o.type==="session-lifecycle"){U=o.payload,T(I,o.payload);return}if(o.type==="connection"){if(l)l={...l,connection:o.payload.connection};T(P,o.payload.connection);return}if(o.type==="settings"){if(l)l={...l,settings:o.payload.settings};T(D,o.payload.settings);return}if(o.type==="item"){if(l)l={...l,item:o.payload.item};T(Y,o.payload.item);return}if(o.type==="action"){let p=(_)=>{if(!F)M({channel:s,v:i,type:"action-result",id:o.id,payload:_})},x=Z;if(!x){p({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>x(o.payload)).then(()=>p({ok:!0}),(_)=>{let m=(_ instanceof Error?_.message:String(_)).trim();p({ok:!1,error:(m||"Action failed.").slice(0,te)})});return}if(o.type==="file-open"){let p=o.payload;if(ee&&dt(ee,p))return;ee=p,T(re,o.payload);return}if(o.type==="file-saved"){T(se,o.payload.version);return}if(o.type==="file-snapshot"){let p=(m)=>{if(!F)M({channel:s,v:i,type:"file-snapshot-result",id:o.id,payload:m})},x=(m)=>p({error:(m.trim()||"Could not read the edited file.").slice(0,te)}),_=q;if(!_){x("This extension does not edit files.");return}Promise.resolve().then(()=>_(o.payload.purpose)).then((m)=>{if(Ce(m)>ae){x(`The file is over ${ae} ${"bytes"in m?"bytes":"characters"}.`);return}if(m.version.length>ce){x(`The snapshot version is over ${ce} characters.`);return}p({snapshot:"bytes"in m?{bytes:m.bytes,version:m.version}:{content:m.content,version:m.version}})},(m)=>x(m instanceof Error?m.message:String(m)));return}if(o.type==="resolve"){let p=(_)=>{M({channel:s,v:i,type:"resolve-result",id:o.id,payload:_})},x=Q;if(!x){p({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>x(o.payload)).then((_)=>p({item:_?j(_):null}),(_)=>{let m=(_ instanceof Error?_.message:String(_)).trim();p({error:(m||"Command failed.").slice(0,te)})});return}let a=z.get(o.id);if(!a)return;if(clearTimeout(a.timer),z.delete(o.id),o.ok){a.resolve(o.payload);return}a.reject(new r(o.code,o.error))};n.addEventListener("message",st),M({channel:s,v:i,type:"hello"});let y=(t,o=L)=>{if(F||n.parent===n)return Promise.reject(new r("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((a,p)=>{let x=setTimeout(()=>{z.delete(t.id),p(new r("HOST_TIMEOUT","Host did not answer in time."))},o);z.set(t.id,{resolve:a,reject:p,timer:x}),M(t)})},A=(t)=>y(t).then(()=>{return}),C={channel:s,v:i},ye=(t)=>{if(!F&&n.parent!==n)M(t)},it=()=>ye({...C,type:"file-save"}),at=(t)=>{if(!zt(t)||!Vt(t))return;t.preventDefault(),it()},H=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new r("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},Oe=async(t)=>{if(t.kind!=="projects")H(t.projectId);let o=await y({...C,type:"workspace-read",id:d(c),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new r("HOST_REJECTED","Host did not return workspace data.");return o},Re=async(t,o)=>{if(t.kind!=="projects")H(t.projectId);let a=d(c);V.set(a,o);try{await A({...C,type:"workspace-subscribe",id:d(c),payload:{subscriptionId:a,query:t}})}catch(p){if(V.delete(a),!F)M({...C,type:"workspace-unsubscribe",id:d(c),payload:{subscriptionId:a}});throw p}return()=>{if(!V.delete(a)||F)return;M({...C,type:"workspace-unsubscribe",id:d(c),payload:{subscriptionId:a}})}},ie=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Ie))throw new r("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!K(t.value))throw new r("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>ve)throw new r("HOST_REJECTED","Storage value exceeds 64 KiB.");let o=await y({...C,type:"storage",id:d(c),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new r("HOST_REJECTED","Host did not return storage data.");return o};return{onAction:(t)=>(Z=t,()=>{if(Z===t)Z=null}),listProjects:async()=>{let t=await Oe({kind:"projects"});if(t.kind!=="projects")throw new r("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await Oe({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new r("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await Oe({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new r("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Re({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Re({kind:"worktrees",projectId:t},(a)=>{if(a.kind==="worktrees")o(a)}),onSessions:(t,o)=>Re({kind:"sessions",projectId:t},(a)=>{if(a.kind==="sessions")o(a)}),openSession:async(t)=>{H(t),await A({...C,type:"open-session",id:d(c),payload:{sessionId:t}})},storage:{get:async(t)=>{let o=await ie({op:"get",key:t});return o.op==="get"&&o.found?o.value:void 0},set:async(t,o)=>{await ie({op:"set",key:t,value:o})},delete:async(t)=>{await ie({op:"delete",key:t})},keys:async()=>{let t=await ie({op:"keys"});if(t.op!=="keys")throw new r("HOST_REJECTED","Expected storage keys.");return t.keys}},onReady:(t)=>{if(h.add(t),l)t(l);return()=>{h.delete(t)}},onDirectory:(t)=>{if(w.add(t),l)t(l.directory);return()=>{w.delete(t)}},onSession:(t)=>{if(N.add(t),l)t(l.session);return()=>{N.delete(t)}},onSessionLifecycle:(t)=>{if(I.add(t),U)t(U);return()=>{I.delete(t)}},onConnection:(t)=>{if(P.add(t),l)t(l.connection);return()=>{P.delete(t)}},onSettings:(t)=>{if(D.add(t),l)t(l.settings);return()=>{D.delete(t)}},onItem:(t)=>{if(Y.add(t),l)t(l.item);return()=>{Y.delete(t)}},onResolve:(t)=>(Q=t,()=>{if(Q===t)Q=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>de)return Promise.reject(new r("HOST_REJECTED",`Toast message must contain 1 to ${de} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>le))return Promise.reject(new r("HOST_REJECTED",`Toast copy text must contain 1 to ${le} characters.`));return A({channel:s,v:i,type:"toast",id:d(c),payload:{...t,message:o}})},openUrl:(t)=>A({channel:s,v:i,type:"open-url",id:d(c),payload:{url:t}}),openCommit:(t)=>Le(t)?A({channel:s,v:i,type:"open-commit",id:d(c),payload:{sha:t}}):Promise.reject(new r("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>A({channel:s,v:i,type:"open-surface",id:d(c),payload:{surfaceId:t}}),writeClipboard:(t)=>A({channel:s,v:i,type:"clipboard-write",id:d(c),payload:{text:t}}),compose:(t)=>A({channel:s,v:i,type:"compose",id:d(c),payload:t}),attach:(t)=>A({channel:s,v:i,type:"attach",id:d(c),payload:j(t)}),startSession:async(t)=>{if(t.projectId!==void 0)H(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")H(o.directory);else{if(o.name!==void 0)H(o.name,200);if(o.baseBranch!==void 0)H(o.baseBranch,200)}let a=await y({channel:s,v:i,type:"start-session",id:d(c),payload:$e(t)},e.requestTimeoutMs??180000);if(!Me(a))throw new r("HOST_REJECTED","Host did not return a session.");return a},prompt:(t)=>y({channel:s,v:i,type:"prompt",id:d(c),payload:Fe(t)}).then((o)=>{if(!Ge(o))throw new r("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>A({channel:s,v:i,type:"session-link",id:d(c),payload:j(t)}),close:()=>A({channel:s,v:i,type:"close",id:d(c)}),oauthStart:()=>A({channel:s,v:i,type:"oauth-start",id:d(c)}),oauthDisconnect:()=>A({channel:s,v:i,type:"oauth-disconnect",id:d(c)}),request:(t)=>(_e(t.path)?y({channel:s,v:i,type:"request",id:d(c),payload:t}):It()).then((o)=>{if(!me(o))throw new r("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(_e(t.path)?y({channel:s,v:i,type:"service-request",id:d(c),payload:t}):It()).then((o)=>{if(!me(o))throw new r("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>y({channel:s,v:i,type:"service-status",id:d(c)}).then((t)=>{if(!Be(t))throw new r("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(W(t)?y({channel:s,v:i,type:"file-read",id:d(c),payload:{path:t}}):Se()).then((o)=>{if(!ze(o))throw new r("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!W(t))return Se();if(o.length>ue)return Promise.reject(new r("FILE_TOO_LARGE",`Content is over ${ue} characters.`));return y({channel:s,v:i,type:"file-write",id:d(c),payload:{path:t,content:o}}).then((a)=>{if(!Ve(a))throw new r("HOST_REJECTED","Host did not confirm the write.");return a})},listDir:(t)=>(W(t)?y({channel:s,v:i,type:"file-list",id:d(c),payload:{path:t}}):Se()).then((o)=>{if(!Ke(o))throw new r("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(W(t)?y({channel:s,v:i,type:"file-stat",id:d(c),payload:{path:t}}):Se()).then((o)=>{if(!je(o))throw new r("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),a=t.system?.trim();if(o.length===0||o.length>Ee)return Promise.reject(new r("HOST_REJECTED",`Prompt must be 1 to ${Ee} characters.`));if(a!==void 0&&(a.length===0||a.length>fe))return Promise.reject(new r("HOST_REJECTED",`System prompt must be 1 to ${fe} characters.`));let p=t.maxOutputTokens===void 0?void 0:Math.min(Pe,Math.max(1,Math.floor(t.maxOutputTokens)));if(p!==void 0&&!Number.isFinite(p))return Promise.reject(new r("HOST_REJECTED","maxOutputTokens must be a number."));let x={prompt:o};if(a!==void 0)x.system=a;if(p!==void 0)x.maxOutputTokens=p;return y({channel:s,v:i,type:"generate",id:d(c),payload:x},e.requestTimeoutMs??De).then((_)=>{if(!We(_))throw new r("HOST_REJECTED","Host did not return generated text.");return _})},setBadge:(t)=>A({channel:s,v:i,type:"badge",id:d(c),payload:{count:He(t)}}),setHeight:(t)=>A({channel:s,v:i,type:"resize",id:d(c),payload:{height:Xe(t)}}),onFileOpen:(t)=>{if(re.add(t),!ge)ge=!0,n.addEventListener("keydown",at,!0);if(ee)t(ee);return()=>{re.delete(t)}},onFileSnapshot:(t)=>(q=t,()=>{if(q===t)q=null}),onFileSaved:(t)=>(se.add(t),()=>{se.delete(t)}),reportFileChange:(t)=>ye({...C,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:it,reportFileUnsupported:()=>ye({...C,type:"file-unsupported"}),dispose:()=>{for(let t of V.keys())M({...C,type:"workspace-unsubscribe",id:d(c),payload:{subscriptionId:t}});if(V.clear(),F=!0,Q=null,Z=null,q=null,re.clear(),se.clear(),ge)n.removeEventListener("keydown",at,!0);n.removeEventListener("message",st);for(let t of z.values())clearTimeout(t.timer),t.reject(new r("HOST_UNAVAILABLE","Host client was disposed."));z.clear(),h.clear(),w.clear(),N.clear(),I.clear(),P.clear(),D.clear(),Y.clear()}}};var vt=["browser.open","browser.snapshot","browser.click","browser.type","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize"];var So=new Set(vt);var Ct=["none","agent","user"];var xo=new Set(Ct);var Kt=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Ut=(e,n)=>{n.style.colorScheme=e.mode;for(let[E,L]of Kt)n.style.setProperty(E,e.tokens[L]);n.style.setProperty("font-family",e.tokens.font),n.style.setProperty("font-size","0.875rem"),n.style.setProperty("line-height","1.45"),n.style.setProperty("color",e.tokens.foreground)},Qe=(e,n)=>{if(Ut(e.theme,n),n.dataset)n.dataset.ocSurface=e.surface,n.dataset.ocTheme=e.theme.mode};var jt={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},u=(e,n)=>`var(--${e}, var(--oc-${jt[e]}, ${n}))`,X=u("surface-background","transparent"),Te=u("surface-elevated","transparent"),oe=u("surface-elevated-foreground","inherit"),ne=u("surface-foreground","inherit"),f=u("surface-muted-foreground","gray"),Wt=u("surface-muted","transparent"),R=u("interactive-border","currentColor"),O=u("interactive-hover","transparent"),B=u("interactive-active","transparent"),Ze=u("interactive-selection","transparent"),qe=u("interactive-selection-foreground","inherit"),Lt=u("interactive-focus-ring","currentColor"),v=u("primary","currentColor"),et=u("primary-text","inherit"),tt=u("error-text","inherit"),Jt=u("font-sans","inherit"),ot=u("font-mono","monospace"),Mt=u("radius","9px"),S=(e,n,E="transparent")=>`color-mix(in srgb, ${e} ${n}%, ${E})`,Gt=`box-shadow: 0 0 0 2px ${Lt};`,xe=(e)=>{let n=u(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${n}; --oc-sdk-tone-text: ${u(`${e}-text`,"inherit")}; }`},b=`
${we}
.oc-sdk { box-sizing: border-box; color: ${ne}; font-family: ${Jt}; font-size: 0.875rem; line-height: 1.45; }
.oc-sdk *, .oc-sdk *::before, .oc-sdk *::after { box-sizing: border-box; }
/* :where() keeps the reset at zero specificity so every primitive class below overrides it. */
:where(.oc-sdk) :where(button, input, textarea), :where(button.oc-sdk, input.oc-sdk, textarea.oc-sdk) { font: inherit; color: inherit; margin: 0; }
:where(.oc-sdk) :where(button), :where(button.oc-sdk) { cursor: pointer; background: none; border: 0; padding: 0; }
.oc-sdk button:disabled, button.oc-sdk:disabled, .oc-sdk[aria-disabled="true"], .oc-sdk [aria-disabled="true"] { opacity: .5; pointer-events: none; }
.oc-sdk :focus-visible { outline: none; ${Gt} }
.oc-sdk-mono { font-family: ${ot}; }
.oc-sdk-muted { color: ${f}; }
${xe("success")}${xe("warning")}${xe("error")}${xe("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${v}; --oc-sdk-tone-text: ${et}; }

.oc-sdk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 36px; padding: 0 14px; border: 1px solid transparent; border-radius: ${Mt}; font-size: 0.875rem; font-weight: 500; line-height: 1; white-space: nowrap; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="sm"] { height: 32px; padding: 0 10px; font-size: 0.8125rem; }
.oc-sdk-btn[data-size="xs"] { height: 24px; padding: 0 8px; font-size: 0.75rem; border-radius: 6px; }
.oc-sdk-btn[data-variant="default"] { color: ${et}; background: ${S(v,10,X)}; border-color: ${S(v,12)}; }
.oc-sdk-btn[data-variant="default"]:hover { background: ${S(v,16,X)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${S(v,22,X)}; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Wt}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${O}, ${O}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${B}, ${B}); }
.oc-sdk-btn[data-variant="outline"] { background: ${Te}; color: ${oe}; border-color: ${R}; }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${O}, ${O}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${B}, ${B}); }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${O}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${B}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${u("status-error","red")}; color: ${tt}; background: ${S("var(--oc-sdk-tone)",7,X)}; border-color: ${S("var(--oc-sdk-tone)",12)}; }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${S("var(--oc-sdk-tone)",9,X)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${S("var(--oc-sdk-tone)",11,X)}; }
.oc-sdk-btn[data-loading="true"] { opacity: .5; pointer-events: none; }
.oc-sdk-btn > .oc-sdk-spinner-ring { width: 14px; height: 14px; }

.oc-sdk-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-field-label { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-field-note { font-size: 0.75rem; color: ${f}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${tt}; }
.oc-sdk-input { display: block; width: 100%; min-width: 0; height: 36px; padding: 0 12px; border: 0; border-radius: ${Mt}; background: ${Te}; color: ${oe}; font-size: 0.875rem; line-height: 1.45; appearance: none; box-shadow: inset 0 0 0 1px ${S(R,60)}; transition: background 150ms ease-out, box-shadow 150ms ease-out; }
textarea.oc-sdk-input { height: auto; padding: 8px 12px; resize: vertical; }
.oc-sdk-input::placeholder { color: ${f}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${O}, ${O}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { box-shadow: inset 0 0 0 2px ${Lt}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input { box-shadow: inset 0 0 0 1px ${u("status-error","red")}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { box-shadow: inset 0 0 0 2px ${u("status-error","red")}; }
.oc-sdk-input[data-mono="true"] { font-family: ${ot}; }

.oc-sdk-search { position: relative; min-width: 0; }
.oc-sdk-search .oc-sdk-input { padding-left: 34px; padding-right: 34px; }
.oc-sdk-search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: ${f}; pointer-events: none; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${v}; }
.oc-sdk-search-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: none; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; color: ${f}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-clear { display: inline-flex; }
.oc-sdk-search-clear:hover { background: ${O}; color: ${ne}; }

.oc-sdk-select { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 32px; padding: 0 8px 0 10px; border: 1px solid ${R}; border-radius: 6px; background: ${Te}; color: ${oe}; font-size: 0.8125rem; text-align: left; transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${O}, ${O}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${B}, ${B}); }
.oc-sdk-trigger-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-trigger-value[data-empty="true"] { color: ${f}; }
.oc-sdk-trigger-chevron { flex: 0 0 auto; color: ${f}; }
.oc-sdk-popup { --surface-foreground: ${oe}; position: fixed; z-index: 50; display: flex; flex-direction: column; gap: 2px; min-width: 160px; max-width: calc(100vw - 16px); max-height: min(320px, calc(100vh - 16px)); overflow: auto; padding: 4px; border: 1px solid ${S(R,60)}; border-radius: 12px; background: ${Te}; color: ${oe}; box-shadow: 0 8px 24px ${S(ne,12)}; }
.oc-sdk-popup-search { flex: 0 0 auto; padding: 2px 2px 4px; }
.oc-sdk-popup-search .oc-sdk-input { height: 32px; font-size: 0.8125rem; }
.oc-sdk-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border-radius: 8px; font-size: 0.8125rem; text-align: left; }
.oc-sdk-option[data-active="true"] { background: ${O}; }
.oc-sdk-option[aria-selected="true"] { background: ${Ze}; color: ${qe}; }
.oc-sdk-option[data-destructive="true"] { color: ${tt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${S(u("status-error","red"),10)}; }
.oc-sdk-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-option-hint { flex: 0 0 auto; font-size: 0.75rem; color: ${f}; }
.oc-sdk-option-check { flex: 0 0 auto; width: 12px; }
.oc-sdk-popup-empty { padding: 8px; font-size: 0.8125rem; color: ${f}; }

.oc-sdk-check { display: inline-flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; }
.oc-sdk-check-box { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-top: 3px; border: 1px solid ${R}; border-radius: 4px; color: ${v}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${S(v,65,R)}; }
.oc-sdk-check-box > svg { display: none; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box > svg { display: block; }
.oc-sdk-check-thumb { flex: 0 0 auto; position: relative; width: 36px; height: 20px; border-radius: 9999px; background: ${R}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 9999px; background: ${X}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${v}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${Gt} }
.oc-sdk-check-text { display: flex; flex-direction: column; min-width: 0; }
.oc-sdk-check-label { font-size: 0.875rem; }
.oc-sdk-check-desc { font-size: 0.75rem; color: ${f}; }

.oc-sdk-tabs { display: inline-flex; gap: 2px; padding: 2px; border-radius: 10px; max-width: 100%; overflow: auto; }
.oc-sdk-tabs[data-track="true"] { background: ${S(ne,4)}; }
.oc-sdk-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid transparent; border-radius: 8px; font-size: 0.8125rem; font-weight: 500; color: ${f}; white-space: nowrap; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${ne}; }
.oc-sdk-tab[aria-selected="true"] { color: ${qe}; background: ${Ze}; border-color: ${R}; }
.oc-sdk-tab-count { font-size: 0.75rem; font-variant-numeric: tabular-nums; color: ${f}; }

.oc-sdk-badge { display: inline-flex; align-items: center; padding: 1px 6px; border-radius: 9999px; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; background: ${O}; color: ${f}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${S("var(--oc-sdk-tone)",15)}; }

.oc-sdk-list { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.oc-sdk-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border-radius: 6px; text-align: left; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${O}; }
.oc-sdk-row[aria-selected="true"] { background: ${Ze}; color: ${qe}; }
.oc-sdk-row-lead { flex: 0 0 auto; width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ${ot}; font-size: 0.75rem; color: ${f}; }
.oc-sdk-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.oc-sdk-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; color: ${f}; }
.oc-sdk-row-meta { flex: 0 0 auto; font-size: 0.75rem; font-variant-numeric: tabular-nums; color: ${f}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { padding: 16px 8px; text-align: center; font-size: 0.8125rem; color: ${f}; }

.oc-sdk-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 40px 16px; text-align: center; }
.oc-sdk-empty-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
.oc-sdk-empty-body { margin: 0; max-width: 32rem; font-size: 0.8125rem; color: ${f}; }
.oc-sdk-empty-action { margin-top: 12px; }

@keyframes oc-sdk-spin { to { transform: rotate(360deg); } }
.oc-sdk-spinner { display: inline-flex; align-items: center; gap: 8px; font-size: 0.8125rem; color: ${f}; }
.oc-sdk-spinner-ring { width: 16px; height: 16px; border: 2px solid ${R}; border-top-color: ${v}; border-radius: 9999px; animation: oc-sdk-spin .8s linear infinite; }
.oc-sdk-spinner[data-size="sm"] .oc-sdk-spinner-ring { width: 12px; height: 12px; }

.oc-sdk-banner { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; border: 1px solid ${S("var(--oc-sdk-tone)",40)}; border-radius: 8px; background: ${S("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.oc-sdk-banner-title { font-size: 0.8125rem; font-weight: 500; color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { font-size: 0.8125rem; color: ${f}; }
.oc-sdk-banner-action { flex: 0 0 auto; }

.oc-sdk-separator { display: flex; align-items: center; gap: 8px; width: 100%; margin: 8px 0; font-size: 0.75rem; color: ${f}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { content: ""; flex: 1 1 auto; height: 1px; background: ${S(R,40)}; }
.oc-sdk-separator[data-labeled="false"]::after { display: none; }
.oc-sdk-popup > .oc-sdk-separator { margin: 4px 0; }

.oc-sdk-progress { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-progress-label { display: flex; justify-content: space-between; font-size: 0.75rem; color: ${f}; font-variant-numeric: tabular-nums; }
.oc-sdk-progress-track { height: 6px; border-radius: 9999px; background: ${R}; overflow: hidden; }
.oc-sdk-progress-fill { height: 100%; border-radius: 9999px; background: var(--oc-sdk-tone, ${v}); transform-origin: left; transition: transform 200ms ease-out; }

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text a { color: ${et}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { display: block; max-width: 100%; margin: 8px 0; border-radius: 8px; border: 1px solid ${S(R,60)}; }
`;var eo=Ye();eo.onReady((e)=>{Qe(e,document.documentElement),to()});function to(){let e=document.getElementById("firstmate-root");if(!e)return;e.replaceChildren();let n=document.createElement("h1");n.textContent="FirstMate";let E=document.createElement("p");E.textContent="The board is empty.",e.append(n,E)}})();
