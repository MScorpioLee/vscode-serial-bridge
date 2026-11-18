'use strict';

const { randomBytes } = require('node:crypto');

function html(webview, extensionUri) {
  const nonce = randomBytes(18).toString('base64');
  return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>串口映射</title>
<style nonce="${nonce}">
:root { color-scheme: light; }
body.vscode-dark,body.vscode-high-contrast { color-scheme:dark; }
body.vscode-light,body.vscode-high-contrast-light { color-scheme:light; }
* { box-sizing: border-box; }
body { margin:0; padding:24px; color:var(--vscode-foreground); background:var(--vscode-editor-background); font:13px/1.5 var(--vscode-font-family, system-ui, sans-serif); }
button,input,select,textarea { font:inherit; }
button { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:30px; padding:5px 12px; border:1px solid var(--vscode-button-border, transparent); border-radius:5px; color:var(--vscode-button-secondaryForeground); background:var(--vscode-button-secondaryBackground); cursor:pointer; white-space:nowrap; }
button:hover:not(:disabled) { background:var(--vscode-button-secondaryHoverBackground); }
button.primary { color:var(--vscode-button-foreground); background:var(--vscode-button-background); }
button.primary:hover:not(:disabled) { background:var(--vscode-button-hoverBackground); }
button:disabled { opacity:.5; cursor:default; }
:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:2px; }
input,select,textarea { width:100%; min-width:0; padding:7px 9px; border:1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius:5px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); }
input::placeholder,textarea::placeholder { color:var(--vscode-input-placeholderForeground); }
input:disabled,select:disabled { opacity:.6; }
textarea { min-height:74px; resize:vertical; font-family:var(--vscode-editor-font-family, monospace); font-size:12px; line-height:1.6; }
fieldset { border:0; margin:0; padding:0; min-width:0; }
label { display:block; font-size:12px; color:var(--vscode-descriptionForeground); }
label input,label select { margin-top:5px; }
svg { width:16px; height:16px; flex-shrink:0; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
main { max-width:1100px; margin:0 auto; }
.top { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px; }
.brand { display:flex; align-items:center; gap:12px; }
.brand-icon { width:38px; height:38px; display:grid; place-items:center; border-radius:10px; color:var(--vscode-textLink-foreground); background:var(--vscode-textBlockQuote-background, var(--vscode-editorWidget-background)); border:1px solid var(--vscode-widget-border, transparent); }
.brand-icon svg { width:23px; height:23px; }
h1 { margin:0; font-size:21px; font-weight:600; letter-spacing:-.3px; }
.sub { margin:3px 0 0; color:var(--vscode-descriptionForeground); font-size:12px; }
.badge { display:inline-flex; align-items:center; gap:7px; border:1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius:99px; padding:5px 11px; background:var(--vscode-editorWidget-background); font-size:12px; white-space:nowrap; }
.dot { width:7px; height:7px; border-radius:50%; background:var(--vscode-descriptionForeground); }
.badge[data-phase="connected"] .dot { background:var(--vscode-testing-iconPassed, #388a34); }
.badge[data-phase="starting"] .dot { background:var(--vscode-editorWarning-foreground, #9d7200); }
.badge[data-phase="error"] .dot { background:var(--vscode-errorForeground); }
.route { display:grid; grid-template-columns:minmax(0,1fr) 30px minmax(0,1fr); align-items:stretch; gap:10px; }
.panel { border:1px solid var(--vscode-panel-border); border-radius:9px; background:var(--vscode-editor-background); overflow:hidden; }
.card { padding:17px; }
.card-head { display:flex; align-items:center; gap:8px; margin-bottom:16px; }
.card-head h2,.section-title { font-size:13px; font-weight:600; margin:0; }
.kicker { font:10px var(--vscode-editor-font-family, monospace); color:var(--vscode-descriptionForeground); margin-left:auto; letter-spacing:.7px; }
.pair { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:12px; margin-top:12px; }
.route-arrow { display:flex; align-items:center; justify-content:center; color:var(--vscode-textLink-foreground); }
.route-arrow svg { width:25px; height:25px; }
.device-line { display:flex; gap:7px; align-items:end; }
.device-line label { flex:1; min-width:0; }
.icon-button { width:32px; min-width:32px; height:34px; padding:5px; }
.hint { margin:9px 0 0; color:var(--vscode-descriptionForeground); font-size:11px; }
.advanced { margin-top:14px; padding:0 16px; }
summary { cursor:pointer; color:var(--vscode-descriptionForeground); font-size:12px; padding:12px 0; user-select:none; }
.advanced-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; margin-bottom:14px; }
.raw { display:grid; grid-template-columns:90px minmax(0,1fr); gap:7px 12px; padding:12px 0 15px; margin:0; border-top:1px solid var(--vscode-panel-border); font-size:11px; }
.raw dt { color:var(--vscode-descriptionForeground); }
.raw dd { margin:0; overflow-wrap:anywhere; font-family:var(--vscode-editor-font-family,monospace); user-select:text; }
.connect-row { display:flex; align-items:center; justify-content:space-between; gap:14px; margin:16px 0 20px; }
.message { margin:0; font-size:12px; color:var(--vscode-descriptionForeground); overflow-wrap:anywhere; }
.message.error { color:var(--vscode-errorForeground); }
.actions { display:flex; gap:8px; flex-shrink:0; }
.log-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px; padding:12px 15px; border-bottom:1px solid var(--vscode-panel-border); background:var(--vscode-editorWidget-background); }
.log-heading { display:flex; align-items:center; gap:8px; }
.counters { display:flex; gap:16px; font:11px var(--vscode-editor-font-family,monospace); font-variant-numeric:tabular-nums; }
.counters span { color:var(--vscode-descriptionForeground); margin-right:4px; }
.log-body { position:relative; }
pre { margin:0; padding:14px 15px; min-height:220px; height:clamp(220px,33vh,430px); overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.65 var(--vscode-editor-font-family,monospace); tab-size:4; user-select:text; }
.empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; flex-direction:column; pointer-events:none; gap:7px; color:var(--vscode-descriptionForeground); font-size:12px; padding:24px; text-align:center; }
.empty svg { width:30px; height:30px; margin-bottom:5px; }
.empty strong { font-weight:500; }
.empty small { font-size:11px; }
.log-footer { display:flex; gap:12px; justify-content:space-between; align-items:center; flex-wrap:wrap; border-top:1px solid var(--vscode-panel-border); padding:9px 14px; }
.log-footer .actions button { min-height:26px; padding:3px 8px; font-size:11px; }
.check { display:inline-flex; align-items:center; gap:6px; cursor:pointer; color:var(--vscode-descriptionForeground); font-size:11px; }
.check input { width:auto; margin:0; accent-color:var(--vscode-focusBorder); }
.send { margin-top:15px; padding:15px; }
.send-head { display:flex; gap:12px; align-items:center; justify-content:space-between; margin-bottom:10px; }
.send-options { display:flex; align-items:center; gap:10px; }
.send-options label { display:flex; align-items:center; gap:6px; font-size:11px; }
.send-options select { width:82px; margin:0; padding:4px 7px; font-size:11px; }
.send-bottom { display:flex; gap:12px; align-items:center; justify-content:space-between; margin-top:10px; }
.send-bottom .hint { margin:0; }
kbd { font:10px var(--vscode-font-family,system-ui); border:1px solid var(--vscode-widget-border,var(--vscode-panel-border)); border-radius:3px; padding:1px 4px; }
.footnote { margin:13px 0 0; font-size:10px; color:var(--vscode-descriptionForeground); }
.channel-bar { display:flex; align-items:end; gap:8px; padding:13px 15px; margin-bottom:16px; background:var(--vscode-editorWidget-background); }
.channel-bar label { flex:1; min-width:140px; }
.channel-count { white-space:nowrap; font-size:11px; color:var(--vscode-descriptionForeground); padding-bottom:8px; }
.mode-row { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
.mode-row label { display:flex; align-items:center; gap:10px; }
.mode-row select { margin:0; width:160px; }
#probeRemote label { margin-top:12px; }
.probe-note { margin:12px 0 0; color:var(--vscode-textLink-foreground); font-size:12px; }
@media(max-width:560px) { .channel-bar { flex-wrap:wrap; } .channel-bar label { flex-basis:100%; } .channel-count { margin-right:auto; } .mode-row { align-items:start; } }
[hidden] { display:none!important; }
@media(max-width:700px) { body { padding:17px; } .card { padding:14px; } .route { gap:5px; grid-template-columns:minmax(0,1fr) 22px minmax(0,1fr); } .pair { grid-template-columns:1fr; gap:10px; } .kicker { display:none; } }
@media(max-width:560px) { body { padding:14px; } .top { align-items:flex-start; margin-bottom:16px; } h1 { font-size:18px; } .sub { font-size:11px; } .brand-icon { display:none; } .badge { font-size:11px; padding:4px 8px; } .route { grid-template-columns:1fr; gap:10px; } .route-arrow { display:none; } .pair { grid-template-columns:1fr 1fr; } .advanced-grid { grid-template-columns:1fr 1fr; } .connect-row { flex-wrap:wrap; } .connect-row .actions { width:100%; } .connect-row button { flex:1; } .send-head { align-items:flex-start; flex-wrap:wrap; } .send-options { margin-left:auto; } .send-bottom .hint { font-size:10px; } .log-footer .actions { flex-wrap:wrap; } .raw { grid-template-columns:70px minmax(0,1fr); } pre { min-height:200px; } }
</style>
</head>
<body>
<main>
  <header class="top">
    <div class="brand"><div class="brand-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v4"/><path d="m9 11 2 2 4-3"/></svg></div><div><h1>设备通道</h1><p class="sub">独立绑定设备，连接远端工作区</p></div></div>
    <div class="badge" id="badge" data-phase="idle"><span class="dot" aria-hidden="true"></span><span id="phase">未连接</span></div>
  </header>

  <nav class="panel channel-bar" aria-label="映射通道管理"><label>当前通道<select id="mapping" aria-label="选择映射通道"><option value="">正在读取通道…</option></select></label><span class="channel-count" id="activeCount">0 个通道运行中</span><button type="button" id="add">新增通道</button><button type="button" id="remove" disabled>删除</button></nav>

  <form id="configuration">
    <fieldset id="configFields">
      <div class="mode-row"><label>通道类型<select id="kind"><option value="serial">串口映射</option><option value="probe">CMSIS-DAP 探针</option></select></label><button type="button" id="refreshAll">刷新设备</button></div>
      <div class="route">
        <section class="panel card" aria-labelledby="localTitle">
          <div class="card-head"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8m-4-4v4"/></svg><h2 id="localTitle">本机串口</h2><span class="kicker">LOCAL</span></div>
          <fieldset id="serialLocal"><div class="device-line"><label>USB 串口设备<select id="device" required aria-label="本机 USB 串口设备"><option value="">正在查找设备…</option></select></label><button type="button" id="refresh" class="icon-button" title="刷新串口设备" aria-label="刷新串口设备"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/></svg></button></div>
          <div class="pair"><label>波特率<input id="baud" type="number" min="50" max="4000000" step="1" value="115200" list="baudRates" required inputmode="numeric"></label><label>当前参数<input id="serialSummary" value="8N1 · 无流控" readonly tabindex="-1" aria-label="当前串口参数摘要"></label></div>
          <datalist id="baudRates"><option value="9600"><option value="19200"><option value="38400"><option value="57600"><option value="115200"><option value="230400"><option value="460800"><option value="921600"></datalist>
          <p class="hint">每个串口设备分别绑定；DAPLink 的 CDC 接口仅用于串口。</p></fieldset>
          <fieldset id="probeLocal" hidden disabled><label>CMSIS-DAP 探针<select id="probeUID" required aria-label="CMSIS-DAP 探针唯一标识"><option value="">正在查找探针…</option></select></label><p class="probe-note">仅建立远程探针通道，烧录/调试由远端工具操作</p><p class="hint">此处不连接目标 MCU，不执行复位、暂停或烧录。</p></fieldset>
        </section>
        <div class="route-arrow" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 8h17m-4-4 4 4-4 4M21 16H4m4-4-4 4 4 4"/></svg></div>
        <section class="panel card" aria-labelledby="remoteTitle">
          <div class="card-head"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5m-5 11h5"/></svg><h2 id="remoteTitle">远端虚拟串口</h2><span class="kicker">SSH</span></div>
          <label>SSH 主机<select id="host" required><option value="">选择 SSH 主机</option></select></label>
          <fieldset id="serialRemote"><div class="pair"><label>虚拟端口名称<input id="name" value="ttyBoard" required pattern="[A-Za-z][A-Za-z0-9_-]{0,39}" maxlength="40" spellcheck="false" title="以字母开头，使用字母、数字、下划线或短横线，最多 40 个字符"></label><label>连接方式<input value="SSH 加密通道" readonly tabindex="-1" aria-label="连接方式 SSH 加密通道"></label></div><p class="hint">连接后，远端程序可通过虚拟端口双向收发。</p></fieldset>
          <fieldset id="probeRemote" hidden disabled><label>远端回环端口<input id="probePort" type="number" min="1024" max="65535" step="1" value="5555" required inputmode="numeric"></label><p class="hint">SSH 反向通道 · 仅监听远端 127.0.0.1</p></fieldset>
        </section>
      </div>
      <details class="panel advanced"><summary>高级串口参数与路径详情</summary>
        <fieldset id="serialAdvanced"><div class="advanced-grid">
          <label>数据位<select id="dataBits"><option value="8">8</option><option value="7">7</option><option value="6">6</option><option value="5">5</option></select></label>
          <label>停止位<select id="stopBits"><option value="1">1</option><option value="2">2</option></select></label>
          <label>校验位<select id="parity"><option value="none">无校验</option><option value="even">偶校验</option><option value="odd">奇校验</option></select></label>
          <label>流控制<select id="flowControl"><option value="none">无流控</option><option value="hardware">硬件流控</option><option value="software">软件流控</option></select></label>
        </div></fieldset>
        <dl class="raw"><dt id="localPathLabel">本机路径</dt><dd id="localPath">尚未选择设备</dd><dt>远端端点</dt><dd id="remotePort">连接后生成</dd><dt>NAS 日志</dt><dd id="remoteLog">连接后生成</dd><dt>状态文件</dt><dd id="remoteStatus">连接后生成</dd></dl>
      </details>
    </fieldset>
    <div class="connect-row"><p class="message" id="message" role="status" aria-live="polite">选择本机设备，启动到 NAS 的串口映射。</p><div class="actions"><button type="button" id="stop" disabled>停止映射</button><button type="submit" class="primary" id="start" disabled>绑定并启动</button></div></div>
  </form>

  <section class="panel" aria-labelledby="logTitle">
    <div class="log-header"><div class="log-heading"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m5 7 5 5-5 5m8 0h6"/></svg><h2 class="section-title" id="logTitle">实时收发日志</h2></div><div class="counters" id="counters"><div><span>RX ↓</span><strong id="rx">0 B</strong></div><div><span>TX ↑</span><strong id="tx">0 B</strong></div></div></div>
    <div class="log-body"><pre id="log" tabindex="0" aria-label="当前通道日志"></pre><div class="empty" id="empty"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12h4l3-7 5 14 3-7h5"/></svg><strong id="emptyTitle">等待串口数据</strong><small id="emptyHint">启动映射后，接收数据与发送记录会显示在这里</small></div></div>
    <div class="log-footer"><label class="check"><input type="checkbox" id="autoScroll" checked>自动滚动</label><div class="actions"><button type="button" id="clear">清空显示</button><button type="button" id="copyPort" disabled>复制远端端口</button><button type="button" id="openLog" disabled>打开 NAS 日志</button></div></div>
  </section>

  <section class="panel send" id="sender" aria-labelledby="sendTitle">
    <div class="send-head"><h2 class="section-title" id="sendTitle">发送到设备</h2><div class="send-options"><label>格式<select id="sendMode"><option value="text">文本</option><option value="hex">HEX</option></select></label><label>换行<select id="newline"><option value="none">不追加</option><option value="lf">LF</option><option value="cr">CR</option><option value="crlf">CRLF</option></select></label></div></div>
    <textarea id="sendText" aria-label="发送内容" placeholder="输入要发送的内容…" spellcheck="false"></textarea>
    <div class="send-bottom"><p class="hint" id="sendHint">UTF-8 文本 · <kbd>⌘ / Ctrl</kbd> + <kbd>Enter</kbd> 发送</p><button type="button" class="primary" id="send" disabled>发送数据</button></div>
  </section>
  <p class="footnote">各通道独立运行，需要手动启动；停止后不会自动重连。RX 为设备返回，TX 为写入设备。</p>
</main>
<script nonce="${nonce}">
(() => {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const defaults = {kind:'serial',device:'',host:'',name:'ttyBoard',baud:115200,dataBits:8,stopBits:1,parity:'none',flowControl:'none',probeUID:'',remotePort:5555};
  const keys = Object.keys(defaults);
  const elementID = key => key === 'remotePort' ? 'probePort' : key;
  const saved = vscode.getState() || {};
  const channels = new Map();
  let mappings = [], devices = [], hosts = [], probes = [];
  let selectedId = null;
  const limit = 200000;
  let logPaintPending = false;
  const logNode = document.createTextNode('');
  $('log').appendChild(logNode);
  const phases = {idle:'未连接',starting:'正在连接',connected:'已连接',stopping:'正在停止',error:'连接异常'};

  function active(item) { return item && (item.cleanupPending || ['starting','connected','stopping'].includes(item.phase)); }
  function current() { return selectedId ? channels.get(selectedId) : null; }
  function createChannel(item) {
    const previous = saved.channels && saved.channels[item.id];
    return { id:item.id, form:Object.assign({},defaults,item.config || {},previous && previous.form || {}), edited:Boolean(previous && previous.edited), send:Object.assign({text:'',hex:false,newline:'none'},previous && previous.send || {}), autoScroll:!previous || previous.autoScroll !== false, log:'', scroll:0, decoder:{rx:new TextDecoder('utf-8'),tx:new TextDecoder('utf-8')}, pending:false, stopRequested:false, snapshot:item };
  }
  function post(command, extra) {
    const outgoing = Object.assign({command:command,mappingId:selectedId},extra || {});
    const target = channels.get(outgoing.mappingId);
    outgoing.session = target && target.snapshot.session;
    vscode.postMessage(outgoing);
  }
  function captureSender() {
    const c = current();
    if (!c) return;
    c.send = {text:$('sendText').value,hex:$('sendMode').value === 'hex',newline:$('newline').value};
    c.autoScroll = $('autoScroll').checked;
    c.scroll = $('log').scrollTop;
  }
  function save() {
    const stored = {};
    channels.forEach((c,id) => { stored[id] = {form:c.form,edited:c.edited,send:c.send,autoScroll:c.autoScroll}; });
    vscode.setState({selectedId:selectedId,channels:stored});
  }
  function addOption(select,value,label) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; select.appendChild(option);
  }
  function options(id,values,value,empty,missing) {
    const select = $(id); select.replaceChildren();
    addOption(select,'',empty);
    values.forEach(item => addOption(select,item.value,item.label));
    if (value && !values.some(item => item.value === value)) addOption(select,value,missing);
    select.value = value || '';
  }
  function mappingOptions() {
    $('mapping').replaceChildren();
    mappings.forEach((item,index) => {
      const c = item.config || {};
      const label = c.kind === 'probe' ? 'CMSIS-DAP · ' + (c.remotePort || 5555) : (c.name || '通道 ' + (index + 1));
      addOption($('mapping'),item.id,label + ' · ' + (c.host || '未选择 SSH 主机') + ' · ' + (phases[item.phase] || '未连接'));
    });
    $('mapping').value = selectedId || '';
    $('activeCount').textContent = mappings.filter(active).length + ' / ' + mappings.length + ' 个通道运行中';
    $('add').disabled = mappings.length >= 8;
  }
  function updateSummary(c) {
    const f = c.form;
    const parity = {none:'N',even:'E',odd:'O'}[f.parity] || 'N';
    const flow = {none:'无流控',hardware:'硬件流控',software:'软件流控'}[f.flowControl] || '无流控';
    $('serialSummary').value = String(f.dataBits) + parity + f.stopBits + ' · ' + flow;
    $('localPathLabel').textContent = f.kind === 'probe' ? '探针 UID' : '本机路径';
    $('localPath').textContent = (f.kind === 'probe' ? f.probeUID : f.device) || '尚未选择设备';
  }
  function paintForm(c,force) {
    keys.filter(key => !['device','host','probeUID'].includes(key)).forEach(key => {
      const field = $(elementID(key));
      if (force || !document.activeElement || document.activeElement.id !== field.id) field.value = String(c.form[key]);
    });
    options('device',devices.map((item,index) => ({value:item.device,label:item.label || ('USB 串口 ' + (index + 1))})),c.form.device,devices.length ? '选择 USB 串口设备' : '未发现 USB 串口设备','原设备未连接，请重新选择');
    options('probeUID',probes.map((item,index) => ({value:item.uid,label:item.label || ('CMSIS-DAP 探针 ' + (index + 1))})),c.form.probeUID,probes.length ? '选择 CMSIS-DAP 探针' : '未发现 CMSIS-DAP 探针','原探针未连接，请重新选择');
    $('host').replaceChildren();
    addOption($('host'),'','选择 SSH 主机');
    Array.from(new Set([c.form.host].concat(hosts))).filter(Boolean).forEach(host => addOption($('host'),host,host));
    $('host').value = c.form.host;
    updateSummary(c);
  }
  function payload() {
    return $('sendMode').value === 'hex' ? Boolean($('sendText').value.trim()) : Boolean($('sendText').value.length || $('newline').value !== 'none');
  }
  function controls() {
    const c = current();
    const probe = Boolean(c && c.form.kind === 'probe');
    const locked = !c || active(c.snapshot) || c.pending;
    $('configFields').disabled = locked;
    ['serialLocal','serialRemote','serialAdvanced'].forEach(id => { $(id).hidden = probe; $(id).disabled = locked || probe; });
    ['probeLocal','probeRemote'].forEach(id => { $(id).hidden = !probe; $(id).disabled = locked || !probe; });
    $('sender').hidden = probe;
    $('counters').hidden = probe;
    $('localTitle').textContent = probe ? '本机 CMSIS-DAP' : '本机串口';
    $('remoteTitle').textContent = probe ? '远端探针通道' : '远端虚拟串口';
    $('logTitle').textContent = probe ? '探针通道状态' : '实时收发日志';
    $('emptyTitle').textContent = probe ? '等待建立探针通道' : '等待串口数据';
    $('emptyHint').textContent = probe ? '这里只建立传输通道；芯片烧录和调试由远端工具操作' : '启动映射后，接收数据与发送记录会显示在这里';
    const available = c && (probe ? probes.some(p => p.uid === c.form.probeUID) : devices.some(d => d.device === c.form.device));
    $('start').disabled = locked || !available || !c.form.host;
    $('start').textContent = c && (c.snapshot.phase === 'starting' || c.pending) ? '正在连接…' : (probe ? '建立探针通道' : '绑定并启动');
    $('stop').disabled = !c || !locked || c.stopRequested;
    $('stop').textContent = c && (c.stopRequested || c.snapshot.phase === 'stopping') ? '正在停止…' : '停止映射';
    $('remove').disabled = !c || locked || mappings.length <= 1;
    $('send').disabled = !c || probe || c.stopRequested || c.snapshot.phase !== 'connected' || !payload();
    $('newline').disabled = $('sendMode').value === 'hex';
    const remote = c && c.snapshot.remote;
    $('openLog').disabled = probe || !(remote && remote.log);
    $('copyPort').disabled = !(remote && (remote.endpoint || remote.port));
    $('copyPort').textContent = probe ? '复制探针端点' : '复制远端端口';
  }
  function message(text,error) {
    $('message').textContent = text || '';
    $('message').classList.toggle('error',Boolean(error));
  }
  function paintLog(c) {
    const oldScroll = $('log').scrollTop;
    logNode.data = c ? c.log : '';
    $('empty').hidden = logNode.length !== 0;
    $('log').scrollTop = c && c.autoScroll ? $('log').scrollHeight : (c ? c.scroll : oldScroll);
  }
  function appendLog(c,text) {
    if (!c || !text) return;
    c.log = (c.log + text).slice(-limit);
    if (c.id === selectedId && !logPaintPending) {
      logPaintPending = true;
      requestAnimationFrame(() => { logPaintPending = false; paintLog(current()); });
    }
  }
  function appendFrame(incoming) {
    const c = channels.get(incoming.id);
    if(!c || c.form.kind === 'probe' || c.stopRequested || c.snapshot.phase !== 'connected' || incoming.session !== c.snapshot.session || !['rx','tx'].includes(incoming.type) || typeof incoming.data !== 'string') return;
    try {
      const bytes = Uint8Array.from(atob(incoming.data),char => char.charCodeAt(0));
      const text = c.decoder[incoming.type].decode(bytes,{stream:true}).replace(/\u0000/g,'␀');
      if(text) appendLog(c,'[' + new Date().toLocaleTimeString('zh-CN',{hour12:false}) + ' ' + incoming.type.toUpperCase() + '] ' + text + (text.endsWith('\n') ? '' : '\n'));
    } catch(_) { appendLog(c,'[提示] 收到无法解码的数据帧\n'); }
  }
  function sendOptions() {
    const hex = $('sendMode').value === 'hex';
    $('sendText').placeholder = hex ? '输入十六进制字节，例如：01 03 00 00 00 02' : '输入要发送的内容…';
    $('sendHint').textContent = hex ? 'HEX 原始字节 · 不追加换行符' : 'UTF-8 文本 · ⌘ / Ctrl + Enter 发送';
    controls();
  }
  function render(force) {
    const c = current(); mappingOptions();
    if (!c) { controls(); return; }
    paintForm(c,force);
    const state = c.snapshot;
    $('phase').textContent = phases[state.phase] || '未连接';
    $('badge').dataset.phase = state.phase || 'idle';
    $('rx').textContent = (Number(state.rxBytes) || 0).toLocaleString() + ' B';
    $('tx').textContent = (Number(state.txBytes) || 0).toLocaleString() + ' B';
    const remote = state.remote;
    $('remotePort').textContent = remote && (remote.endpoint || remote.port) || '连接后生成';
    $('remoteLog').textContent = c.form.kind === 'probe' ? '探针通道不生成 UART 日志' : remote && remote.log || '连接后生成';
    $('remoteStatus').textContent = remote && remote.status || '未提供';
    if (force) {
      $('sendText').value = c.send.text;
      $('sendMode').value = c.send.hex ? 'hex' : 'text';
      $('newline').value = c.send.newline;
      $('autoScroll').checked = c.autoScroll;
      paintLog(c);
    }
    sendOptions();
    message(state.message || '选择设备并手动启动当前通道。',state.phase === 'error');
  }
  function select(id,notify) {
    if (!channels.has(id)) return;
    captureSender();
    selectedId = id;
    const c = current();
    if (active(c.snapshot)) c.form = Object.assign({},defaults,c.snapshot.config || {});
    render(true); save();
    if (notify) post('select');
  }
  function send() {
    const c = current();
    if (!c || c.form.kind === 'probe' || c.stopRequested || c.snapshot.phase !== 'connected' || !payload()) return;
    const hex = $('sendMode').value === 'hex';
    if (hex) {
      const compact = $('sendText').value.replace(/\s/g,'');
      if (!compact || compact.length % 2 || !/^[0-9a-fA-F]+$/.test(compact)) { message('HEX 需使用完整的十六进制字节，例如 01 03 FF。',true); $('sendText').focus(); return; }
    }
    post('send',{text:$('sendText').value,hex:hex,newline:hex ? 'none' : $('newline').value});
    captureSender(); save();
  }
  keys.forEach(key => $(elementID(key)).addEventListener('input',() => {
    const c = current(); if (!c || active(c.snapshot) || c.pending) return;
    c.edited = true;
    c.form[key] = ['baud','dataBits','stopBits','remotePort'].includes(key) ? Number($(elementID(key)).value) : $(elementID(key)).value;
    updateSummary(c); controls(); save();
  }));
  $('mapping').addEventListener('change',() => select($('mapping').value,true));
  $('add').addEventListener('click',() => { captureSender(); save(); post('add'); });
  $('remove').addEventListener('click',() => { const c = current(); if(c && !active(c.snapshot) && !c.pending && mappings.length > 1) post('remove'); });
  $('configuration').addEventListener('submit',event => {
    event.preventDefault(); const c = current();
    if (!c || active(c.snapshot) || c.pending || !$('configuration').reportValidity()) return;
    const available = c.form.kind === 'probe' ? probes.some(p => p.uid === c.form.probeUID) : devices.some(d => d.device === c.form.device);
    if (!available) return;
    c.edited = true; c.pending = true; captureSender(); save(); controls();
    message(c.form.kind === 'probe' ? '正在建立探针传输通道…' : '正在建立当前串口映射…',false);
    post('start',{config:Object.assign({},c.form)});
  });
  ['refresh','refreshAll'].forEach(id => $(id).addEventListener('click',() => { message('正在刷新串口设备与 CMSIS-DAP 探针…',false); post('refresh'); }));
  $('stop').addEventListener('click',() => { const c = current(); if(!c || c.stopRequested) return; c.stopRequested = true; controls(); post('stop'); message('正在停止当前通道…',false); });
  $('openLog').addEventListener('click',() => post('openLog'));
  $('copyPort').addEventListener('click',() => post('copyPort'));
  $('clear').addEventListener('click',() => { const c = current(); if(c) { c.log = ''; paintLog(c); } });
  $('autoScroll').addEventListener('change',() => { captureSender(); if($('autoScroll').checked) $('log').scrollTop = $('log').scrollHeight; save(); });
  $('log').addEventListener('scroll',() => { const c = current(); if(c) c.scroll = $('log').scrollTop; });
  $('send').addEventListener('click',send);
  $('sendText').addEventListener('keydown',event => { if((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); send(); } });
  ['sendText','sendMode','newline'].forEach(id => $(id).addEventListener('input',() => { captureSender(); sendOptions(); save(); }));
  window.addEventListener('message',event => {
    const incoming = event.data; if(!incoming || typeof incoming !== 'object') return;
    if(incoming.type === 'snapshot') {
      captureSender();
      if(Array.isArray(incoming.devices)) devices = incoming.devices.filter(d => d && typeof d.device === 'string');
      if(Array.isArray(incoming.hosts)) hosts = incoming.hosts.filter(h => typeof h === 'string');
      if(Array.isArray(incoming.probes)) probes = incoming.probes.filter(p => p && typeof p.uid === 'string');
      mappings = Array.isArray(incoming.mappings) ? incoming.mappings.filter(m => m && typeof m.id === 'string') : [];
      const ids = new Set(mappings.map(m => m.id));
      channels.forEach((_,id) => { if(!ids.has(id)) channels.delete(id); });
      mappings.forEach(item => {
        const isNew = !channels.has(item.id);
        if(isNew) channels.set(item.id,createChannel(item));
        const c = channels.get(item.id), old = c.snapshot;
        if(active(item) || !c.edited) c.form = Object.assign({},defaults,item.config || {});
        if(item.session !== old.session || (item.phase === 'connected' && old.phase !== 'connected')) c.decoder = {rx:new TextDecoder('utf-8'),tx:new TextDecoder('utf-8')};
        if(!active(item)) c.stopRequested = false;
        c.pending = false;
        c.snapshot = item;
        if(c.form.kind === 'probe' && (isNew || old.phase !== item.phase || old.message !== item.message)) appendLog(c,'[状态] ' + (item.message || phases[item.phase] || '') + '\n');
      });
      const wanted = ids.has(incoming.selectedId) ? incoming.selectedId : (ids.has(selectedId) ? selectedId : (mappings[0] && mappings[0].id));
      const changed = wanted !== selectedId;
      selectedId = wanted || null;
      render(changed); save();
    } else if(incoming.type === 'dataBatch' && Array.isArray(incoming.frames)) {
      if(Array.isArray(incoming.dropped)) incoming.dropped.forEach(item => {
        const c = channels.get(item.id);
        if(!c || item.session !== c.snapshot.session || c.stopRequested || c.snapshot.phase !== 'connected') return;
        c.decoder = {rx:new TextDecoder('utf-8'),tx:new TextDecoder('utf-8')};
        appendLog(c,'[提示] 日志预览繁忙，已略过部分显示；完整数据请查看远端日志。\n');
      });
      incoming.frames.forEach(appendFrame);
    } else if(incoming.type === 'notice' && typeof incoming.message === 'string') {
      const c = channels.get(incoming.mappingId || incoming.id || selectedId);
      if(c) { c.pending = false; c.stopRequested = false; appendLog(c,'[提示] ' + incoming.message + '\n'); }
      if(!c || c.id === selectedId) { controls(); message(incoming.message,true); }
    }
  });
  controls();
  post('ready');
})();
</script>
</body>
</html>`;
}

module.exports = { html };
