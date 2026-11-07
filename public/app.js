/* 精益道场物品管理平台 前端 */
(function () {
  'use strict';

  const state = {
    user: null,
    items: [],
    requests: [],
    plans: [],
    users: [],
    dashboard: null,
    tab: '',
    itemFilter: { area: '', keyword: '' },
    reqFilter: 'pending'
  };

  const TYPE_LABELS = { borrow: '借用', return: '归还', repair: '报修', check: '点检' };
  const ROLE_LABELS = { admin: '系统管理员', keeper: '道场管理员', user: '普通员工' };
  const STATUS_FLOW = {
    'borrow:pending': '待借用审批',
    'return:pending': '待归还审核',
    'repair:pending': '报修待受理',
    'check:pending': '点检待审核',
    'repair:approved': '维修中',
    'borrow:approved': '借用中（未归还）',
    'return:approved': '已完成',
    'check:approved': '已完成',
    'borrow:finished': '已归还',
    rejected: '已驳回',
    finished: '已办结'
  };
  const ITEM_STATUS_CLASS = { 可用: 'tag-ok', 可疑: 'tag-suspect', 报废: 'tag-scrap' };

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return document.querySelectorAll(sel); }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatTime(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatDate(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function isDue(iso) {
    return iso && new Date(iso).getTime() <= Date.now();
  }

  function statusLabel(r) {
    return STATUS_FLOW[`${r.type}:${r.status}`] || STATUS_FLOW[r.status] || r.status;
  }

  function statusClass(r) {
    if (r.status === 'pending') return 'tag-pending';
    if (r.status === 'approved') return r.type === 'repair' ? 'tag-suspect' : 'tag-approved';
    if (r.status === 'finished') return 'tag-approved';
    return 'tag-rejected';
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
  }

  async function api(path, method, body) {
    const opts = { method: method || 'GET', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = {};
    try { data = await res.json(); } catch { /* ignore */ }
    if (res.status === 401 && path !== '/api/login') {
      showLogin();
      throw new Error(data.error || '请重新登录');
    }
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || '操作失败，请重试');
    }
    return data;
  }

  // ---------- 弹窗 ----------
  function openModal(title, bodyHtml, actions) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = bodyHtml;
    const act = $('#modal-actions');
    act.innerHTML = '';
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (a.className || '');
      btn.textContent = a.text;
      btn.onclick = a.onClick;
      act.appendChild(btn);
    });
    $('#modal-mask').classList.remove('hidden');
  }
  function closeModal() { $('#modal-mask').classList.add('hidden'); }

  // ---------- 登录 ----------
  function showLogin() {
    state.user = null;
    $('#main-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
  }

  function isStaff() { return state.user.role === 'admin' || state.user.role === 'keeper'; }

  function showMain() {
    $('#login-view').classList.add('hidden');
    $('#main-view').classList.remove('hidden');
    $('#current-user').textContent = state.user.name;
    $('#current-role').textContent = ROLE_LABELS[state.user.role];
    buildTabs();
    renderTab();
  }

  function buildTabs() {
    const tabs = isStaff()
      ? [
          ['dashboard', '工作台'],
          ['approve', '审批中心'],
          ['borrows', '借出明细'],
          ['repairs', '维修工单'],
          ['ledger', '物品档案'],
          ['plans', '点检计划'],
          ['records', '全部记录'],
          ['export', '报表导出']
        ]
      : [
          ['dashboard', '工作台'],
          ['items', '物品查询'],
          ['apply', '提交申请'],
          ['mine', '我的申请']
        ];
    if (state.user.role === 'admin') tabs.push(['accounts', '账号管理']);
    state.tab = tabs[0][0];
    const nav = $('#tabs');
    nav.innerHTML = '';
    tabs.forEach(([key, label]) => {
      const el = document.createElement('div');
      el.className = 'tab' + (key === state.tab ? ' active' : '');
      el.dataset.tab = key;
      el.innerHTML = escapeHtml(label) + '<span class="badge hidden"></span>';
      el.onclick = () => { state.tab = key; updateTabActive(); renderTab(); };
      nav.appendChild(el);
    });
  }

  function updateTabActive() {
    $$('.tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === state.tab);
    });
  }

  function updateBadge() {
    if (!isStaff()) return;
    const count = state.requests.filter((r) => r.status === 'pending').length;
    const tab = document.querySelector('.tab[data-tab="approve"] .badge');
    if (tab) {
      tab.textContent = count;
      tab.classList.toggle('hidden', count === 0);
    }
  }

  async function refreshItems() {
    state.items = (await api('/api/items')).items;
  }
  async function refreshRequests() {
    state.requests = (await api('/api/requests')).requests;
    updateBadge();
  }
  async function refreshPlans() {
    state.plans = (await api('/api/check-plans')).plans;
  }
  async function refreshDashboard() {
    state.dashboard = (await api('/api/dashboard')).stats;
  }
  async function refreshAll() {
    await Promise.all([refreshItems(), refreshRequests(), refreshPlans(), refreshDashboard()]);
  }

  function renderTab() {
    const c = $('#content');
    const t = state.tab;
    if (t === 'dashboard') return renderDashboard(c);
    if (t === 'items') return renderItems(c);
    if (t === 'apply') return renderApply(c);
    if (t === 'mine') return renderMine(c);
    if (t === 'approve') return renderApprove(c);
    if (t === 'borrows') return renderBorrows(c);
    if (t === 'repairs') return renderRepairs(c);
    if (t === 'ledger') return renderLedger(c);
    if (t === 'plans') return renderPlans(c);
    if (t === 'records') return renderRecords(c);
    if (t === 'export') return renderExport(c);
    if (t === 'accounts') return renderAccounts(c);
  }

  // ---------- 工作台 ----------
  function renderDashboard(c) {
    const s = state.dashboard;
    if (!s) { c.innerHTML = '<div class="card"><div class="empty">加载中...</div></div>'; return; }
    const staff = isStaff();
    const statCards = staff
      ? `
        <div class="stat-grid">
          <div class="stat-card"><div class="stat-num">${s.pendingCount || 0}</div><div class="stat-label">待审批申请</div></div>
          <div class="stat-card"><div class="stat-num">${s.repairingCount || 0}</div><div class="stat-label">维修中工单</div></div>
          <div class="stat-card"><div class="stat-num">${s.dueChecks.length}</div><div class="stat-label">到期未点检</div></div>
          <div class="stat-card"><div class="stat-num">${s.items.borrowed || 0}</div><div class="stat-label">借出中物品</div></div>
          <div class="stat-card"><div class="stat-num">${s.items.suspect || 0}</div><div class="stat-label">可疑物品</div></div>
          <div class="stat-card"><div class="stat-num">${s.items.scrap || 0}</div><div class="stat-label">报废物品</div></div>
        </div>`
      : `
        <div class="stat-grid">
          <div class="stat-card"><div class="stat-num">${s.myUnreturnedCount || 0}</div><div class="stat-label">我未归还物品（${s.myUnreturnedOrders || 0} 笔借用）</div></div>
          <div class="stat-card"><div class="stat-num">${s.myPendingCount || 0}</div><div class="stat-label">我的待审批申请</div></div>
          <div class="stat-card"><div class="stat-num">${s.dueChecks.length}</div><div class="stat-label">道场到期点检项</div></div>
        </div>`;
    const dueRows = s.dueChecks.length
      ? s.dueChecks.map((p) => `
          <tr>
            <td>${escapeHtml(p.item_code)}</td>
            <td>${escapeHtml(p.item_area)} / ${escapeHtml(p.item_name)}${p.item_sub_name ? ' / ' + escapeHtml(p.item_sub_name) : ''}</td>
            <td>每 ${p.cycle_days} 天</td>
            <td><span class="tag tag-pending">已到期（${formatDate(p.next_due_at)}）</span></td>
          </tr>`).join('')
      : '<tr><td colspan="4" class="empty">暂无到期点检项</td></tr>';
    c.innerHTML = `
      ${statCards}
      <div class="card">
        <div class="card-head"><div class="card-title">到期点检提醒</div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>编号</th><th>物品</th><th>点检周期</th><th>状态</th></tr></thead>
          <tbody>${dueRows}</tbody>
        </table></div>
      </div>`;
  }

  // ---------- 普通端：物品查询 ----------
  function renderItems(c) {
    const areas = [...new Set(state.items.map((i) => i.area))];
    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="card-title">物品台账</div>
          <div class="toolbar">
            <select id="f-area"><option value="">全部区域</option>
              ${areas.map((a) => `<option ${a === state.itemFilter.area ? 'selected' : ''}>${escapeHtml(a)}</option>`).join('')}
            </select>
            <input id="f-kw" placeholder="搜索编号/名称/细分/品牌" value="${escapeHtml(state.itemFilter.keyword)}">
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>编号</th><th>区域</th><th>名称</th><th>细分</th><th>品牌</th><th>总数</th><th>可借</th><th>状态</th><th>负责人</th></tr></thead>
          <tbody id="items-body"></tbody>
        </table></div>
      </div>`;
    $('#f-area').onchange = (e) => { state.itemFilter.area = e.target.value; fillItemsBody(); };
    $('#f-kw').oninput = (e) => { state.itemFilter.keyword = e.target.value; fillItemsBody(); };
    fillItemsBody();
  }

  function fillItemsBody() {
    const kw = state.itemFilter.keyword.trim().toLowerCase();
    const rows = state.items.filter((i) => {
      if (state.itemFilter.area && i.area !== state.itemFilter.area) return false;
      if (kw && !(i.code + i.name + i.sub_name + i.brand).toLowerCase().includes(kw)) return false;
      return true;
    });
    $('#items-body').innerHTML = rows.length
      ? rows.map((i) => `
        <tr>
          <td>${escapeHtml(i.code)}</td>
          <td>${escapeHtml(i.area)}</td>
          <td>${escapeHtml(i.name)}</td>
          <td>${escapeHtml(i.sub_name)}</td>
          <td>${escapeHtml(i.brand)}</td>
          <td>${i.quantity}${escapeHtml(i.unit)}</td>
          <td>${i.quantity - i.borrowed}</td>
          <td><span class="tag ${ITEM_STATUS_CLASS[i.status] || ''}">${escapeHtml(i.status)}</span></td>
          <td>${escapeHtml(i.keeper) || '-'}</td>
        </tr>`).join('')
      : '<tr><td colspan="9" class="empty">没有匹配的物品</td></tr>';
  }

  // ---------- 普通端：提交申请 ----------
  function renderApply(c) {
    c.innerHTML = `
      <div class="card">
        <div class="card-title" style="margin-bottom:16px">提交申请</div>
        <div class="form-row">
          <label>申请类型</label>
          <select id="a-type">
            <option value="borrow">借用</option>
            <option value="return">归还</option>
            <option value="repair">报修</option>
            <option value="check">点检</option>
          </select>
        </div>
        <div class="form-row">
          <label>物品</label>
          <select id="a-item"></select>
        </div>
        <div class="form-row">
          <label>数量</label>
          <input type="number" id="a-qty" min="1" value="1">
        </div>
        <div class="form-row">
          <label>事由说明</label>
          <textarea id="a-note" placeholder="请说明用途 / 故障情况 / 点检结论等"></textarea>
        </div>
        <button class="btn btn-primary" id="a-submit">提交申请</button>
      </div>`;

    const itemSel = $('#a-item');
    function fillItemOptions() {
      const type = $('#a-type').value;
      itemSel.innerHTML = state.items.map((i) => {
        const avail = i.quantity - i.borrowed;
        const base = `${i.code} ${i.area} / ${i.name}${i.sub_name ? ' / ' + i.sub_name : ''}`;
        const label = type === 'borrow' ? `${base}（可借 ${avail}）` : base;
        const disabled = type === 'borrow' && (avail <= 0 || i.status === '报废') ? 'disabled' : '';
        return `<option value="${i.id}" ${disabled}>${escapeHtml(label)}</option>`;
      }).join('');
    }
    fillItemOptions();
    $('#a-type').onchange = fillItemOptions;

    $('#a-submit').onclick = async () => {
      const type = $('#a-type').value;
      const itemId = Number(itemSel.value);
      const qty = Number($('#a-qty').value);
      const note = $('#a-note').value.trim();
      if (!itemId) return toast('请选择物品');
      try {
        await api('/api/requests', 'POST', { type, item_id: itemId, quantity: qty, note });
        toast('申请已提交，等待管理员审批');
        $('#a-note').value = '';
        $('#a-qty').value = 1;
        await Promise.all([refreshRequests(), refreshDashboard()]);
      } catch (e) { toast(e.message); }
    };
  }

  // ---------- 普通端：我的申请（含未归还借用） ----------
  function myUnreturned() {
    // 未归还 = 借用单已批准且未闭环
    return state.requests.filter((r) => r.type === 'borrow' && r.status === 'approved');
  }

  function renderMine(c) {
    const rows = state.requests;
    const unreturned = myUnreturned();
    const totalUnreturned = unreturned.reduce((s, r) => s + r.quantity, 0);
    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="card-title">我的未归还借用</div>
          <span class="tag ${totalUnreturned ? 'tag-pending' : 'tag-ok'}">当前未归还 ${totalUnreturned} 件</span>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>借用单号</th><th>物品</th><th>借出数量</th><th>借出时间</th><th>操作</th></tr></thead>
          <tbody>${unreturned.length ? unreturned.map((r) => `
            <tr>
              <td>${r.id}</td>
              <td>${escapeHtml(r.item_area)} / ${escapeHtml(r.item_name)}${r.item_sub_name ? ' / ' + escapeHtml(r.item_sub_name) : ''}</td>
              <td>${r.quantity}</td>
              <td>${formatTime(r.reviewed_at || r.created_at)}</td>
              <td><button class="btn btn-sm btn-primary" data-return="${r.id}">发起归还</button></td>
            </tr>`).join('') : '<tr><td colspan="5" class="empty">没有未归还的借用</td></tr>'}
          </tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="card-head"><div class="card-title">我的申请记录</div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>单号</th><th>类型</th><th>物品</th><th>数量</th><th>事由</th><th>申请时间</th><th>状态</th><th>审批意见</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td>${r.id}</td>
              <td>${TYPE_LABELS[r.type]}</td>
              <td>${escapeHtml(r.item_name)}${r.item_sub_name ? ' / ' + escapeHtml(r.item_sub_name) : ''}</td>
              <td>${r.quantity}</td>
              <td>${escapeHtml(r.note) || '-'}</td>
              <td>${formatTime(r.created_at)}</td>
              <td><span class="tag ${statusClass(r)}">${statusLabel(r)}</span></td>
              <td>${escapeHtml(r.review_note) || '-'}</td>
            </tr>`).join('') : '<tr><td colspan="8" class="empty">暂无申请记录</td></tr>'}
          </tbody>
        </table></div>
      </div>`;
    c.querySelectorAll('[data-return]').forEach((btn) => {
      btn.onclick = () => openReturnModal(Number(btn.dataset.return));
    });
  }

  function openReturnModal(borrowId) {
    const borrow = state.requests.find((x) => x.id === borrowId);
    if (!borrow) return;
    openModal(
      `发起归还（借用单 #${borrowId}）`,
      `
      <div class="form-row"><label>物品</label>
        <div>${escapeHtml(borrow.item_area)} / ${escapeHtml(borrow.item_name)}${borrow.item_sub_name ? ' / ' + escapeHtml(borrow.item_sub_name) : ''}</div>
      </div>
      <div class="form-row"><label>归还数量（借出 ${borrow.quantity}）</label>
        <input type="number" id="rt-qty" min="1" max="${borrow.quantity}" value="${borrow.quantity}">
      </div>
      <div class="form-row"><label>说明（可选）</label><textarea id="rt-note" placeholder="如：完好归还 / 有损坏等"></textarea></div>`,
      [
        { text: '取消', onClick: closeModal },
        {
          text: '提交归还申请',
          className: 'btn-primary',
          onClick: async () => {
            const qty = Number($('#rt-qty').value);
            if (!Number.isInteger(qty) || qty <= 0 || qty > borrow.quantity) {
              return toast(`归还数量需在 1-${borrow.quantity} 之间`);
            }
            try {
              await api('/api/requests', 'POST', {
                type: 'return',
                item_id: borrow.item_id,
                quantity: qty,
                note: $('#rt-note').value.trim(),
                ref_request_id: borrowId
              });
              closeModal();
              toast('归还申请已提交，等待管理员确认');
              await refreshAll();
              renderTab();
            } catch (e) { toast(e.message); }
          }
        }
      ]
    );
  }

  // ---------- 管理端：借出明细（当前未归还） ----------
  function renderBorrows(c) {
    // 当前借出 = 借用单已批准未闭环
    const rows = state.requests.filter((r) => r.type === 'borrow' && r.status === 'approved');
    const total = rows.reduce((s, r) => s + r.quantity, 0);
    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="card-title">当前借出明细（未归还）</div>
          <span class="tag ${total ? 'tag-pending' : 'tag-ok'}">共 ${total} 件借出中</span>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>借用单号</th><th>借用人</th><th>物品</th><th>数量</th><th>借出时间</th><th>已借天数</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td>${r.id}</td>
              <td>${escapeHtml(r.created_by)}</td>
              <td>${escapeHtml(r.item_area)} / ${escapeHtml(r.item_name)}${r.item_sub_name ? ' / ' + escapeHtml(r.item_sub_name) : ''}</td>
              <td>${r.quantity}</td>
              <td>${formatTime(r.reviewed_at || r.created_at)}</td>
              <td>${Math.max(0, Math.floor((Date.now() - new Date(r.reviewed_at || r.created_at).getTime()) / 86400000))} 天</td>
            </tr>`).join('') : '<tr><td colspan="6" class="empty">当前没有借出中的物品</td></tr>'}
          </tbody>
        </table></div>
      </div>`;
  }

  // ---------- 管理端：审批中心 ----------
  function renderApprove(c) {
    const filter = state.reqFilter;
    const rows = state.requests.filter((r) =>
      filter === 'all' ? true : filter === 'pending' ? r.status === 'pending' : true
    );
    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="card-title">审批中心</div>
          <div class="toolbar">
            <select id="ap-filter">
              <option value="pending" ${filter === 'pending' ? 'selected' : ''}>待处理</option>
              <option value="all" ${filter === 'all' ? 'selected' : ''}>全部</option>
            </select>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>单号</th><th>类型</th><th>物品</th><th>数量</th><th>事由</th><th>申请人</th><th>申请时间</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td>${r.id}</td>
              <td>${TYPE_LABELS[r.type]}</td>
              <td>${escapeHtml(r.item_area)} / ${escapeHtml(r.item_name)}${r.item_sub_name ? ' / ' + escapeHtml(r.item_sub_name) : ''}</td>
              <td>${r.quantity}</td>
              <td>${escapeHtml(r.note) || '-'}</td>
              <td>${escapeHtml(r.created_by)}</td>
              <td>${formatTime(r.created_at)}</td>
              <td><span class="tag ${statusClass(r)}">${statusLabel(r)}</span></td>
              <td>${r.status === 'pending'
                ? `<button class="btn btn-sm btn-approve" data-review="${r.id}" data-action="approve">通过</button>
                   <button class="btn btn-sm btn-reject" data-review="${r.id}" data-action="reject">驳回</button>`
                : escapeHtml(r.reviewed_by || '') + ' ' + formatTime(r.reviewed_at)}</td>
            </tr>`).join('') : '<tr><td colspan="9" class="empty">暂无待处理申请</td></tr>'}
          </tbody>
        </table></div>
      </div>`;
    $('#ap-filter').onchange = (e) => { state.reqFilter = e.target.value; renderApprove(c); };
    c.querySelectorAll('[data-review]').forEach((btn) => {
      btn.onclick = () => openReviewModal(Number(btn.dataset.review), btn.dataset.action);
    });
  }

  function openReviewModal(id, action) {
    const r = state.requests.find((x) => x.id === id);
    if (!r) return;
    const verb = action === 'approve' ? '通过' : '驳回';
    const extra = action === 'approve' && r.type === 'repair'
      ? '<div class="form-row"><div style="color:var(--orange);font-size:13px">受理后该物品状态将置为「可疑」，维修完成后请在「维修工单」办结。</div></div>'
      : '';
    openModal(
      `${verb}申请 #${id}`,
      `
      <div class="form-row"><label>申请内容</label>
        <div>${TYPE_LABELS[r.type]} · ${escapeHtml(r.item_name)}${r.item_sub_name ? ' / ' + escapeHtml(r.item_sub_name) : ''} · 数量 ${r.quantity}</div>
      </div>
      <div class="form-row"><label>事由</label><div>${escapeHtml(r.note) || '-'}</div></div>
      ${extra}
      <div class="form-row"><label>审批意见（可选）</label><textarea id="rv-note"></textarea></div>`,
      [
        { text: '取消', onClick: closeModal },
        {
          text: `确认${verb}`,
          className: action === 'approve' ? 'btn-approve' : 'btn-reject',
          onClick: async () => {
            try {
              await api(`/api/requests/${id}/review`, 'POST', { action, note: $('#rv-note').value.trim() });
              closeModal();
              toast(`已${verb}`);
              await refreshAll();
              renderTab();
            } catch (e) { toast(e.message); }
          }
        }
      ]
    );
  }

  // ---------- 管理端：维修工单 ----------
  function renderRepairs(c) {
    const rows = state.requests.filter((r) => r.type === 'repair' && r.status !== 'rejected');
    c.innerHTML = `
      <div class="card">
        <div class="card-head"><div class="card-title">维修工单</div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>单号</th><th>物品</th><th>数量</th><th>故障描述</th><th>报修人</th><th>报修时间</th><th>状态</th><th>办结信息</th><th>操作</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td>${r.id}</td>
              <td>${escapeHtml(r.item_area)} / ${escapeHtml(r.item_name)}${r.item_sub_name ? ' / ' + escapeHtml(r.item_sub_name) : ''}</td>
              <td>${r.quantity}</td>
              <td>${escapeHtml(r.note) || '-'}</td>
              <td>${escapeHtml(r.created_by)}</td>
              <td>${formatTime(r.created_at)}</td>
              <td><span class="tag ${statusClass(r)}">${statusLabel(r)}</span></td>
              <td>${r.status === 'finished' ? escapeHtml(r.finished_by || '') + ' ' + formatTime(r.finished_at) : '-'}</td>
              <td>${r.status === 'approved'
                ? `<button class="btn btn-sm btn-approve" data-finish="${r.id}">维修完成·办结</button>`
                : '-'}</td>
            </tr>`).join('') : '<tr><td colspan="9" class="empty">暂无维修工单</td></tr>'}
          </tbody>
        </table></div>
      </div>`;
    c.querySelectorAll('[data-finish]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/api/requests/${btn.dataset.finish}/finish`, 'POST', {});
          toast('已办结，物品状态恢复为可用');
          await refreshAll();
          renderTab();
        } catch (e) { toast(e.message); }
      };
    });
  }

  // ---------- 管理端：物品档案 ----------
  function renderLedger(c) {
    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="card-title">物品档案</div>
          <div class="toolbar">
            <input id="lg-kw" placeholder="搜索编号/名称/区域">
            <button class="btn btn-primary btn-sm" id="lg-add">+ 新增物品</button>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>编号</th><th>区域</th><th>名称</th><th>细分</th><th>品牌</th><th>总数</th><th>已借出</th><th>状态</th><th>负责人</th><th>备注</th><th>操作</th></tr></thead>
          <tbody id="lg-body"></tbody>
        </table></div>
      </div>`;
    $('#lg-kw').oninput = fillLedgerBody;
    $('#lg-add').onclick = () => openItemModal(null);
    fillLedgerBody();
  }

  function fillLedgerBody() {
    const kw = ($('#lg-kw').value || '').trim().toLowerCase();
    const rows = state.items.filter((i) => !kw || (i.code + i.name + i.area + i.sub_name + i.brand).toLowerCase().includes(kw));
    $('#lg-body').innerHTML = rows.length
      ? rows.map((i) => `
        <tr>
          <td>${escapeHtml(i.code)}</td>
          <td>${escapeHtml(i.area)}</td>
          <td>${escapeHtml(i.name)}</td>
          <td>${escapeHtml(i.sub_name)}</td>
          <td>${escapeHtml(i.brand)}</td>
          <td>${i.quantity}${escapeHtml(i.unit)}</td>
          <td>${i.borrowed}</td>
          <td><span class="tag ${ITEM_STATUS_CLASS[i.status] || ''}">${escapeHtml(i.status)}</span></td>
          <td>${escapeHtml(i.keeper) || '-'}</td>
          <td>${escapeHtml(i.remark) || '-'}</td>
          <td>
            <button class="btn btn-sm" data-edit="${i.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-del="${i.id}">删除</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="11" class="empty">没有匹配的物品</td></tr>';
    $$('[data-edit]').forEach((b) => {
      b.onclick = () => openItemModal(state.items.find((x) => x.id === Number(b.dataset.edit)));
    });
    $$('[data-del]').forEach((b) => {
      b.onclick = () => confirmDeleteItem(Number(b.dataset.del));
    });
  }

  function openItemModal(item) {
    const isEdit = !!item;
    const v = (k) => (isEdit ? escapeHtml(item[k]) : '');
    openModal(
      isEdit ? `编辑物品 #${item.id}` : '新增物品',
      `
      <div class="form-row"><label>编号</label><input id="it-code" value="${v('code')}" placeholder="如 DJ-0001"></div>
      <div class="form-row"><label>区域 *</label><input id="it-area" value="${v('area')}"></div>
      <div class="form-row"><label>名称 *</label><input id="it-name" value="${v('name')}"></div>
      <div class="form-row"><label>细分</label><input id="it-sub" value="${v('sub_name')}"></div>
      <div class="form-row"><label>品牌</label><input id="it-brand" value="${v('brand')}"></div>
      <div class="form-row"><label>单位</label><input id="it-unit" value="${isEdit ? v('unit') : '个'}"></div>
      <div class="form-row"><label>总数</label><input type="number" id="it-qty" min="0" value="${isEdit ? item.quantity : 1}"></div>
      <div class="form-row"><label>负责人</label><input id="it-keeper" value="${v('keeper')}"></div>
      ${isEdit ? `<div class="form-row"><label>状态</label>
        <select id="it-status">
          ${['可用', '可疑', '报废'].map((s) => `<option ${item.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>` : ''}
      <div class="form-row"><label>备注</label><input id="it-remark" value="${v('remark')}"></div>`,
      [
        { text: '取消', onClick: closeModal },
        {
          text: '保存',
          className: 'btn-primary',
          onClick: async () => {
            const payload = {
              code: $('#it-code').value.trim(),
              area: $('#it-area').value.trim(),
              name: $('#it-name').value.trim(),
              sub_name: $('#it-sub').value.trim(),
              brand: $('#it-brand').value.trim(),
              unit: $('#it-unit').value.trim(),
              quantity: Number($('#it-qty').value),
              keeper: $('#it-keeper').value.trim(),
              remark: $('#it-remark').value.trim()
            };
            if (isEdit) payload.status = $('#it-status').value;
            try {
              if (isEdit) await api(`/api/items/${item.id}`, 'PUT', payload);
              else await api('/api/items', 'POST', payload);
              closeModal();
              toast('已保存');
              await refreshItems();
              renderTab();
            } catch (e) { toast(e.message); }
          }
        }
      ]
    );
  }

  function confirmDeleteItem(id) {
    const item = state.items.find((x) => x.id === id);
    openModal(
      '删除物品',
      `<div>确定删除「${escapeHtml(item.area)} / ${escapeHtml(item.name)}」吗？存在待审批申请时无法删除，关联点检计划将一并删除。</div>`,
      [
        { text: '取消', onClick: closeModal },
        {
          text: '确认删除',
          className: 'btn-reject',
          onClick: async () => {
            try {
              await api(`/api/items/${id}`, 'DELETE');
              closeModal();
              toast('已删除');
              await Promise.all([refreshItems(), refreshPlans()]);
              renderTab();
            } catch (e) { toast(e.message); }
          }
        }
      ]
    );
  }

  // ---------- 管理端：点检计划 ----------
  function renderPlans(c) {
    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="card-title">定期点检计划</div>
          <button class="btn btn-primary btn-sm" id="pl-add">+ 新增计划</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>编号</th><th>物品</th><th>周期</th><th>上次点检</th><th>下次到期</th><th>状态</th><th>操作</th></tr></thead>
          <tbody>${state.plans.length ? state.plans.map((p) => `
            <tr>
              <td>${escapeHtml(p.item_code)}</td>
              <td>${escapeHtml(p.item_area)} / ${escapeHtml(p.item_name)}${p.item_sub_name ? ' / ' + escapeHtml(p.item_sub_name) : ''}</td>
              <td>每 ${p.cycle_days} 天</td>
              <td>${formatDate(p.last_done_at)}</td>
              <td>${formatDate(p.next_due_at)}</td>
              <td>${!p.active
                ? '<span class="tag tag-scrap">已停用</span>'
                : isDue(p.next_due_at)
                  ? '<span class="tag tag-pending">已到期</span>'
                  : '<span class="tag tag-ok">生效中</span>'}</td>
              <td>
                <button class="btn btn-sm" data-plan-edit="${p.id}">编辑</button>
                <button class="btn btn-sm btn-danger" data-plan-del="${p.id}">删除</button>
              </td>
            </tr>`).join('') : '<tr><td colspan="7" class="empty">暂无点检计划，点击右上角新增</td></tr>'}
          </tbody>
        </table></div>
      </div>`;
    $('#pl-add').onclick = () => openPlanModal(null);
    $$('[data-plan-edit]').forEach((b) => {
      b.onclick = () => openPlanModal(state.plans.find((x) => x.id === Number(b.dataset.planEdit)));
    });
    $$('[data-plan-del]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/check-plans/${b.dataset.planDel}`, 'DELETE');
          toast('已删除');
          await refreshPlans();
          renderTab();
        } catch (e) { toast(e.message); }
      };
    });
  }

  function openPlanModal(plan) {
    const isEdit = !!plan;
    const options = state.items
      .map((i) => `<option value="${i.id}" ${isEdit && i.id === plan.item_id ? 'selected' : ''}>${escapeHtml(i.code + ' ' + i.area + ' / ' + i.name + (i.sub_name ? ' / ' + i.sub_name : ''))}</option>`)
      .join('');
    openModal(
      isEdit ? '编辑点检计划' : '新增点检计划',
      `
      ${isEdit ? '' : `<div class="form-row"><label>物品 *</label><select id="pl-item">${options}</select></div>`}
      <div class="form-row"><label>点检周期（天）*</label><input type="number" id="pl-cycle" min="1" value="${isEdit ? plan.cycle_days : 30}"></div>
      ${isEdit ? `<div class="form-row"><label>是否启用</label>
        <select id="pl-active"><option value="1" ${plan.active ? 'selected' : ''}>启用</option><option value="0" ${!plan.active ? 'selected' : ''}>停用</option></select></div>` : ''}
      <div class="form-row"><div style="color:var(--text-dim);font-size:12px">保存后按周期重算下次到期时间；点检申请审批通过后自动顺延。</div></div>`,
      [
        { text: '取消', onClick: closeModal },
        {
          text: '保存',
          className: 'btn-primary',
          onClick: async () => {
            try {
              const cycleDays = Number($('#pl-cycle').value);
              if (isEdit) {
                await api(`/api/check-plans/${plan.id}`, 'PUT', { cycle_days: cycleDays, active: $('#pl-active').value === '1' });
              } else {
                await api('/api/check-plans', 'POST', { item_id: Number($('#pl-item').value), cycle_days: cycleDays });
              }
              closeModal();
              toast('已保存');
              await Promise.all([refreshPlans(), refreshDashboard()]);
              renderTab();
            } catch (e) { toast(e.message); }
          }
        }
      ]
    );
  }

  // ---------- 管理端：全部记录 ----------
  function renderRecords(c) {
    const rows = state.requests;
    c.innerHTML = `
      <div class="card">
        <div class="card-head"><div class="card-title">全部申请记录（共 ${rows.length} 条）</div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>单号</th><th>类型</th><th>物品</th><th>数量</th><th>申请人</th><th>申请时间</th><th>状态</th><th>审批人</th><th>审批时间</th><th>意见</th></tr></thead>
          <tbody>${rows.length ? rows.map((r) => `
            <tr>
              <td>${r.id}</td>
              <td>${TYPE_LABELS[r.type]}</td>
              <td>${escapeHtml(r.item_name)}${r.item_sub_name ? ' / ' + escapeHtml(r.item_sub_name) : ''}</td>
              <td>${r.quantity}</td>
              <td>${escapeHtml(r.created_by)}</td>
              <td>${formatTime(r.created_at)}</td>
              <td><span class="tag ${statusClass(r)}">${statusLabel(r)}</span></td>
              <td>${escapeHtml(r.reviewed_by) || '-'}</td>
              <td>${formatTime(r.reviewed_at)}</td>
              <td>${escapeHtml(r.review_note) || '-'}</td>
            </tr>`).join('') : '<tr><td colspan="10" class="empty">暂无记录</td></tr>'}
          </tbody>
        </table></div>
      </div>`;
  }

  // ---------- 管理端：报表导出 ----------
  function renderExport(c) {
    c.innerHTML = `
      <div class="card">
        <div class="card-title" style="margin-bottom:10px">报表导出</div>
        <p style="color:var(--text-dim);margin-bottom:18px">导出为 CSV 文件（可用 Excel 直接打开）。</p>
        <div class="toolbar">
          <button class="btn btn-primary" id="exp-items">导出物品台账</button>
          <button class="btn btn-primary" id="exp-reqs">导出申请审批记录</button>
        </div>
      </div>`;
    $('#exp-items').onclick = () => { window.location.href = '/api/export/items'; };
    $('#exp-reqs').onclick = () => { window.location.href = '/api/export/requests'; };
  }

  // ---------- 管理端：账号管理 ----------
  async function renderAccounts(c) {
    try {
      state.users = (await api('/api/users')).users;
    } catch (e) { toast(e.message); }
    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="card-title">账号管理</div>
          <button class="btn btn-primary btn-sm" id="ac-add">+ 新增账号</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>${state.users.map((u) => `
            <tr>
              <td>${escapeHtml(u.username)}</td>
              <td>${escapeHtml(u.display_name)}</td>
              <td>
                <select data-role="${u.id}" ${u.username === state.user.username ? 'disabled' : ''}>
                  ${Object.entries(ROLE_LABELS).map(([k, label]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${label}</option>`).join('')}
                </select>
              </td>
              <td>${u.disabled ? '<span class="tag tag-rejected">已停用</span>' : '<span class="tag tag-ok">正常</span>'}</td>
              <td>${formatTime(u.created_at)}</td>
              <td>
                <button class="btn btn-sm" data-reset="${u.id}" data-name="${escapeHtml(u.username)}">重置密码</button>
                <button class="btn btn-sm ${u.disabled ? '' : 'btn-danger'}" data-toggle="${u.id}">${u.disabled ? '启用' : '停用'}</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table></div>
      </div>`;
    $('#ac-add').onclick = openUserModal;
    $$('[data-reset]').forEach((b) => {
      b.onclick = () => openResetModal(Number(b.dataset.reset), b.dataset.name);
    });
    $$('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/users/${b.dataset.toggle}/toggle-disabled`, 'POST', {});
          toast('已更新');
          renderAccounts($('#content'));
        } catch (e) { toast(e.message); }
      };
    });
    $$('[data-role]').forEach((sel) => {
      sel.onchange = async () => {
        try {
          await api(`/api/users/${sel.dataset.role}/role`, 'POST', { role: sel.value });
          toast('角色已更新');
        } catch (e) {
          toast(e.message);
          renderAccounts($('#content'));
        }
      };
    });
  }

  function openUserModal() {
    openModal(
      '新增账号',
      `
      <div class="form-row"><label>用户名（3-20位字母/数字/下划线）*</label><input id="us-name"></div>
      <div class="form-row"><label>显示名</label><input id="us-display"></div>
      <div class="form-row"><label>初始密码（至少6位）*</label><input id="us-pass" type="password"></div>
      <div class="form-row"><label>角色</label>
        <select id="us-role">
          ${Object.entries(ROLE_LABELS).map(([k, label]) => `<option value="${k}">${label}</option>`).join('')}
        </select>
      </div>`,
      [
        { text: '取消', onClick: closeModal },
        {
          text: '创建',
          className: 'btn-primary',
          onClick: async () => {
            try {
              await api('/api/users', 'POST', {
                username: $('#us-name').value.trim(),
                display_name: $('#us-display').value.trim(),
                password: $('#us-pass').value,
                role: $('#us-role').value
              });
              closeModal();
              toast('账号已创建');
              renderAccounts($('#content'));
            } catch (e) { toast(e.message); }
          }
        }
      ]
    );
  }

  function openResetModal(id, username) {
    openModal(
      `重置密码：${username}`,
      `<div class="form-row"><label>新密码（至少6位）</label><input id="rs-pass" type="password"></div>`,
      [
        { text: '取消', onClick: closeModal },
        {
          text: '重置',
          className: 'btn-primary',
          onClick: async () => {
            try {
              await api(`/api/users/${id}/reset-password`, 'POST', { password: $('#rs-pass').value });
              closeModal();
              toast('密码已重置');
            } catch (e) { toast(e.message); }
          }
        }
      ]
    );
  }

  // ---------- 修改密码 ----------
  function openChangePwdModal() {
    openModal(
      '修改我的密码',
      `
      <div class="form-row"><label>原密码</label><input id="cp-old" type="password"></div>
      <div class="form-row"><label>新密码（至少6位）</label><input id="cp-new" type="password"></div>`,
      [
        { text: '取消', onClick: closeModal },
        {
          text: '确认修改',
          className: 'btn-primary',
          onClick: async () => {
            try {
              await api('/api/change-password', 'POST', {
                old_password: $('#cp-old').value,
                new_password: $('#cp-new').value
              });
              closeModal();
              toast('密码已修改');
            } catch (e) { toast(e.message); }
          }
        }
      ]
    );
  }

  // ---------- 启动 ----------
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#login-error').textContent = '';
    try {
      const data = await api('/api/login', 'POST', {
        username: $('#login-username').value.trim(),
        password: $('#login-password').value
      });
      state.user = data.user;
      await refreshAll();
      showMain();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    try { await api('/api/logout', 'POST', {}); } catch { /* ignore */ }
    showLogin();
  });

  $('#btn-chpwd').addEventListener('click', openChangePwdModal);

  $('#modal-mask').addEventListener('click', (e) => {
    if (e.target === $('#modal-mask')) closeModal();
  });

  (async function boot() {
    try {
      const data = await api('/api/me');
      state.user = data.user;
      await refreshAll();
      showMain();
    } catch {
      showLogin();
    }
  })();
})();
