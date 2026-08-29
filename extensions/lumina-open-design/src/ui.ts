export const LUMINA_OPEN_DESIGN_BASE_PATH = "/plugins/lumina-open-design";

export function renderLuminaOpenDesignUi(): string {
  return `<!doctype html>
<html lang="es" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Lumina Diseño</title>
  <style>
    :root{--bg:#f7f8fa;--panel:#fff;--panel2:#eef1f4;--text:#16191f;--muted:#66707c;--line:#dfe3e8;--red:#df343e;--teal:#087f73;--blue:#2866d8;--shadow:0 10px 30px rgba(26,32,44,.08);font-family:Inter,"Segoe UI",Arial,sans-serif;color-scheme:light}
    html[data-theme="dark"]{--bg:#111316;--panel:#191c20;--panel2:#23272d;--text:#f4f5f7;--muted:#a7b0bb;--line:#31363d;--red:#ff5660;--teal:#24c7b1;--blue:#6d9df5;--shadow:0 10px 30px rgba(0,0,0,.24);color-scheme:dark}
    *{box-sizing:border-box}html,body{height:100%;margin:0;background:var(--bg);color:var(--text)}button,input,select,textarea{font:inherit;letter-spacing:0}button{cursor:pointer}.app{height:100%;display:grid;grid-template-rows:58px minmax(0,1fr)}
    .topbar{display:flex;align-items:center;gap:12px;padding:0 18px;border-bottom:1px solid var(--line);background:var(--panel)}
    .brand{display:flex;align-items:center;gap:10px;min-width:210px}.mascot{width:34px;height:34px}.brand strong{font-size:15px}.brand span{display:block;font-size:11px;color:var(--muted);margin-top:2px}
    .status{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:#929aa4}.dot.ok{background:#13a884}.dot.bad{background:var(--red)}
    .top-actions{margin-left:auto;display:flex;align-items:center;gap:8px}.btn{border:1px solid var(--line);background:var(--panel);color:var(--text);height:34px;padding:0 12px;border-radius:6px;font-weight:600;font-size:12px}.btn:hover{border-color:var(--blue);color:var(--blue)}.btn.primary{border-color:var(--red);background:var(--red);color:#fff}.btn.primary:hover{filter:brightness(.94);color:#fff}.btn:disabled{opacity:.5;cursor:not-allowed}
    .workspace{min-height:0;display:grid;grid-template-columns:238px minmax(420px,1fr) minmax(320px,42%)}.sidebar,.preview{min-height:0;background:var(--panel)}.sidebar{border-right:1px solid var(--line);display:flex;flex-direction:column}.preview{border-left:1px solid var(--line);display:grid;grid-template-rows:45px minmax(0,1fr)}
    .section-head{height:45px;display:flex;align-items:center;gap:8px;padding:0 14px;border-bottom:1px solid var(--line);font-size:12px;font-weight:700}.section-head .count{margin-left:auto;color:var(--muted);font-weight:500}.project-list{padding:8px;overflow:auto}.project{width:100%;display:block;text-align:left;border:0;background:transparent;color:var(--text);padding:10px;border-radius:6px}.project:hover{background:var(--panel2)}.project.active{background:color-mix(in srgb,var(--red) 11%,var(--panel));box-shadow:inset 3px 0 var(--red)}.project strong{display:block;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.project small{display:block;margin-top:4px;color:var(--muted);font-size:10px}.empty{padding:20px 12px;color:var(--muted);font-size:12px;text-align:center}
    .main{min-height:0;overflow:auto;padding:clamp(18px,3vw,42px)}.hero{max-width:820px;margin:0 auto}.eyebrow{font-size:11px;text-transform:uppercase;color:var(--teal);font-weight:800}.hero h1{font-size:clamp(26px,3vw,40px);line-height:1.08;margin:10px 0 8px;letter-spacing:0}.hero p{margin:0;color:var(--muted);font-size:14px;line-height:1.55}.policy{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0 24px;padding:11px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)}.policy b{color:var(--text)}
    .composer{display:grid;gap:14px}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{display:grid;gap:6px}.field label{font-size:11px;font-weight:700;color:var(--muted)}.field input,.field select,.field textarea{width:100%;border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:6px;padding:10px 11px;outline:none}.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--blue);box-shadow:0 0 0 3px color-mix(in srgb,var(--blue) 16%,transparent)}.field textarea{min-height:170px;resize:vertical;line-height:1.5}.submit-row{display:flex;align-items:center;gap:10px}.submit-row .hint{color:var(--muted);font-size:11px;margin-left:auto;text-align:right}
    .metrics{margin-top:28px;display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--panel)}.metric{padding:13px;border-right:1px solid var(--line)}.metric:last-child{border-right:0}.metric strong{display:block;font-size:18px}.metric span{font-size:10px;color:var(--muted)}
    .filebar{display:flex;align-items:center;gap:8px;padding:0 10px}.filebar select{min-width:0;flex:1;border:1px solid var(--line);background:var(--panel2);color:var(--text);height:30px;border-radius:5px;padding:0 8px;font-size:11px}.preview-stage{position:relative;min-height:0;background:repeating-conic-gradient(var(--panel2) 0 25%,var(--panel) 0 50%) 50%/18px 18px}.preview-stage iframe{width:100%;height:100%;border:0;background:#fff}.preview-empty{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);font-size:12px;padding:24px;text-align:center}.hidden{display:none!important}.toast{position:fixed;right:18px;bottom:18px;max-width:360px;padding:11px 14px;border-radius:6px;background:#171a1f;color:#fff;box-shadow:var(--shadow);font-size:12px;z-index:10}.toast.error{background:#a9222b}
    @media(max-width:980px){.workspace{grid-template-columns:210px minmax(0,1fr)}.preview{position:fixed;inset:58px 0 0 210px;z-index:4;display:none}.preview.open{display:grid}.preview-toggle{display:inline-block!important}}
    @media(max-width:680px){.brand{min-width:0}.brand span{display:none}.topbar{padding:0 10px}.top-actions .desktop-only{display:none}.workspace{grid-template-columns:1fr}.sidebar{display:none}.main{padding:22px 16px}.row{grid-template-columns:1fr}.preview{inset:58px 0 0}.policy{gap:8px}.metrics{grid-template-columns:1fr}.metric{border-right:0;border-bottom:1px solid var(--line)}.metric:last-child{border-bottom:0}.submit-row{align-items:stretch;flex-direction:column}.submit-row .hint{text-align:left;margin:0}}
    .preview-toggle{display:none}
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <svg class="mascot" viewBox="0 0 64 64" role="img" aria-label="Lumina"><path d="M22 13 14 5M42 13l8-8" fill="none" stroke="#ff575f" stroke-width="5" stroke-linecap="round"/><circle cx="32" cy="34" r="25" fill="#e6323b"/><ellipse cx="10" cy="36" rx="7" ry="10" fill="#e6323b"/><ellipse cx="54" cy="36" rx="7" ry="10" fill="#e6323b"/><circle cx="24" cy="29" r="6" fill="#10151d"/><circle cx="40" cy="29" r="6" fill="#10151d"/><circle cx="24" cy="29" r="2.5" fill="#16d4bd"/><circle cx="40" cy="29" r="2.5" fill="#16d4bd"/><path d="M25 39c2 8 12 8 14 0Z" fill="#10151d"/></svg>
        <div><strong>Lumina Diseño</strong><span>OpenDesign bajo control de Lumina</span></div>
      </div>
      <div class="status"><span id="statusDot" class="dot"></span><span id="statusText">Conectando...</span></div>
      <div class="top-actions">
        <button id="previewToggle" class="btn preview-toggle" type="button">Vista previa</button>
        <button id="themeButton" class="btn" type="button" title="Cambiar tema">Tema</button>
        <button id="studioButton" class="btn desktop-only" type="button">Abrir Studio</button>
      </div>
    </header>
    <div class="workspace">
      <aside class="sidebar">
        <div class="section-head">Proyectos <span id="projectCount" class="count">0</span></div>
        <div id="projectList" class="project-list"></div>
      </aside>
      <main class="main">
        <div class="hero">
          <div class="eyebrow">Workspace visual</div>
          <h1 id="pageTitle">Diseña con Lumina</h1>
          <p id="pageSubtitle">Convierte una idea en un artefacto editable y persistente.</p>
          <div class="policy"><span><b>Modelo</b> OpenClaw actual</span><span><b>Motor</b> OpenDesign local</span><span><b>Delegación</b> desactivada</span></div>
          <form id="designForm" class="composer">
            <div class="row">
              <div class="field"><label for="name">Nombre del proyecto</label><input id="name" maxlength="90" placeholder="Ej. Dashboard de memoria" required></div>
              <div class="field"><label for="kind">Formato</label><select id="kind"><option value="web">Interfaz web</option><option value="dashboard">Dashboard</option><option value="deck">Presentación</option><option value="poster">Póster</option><option value="brand">Sistema de marca</option><option value="video">Video</option></select></div>
            </div>
            <div class="row">
              <div class="field"><label for="designSystem">Sistema de diseño</label><select id="designSystem"><option value="">Selección automática</option></select></div>
              <div class="field"><label for="skill">Skill de diseño</label><select id="skill"><option value="">Selección automática</option></select></div>
            </div>
            <div class="field"><label for="brief">Solicitud</label><textarea id="brief" maxlength="8000" placeholder="Describe el objetivo, audiencia, contenido, estados e interacciones..." required></textarea></div>
            <div class="submit-row"><button id="submitButton" class="btn primary" type="submit">Crear con Lumina</button><button id="newButton" class="btn" type="button">Proyecto nuevo</button><span id="runHint" class="hint">Los archivos aparecerán en la vista previa.</span></div>
          </form>
          <div class="metrics"><div class="metric"><strong id="skillCount">0</strong><span>skills disponibles</span></div><div class="metric"><strong id="systemCount">0</strong><span>sistemas de diseño</span></div><div class="metric"><strong id="pluginCount">0</strong><span>plugins visuales</span></div></div>
        </div>
      </main>
      <section id="previewPanel" class="preview">
        <div class="filebar"><select id="fileSelect" aria-label="Archivo de vista previa"><option value="">Sin artefactos</option></select><button id="closePreview" class="btn preview-toggle" type="button">Cerrar</button></div>
        <div class="preview-stage"><iframe id="previewFrame" class="hidden" title="Vista previa del diseño" sandbox="allow-scripts allow-forms"></iframe><div id="previewEmpty" class="preview-empty">Selecciona un proyecto o crea un diseño.</div></div>
      </section>
    </div>
  </div>
  <div id="toast" class="toast hidden" role="status"></div>
  <script>
    const BASE=${JSON.stringify(LUMINA_OPEN_DESIGN_BASE_PATH)};
    const state={projects:[],selected:null,files:[],poll:null};
    const hostPending=new Map();
    const $=(id)=>document.getElementById(id);
    const toast=(message,error=false)=>{const el=$('toast');el.textContent=message;el.className='toast'+(error?' error':'');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.className='toast hidden',4200)};
    async function api(path,options){const response=await fetch(BASE+path,{headers:{'content-type':'application/json'},...options});const text=await response.text();let body={};try{body=text?JSON.parse(text):{}}catch{body={error:text}}if(!response.ok)throw new Error(body.error||body.message||('Error '+response.status));return body}
    function host(action,payload={}){return new Promise((resolve,reject)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>{hostPending.delete(id);reject(new Error('La accion del Gateway excedio el tiempo de espera.'))},35000);hostPending.set(id,{resolve,reject,timer});parent.postMessage({type:'lumina-open-design:request',id,action,payload},location.origin)})}
    window.addEventListener('message',(event)=>{if(event.source!==parent||event.origin!==location.origin)return;const data=event.data;if(!data||data.type!=='lumina-open-design:response'||typeof data.id!=='string')return;const pending=hostPending.get(data.id);if(!pending)return;clearTimeout(pending.timer);hostPending.delete(data.id);if(data.ok)pending.resolve(data.result);else pending.reject(new Error(data.error||'La accion del Gateway fallo.'))});
    function setStatus(status){$('statusDot').className='dot '+(status.ready?'ok':'bad');$('statusText').textContent=status.ready?('OpenDesign '+(status.version||'activo')):(status.installed?'OpenDesign sin conexión':'OpenDesign no instalado');$('submitButton').disabled=!status.ready}
    async function loadStatus(){try{setStatus(await api('/api/status'))}catch(error){setStatus({ready:false,installed:true});toast(error.message,true)}}
    function appendOptions(select,items,label){const fragment=document.createDocumentFragment();for(const item of items){const option=document.createElement('option');option.value=item.id;option.textContent=String(item[label]||item.name||item.id);fragment.append(option)}select.append(fragment)}
    async function loadCatalog(){try{const data=await api('/api/catalog');$('skillCount').textContent=data.counts.skills;$('systemCount').textContent=data.counts.designSystems;$('pluginCount').textContent=data.counts.plugins;appendOptions($('skill'),data.skills,'name');appendOptions($('designSystem'),data.designSystems,'name')}catch(error){toast(error.message,true)}}
    function projectStatus(project){return project.status&&project.status.value?project.status.value:'listo'}
    function renderProjects(){const root=$('projectList');root.replaceChildren();$('projectCount').textContent=state.projects.length;if(!state.projects.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='Aún no hay proyectos.';root.append(empty);return}for(const project of state.projects){const button=document.createElement('button');button.type='button';button.className='project'+(state.selected===project.id?' active':'');const strong=document.createElement('strong');strong.textContent=project.name;const small=document.createElement('small');small.textContent=projectStatus(project);button.append(strong,small);button.addEventListener('click',()=>selectProject(project.id));root.append(button)}}
    async function loadProjects(selectNewest=false){const data=await api('/api/projects');state.projects=data.projects||[];if(selectNewest&&state.projects.length)state.selected=state.projects.toSorted((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0].id;renderProjects();if(state.selected)await loadProjectFiles()}
    async function selectProject(id){state.selected=id;renderProjects();const project=state.projects.find(item=>item.id===id);$('pageTitle').textContent=project?project.name:'Diseña con Lumina';$('pageSubtitle').textContent='Proyecto persistente en OpenDesign.';$('name').value=project?project.name:'';await loadProjectFiles();$('previewPanel').classList.add('open')}
    function encodedPath(path){return path.split('/').map(encodeURIComponent).join('/')}
    function showPreview(path){const frame=$('previewFrame');if(!state.selected||!path){frame.classList.add('hidden');$('previewEmpty').classList.remove('hidden');return}frame.src=BASE+'/preview/'+encodeURIComponent(state.selected)+'/'+encodedPath(path);frame.classList.remove('hidden');$('previewEmpty').classList.add('hidden')}
    async function loadProjectFiles(){if(!state.selected)return;try{const data=await api('/api/projects/'+encodeURIComponent(state.selected)+'/files');state.files=(data.files||[]).filter(file=>/[.](html?|svg|md)$/i.test(file.path||file.name||''));const select=$('fileSelect');select.replaceChildren();if(!state.files.length){const option=document.createElement('option');option.value='';option.textContent='Esperando artefactos';select.append(option);showPreview('');return}for(const file of state.files){const option=document.createElement('option');option.value=file.path||file.name;option.textContent=file.path||file.name;select.append(option)}const preferred=state.files.find(file=>/index[.]html$/i.test(file.path||file.name||''))||state.files[0];select.value=preferred.path||preferred.name;showPreview(select.value)}catch(error){toast(error.message,true)}}
    function startPolling(){clearInterval(state.poll);let ticks=0;state.poll=setInterval(async()=>{ticks++;await loadProjects();if(ticks>=45)clearInterval(state.poll)},4000)}
    $('designForm').addEventListener('submit',async(event)=>{event.preventDefault();const brief=$('brief').value.trim();const name=$('name').value.trim();if(!brief||!name)return;const button=$('submitButton');button.disabled=true;button.textContent='Iniciando...';try{const result=await host('create',{projectId:state.selected||undefined,name,brief,kind:$('kind').value,designSystem:$('designSystem').value||undefined,skill:$('skill').value||undefined});state.selected=result.projectId;$('runHint').textContent='Lumina está trabajando en '+result.projectId+'.';toast('Solicitud enviada a Lumina.');await loadProjects();startPolling()}catch(error){toast(error.message,true)}finally{button.disabled=false;button.textContent='Crear con Lumina'}});
    $('newButton').addEventListener('click',()=>{state.selected=null;$('name').value='';$('brief').value='';$('pageTitle').textContent='Diseña con Lumina';$('pageSubtitle').textContent='Convierte una idea en un artefacto editable y persistente.';renderProjects();showPreview('')});
    $('fileSelect').addEventListener('change',event=>showPreview(event.target.value));
    $('studioButton').addEventListener('click',async()=>{try{await host('studio');toast('OpenDesign Studio abierto en la PC.')}catch(error){toast(error.message,true)}});
    $('previewToggle').addEventListener('click',()=>$('previewPanel').classList.add('open'));$('closePreview').addEventListener('click',()=>$('previewPanel').classList.remove('open'));
    function readStoredTheme(){try{return localStorage.getItem('lumina-design-theme')||'light'}catch{return 'light'}}
    function writeStoredTheme(theme){try{localStorage.setItem('lumina-design-theme',theme)}catch{}}
    $('themeButton').addEventListener('click',()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;writeStoredTheme(next)});document.documentElement.dataset.theme=readStoredTheme();
    Promise.all([loadStatus(),loadCatalog(),loadProjects()]).catch(error=>toast(error.message,true));setInterval(loadStatus,15000);
  </script>
</body>
</html>`;
}
