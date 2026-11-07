/* 精益道场物品管理系统 前端 */
(function () {
  'use strict';

  const state = {
    user: null,
    items: [],
    requests: [],
    users: [],
    tab: '',
    itemFilter: { area: '', keyword: '' },
    reqFilter: 'pending'
  };

  const TYPE_LABELS = { borrow: '借用', return: '归还', repair: '报修', check: '点检' };
  const STATUS_FLOW = {
    'borrow:pending': '待借用审批',
    'return:pending': '待归还审核',
    'repair:pending': '报修处理中',
    'check:pending': '点检待审核',
    approved: '已完成',
    rejected: '已驳回'
  };
  const ITEM_STATUS_CLASS = { 可用: 'tag-ok', 可疑: 'tag-suspect', 报废: 'tag-scrap' };

  function $(sel) { return document.querySelector(sel); }

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

  function statusLabel(r) {
    if (r.status === 'pending') return STATUS_FLOW[`${r.type}:pending`] || '待审批';
    return STATUS_FLOW[r.status];
  }

  function statusClass(r) {
    return r.status === 'pending' ? 'tag-pending' : r.status === 'approved' ? 'tag-approved' : 'tag-rejected';
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

  function showMain() {
    $('#login-view').classList.add('hidden');
    $('#main-view').classList.remove('hidden');
    $('#current-user').textContent = state.user.name;
    $('#current-role').textContent = state.user.role === 'admin' ? '管理员' : '普通账号';
    buildTabs();
    renderTab();
  }

  function buildTabs() {
    const tabs = state.user.role === 'admin'
      ? [
          ['approve', '审批中心'],
          ['ledger', '台账管理'],
          ['records', '全部记录'],
          ['export', '报表导出'],
          ['accounts', '账号管理']
        ]
      : [
          ['items', '物品列表'],
          ['apply', '提交申请'],
          ['mine', '我的申请']
        ];
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
    document.querySelectorAll('.tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === state.tab);
    });
  }

  function updateBadge() {
    if (state.user.role !== 'admin') return;
    const count = state.requests.filter((r) => r.status === 'pending').length;
    const tab = document.querySelector('.tab[data-tab="approve"] .badge');
    if (tab) {
      tab.textContent = count;
      tab.classList.toggle('hidden', count === 0);
    }
  }

  async function refreshItems() {
    const data = await api('/api/items');
    state.items = data.items;
  }
  async function refreshRequests() {
    const data = await api('/api/requests');
    state.requests = data.requests;
    updateBadge();
  }

  function renderTab() {
    const c = $('#content');
    const t = state.tab;
    if (t === 'items') return renderItems(c);
    if (t === 'apply') return renderApply(c);
    if (t === 'mine') return renderMine(c);
    if (t === 'approve') return renderApprove(c);
    if (t === 'ledger') return renderLedger(c);
    if (t === 'records') return renderRecords(c);
    if (t === 'export') return renderExport(c);
    if (t === 'accounts') return renderAccounts(c);
  }

  // ---------- 普通端：物品列表 ----------
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
            <input id="f-kw" placeholder="搜索名称/细分/品牌" value="${escapeHtml(state.itemFilter.keyword)}">
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>区域</th><th>名称</th><th>细分</th><th>品牌</th><th>总数</th><th>可借</th><th>状态</th></tr></thead>
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
      if (kw && !(i.name + i.sub_name + i.brand).toLowerCase().includes(kw)) return false;
      return true;
    });
    $('#items-body').innerHTML = rows.length
      ? rows.map((i) => `
        <tr>
          <td>${escapeHtml(i.area)}</td>
          <td>${escapeHtml(i.name)}</td>
          <td>${escapeHtml(i.sub_name)}</td>
          <td>${escapeHtml(i.brand)}</td>
          <td>${i.quantity}</td>
          <td>${i.quantity - i.borrowed}</td>
          <td><span class="tag ${ITEM_STATUS_CLASS[i.status] || ''}">${escapeHtml(i.status)}</span></td>
        </tr>`).join('')
      : '<tr><td colspan="7" class="empty">没有匹配的物品</td></tr>';
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
        const label = type === 'borrow'
          ? `${i.area} / ${i.name}${i.sub_name ? ' / ' + i.sub_name : ''}（可借 ${avail}）`
          : `${i.area} / ${i.name}${i.sub_name ? ' / ' + i.sub_name : ''}`;
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
        await refreshRequests();
      } catch (e) { toast(e.message); }
    };
  }

  // ---------- 普通端：我的申请 ----------
  function renderMine(c) {
    const rows = state.requests;
    c.innerHTML = `
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
  }

  // ---------- 管理端：审批中心 ----------
  function renderApprove(c) {
    const filter = state.reqFilter;
    const rows = state.requests.filter((r) => filter === 'all' || r.status === filter);
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
    openModal(
      `${verb}申请 #${id}`,
      `
      <div class="form-row"><label>申请内容</label>
        <div>${TYPE_LABELS[r.type]} · ${escapeHtml(r.item_name)}${r.item_sub_name ? ' / ' + escapeHtml(r.item_sub_name) : ''} · 数量 ${r.quantity}</div>
      </div>
      <div class="form-row"><label>事由</label><div>${escapeHtml(r.note) || '-'}</div></div>
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
              await Promise.all([refreshRequests(), refreshItems()]);
              renderTab();
            } catch (e) { toast(e.message); }
          }
        }
      ]
    );
  }

  // ---------- 管理端：台账管理 ----------
  function renderLedger(c) {
    c.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div class="card-title">台账管理</div>
          <div class="toolbar">
            <input id="lg-kw" placeholder="搜索名称/区域">
            <button class="btn btn-primary btn-sm" id="lg-add">+ 新增物品</button>
          </div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>区域</th><th>名称</th><th>细分</th><th>品牌</th><th>总数</th><th>已借出</th><th>状态</th><th>操作</th></tr></thead>
          <tbody id="lg-body"></tbody>
        </table></div>
      </div>`;
    $('#lg-kw').oninput = fillLedgerBody;
    $('#lg-add').onclick = () => openItemModal(null);
    fillLedgerBody();
  }

  function fillLedgerBody() {
    const kw = ($('#lg-kw').value || '').trim().toLowerCase();
    const rows = state.items.filter((i) => !kw || (i.name + i.area + i.sub_name + i.brand).toLowerCase().includes(kw));
    $('#lg-body').innerHTML = rows.length
      ? rows.map((i) => `
        <tr>
          <td>${escapeHtml(i.area)}</td>
          <td>${escapeHtml(i.name)}</td>
          <td>${escapeHtml(i.sub_name)}</td>
          <td>${escapeHtml(i.brand)}</td>
          <td>${i.quantity}</td>
          <td>${i.borrowed}</td>
          <td><span class="tag ${ITEM_STATUS_CLASS[i.status] || ''}">${escapeHtml(i.status)}</span></td>
          <td>
            <button class="btn btn-sm" data-edit="${i.id}">编辑</button>
            <button class="btn btn-sm btn-danger" data-del="${i.id}">删除</button>
          </td>
        </tr>`).join('')
      : '<tr><td colspan="8" class="empty">没有匹配的物品</td></tr>';
    document.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => openItemModal(state.items.find((x) => x.id === Number(b.dataset.edit)));
    });
    document.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => confirmDeleteItem(Number(b.dataset.del));
    });
  }

  function openItemModal(item) {
    const isEdit = !!item;
    openModal(
      isEdit ? `编辑物品 #${item.id}` : '新增物品',
      `
      <div class="form-row"><label>区域 *</label><input id="it-area" value="${isEdit ? escapeHtml(item.area) : ''}"></div>
      <div class="form-row"><label>名称 *</label><input id="it-name" value="${isEdit ? escapeHtml(item.name) : ''}"></div>
      <div class="form-row"><label>细分</label><input id="it-sub" value="${isEdit ? escapeHtml(item.sub_name) : ''}"></div>
      <div class="form-row"><label>品牌</label><input id="it-brand" value="${isEdit ? escapeHtml(item.brand) : ''}"></div>
      <div class="form-row"><label>总数</label><input type="number" id="it-qty" min="0" value="${isEdit ? item.quantity : 1}"></div>
      ${isEdit ? `<div class="form-row"><label>状态</label>
        <select id="it-status">
          ${['可用', '可疑', '报废'].map((s) => `<option ${item.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>` : ''}`,
      [
        { text: '取消', onClick: closeModal },
        {
          text: '保存',
          className: 'btn-primary',
          onClick: async () => {
            const payload = {
              area: $('#it-area').value.trim(),
              name: $('#it-name').value.trim(),
              sub_name: $('#it-sub').value.trim(),
              brand: $('#it-brand').value.trim(),
              quantity: Number($('#it-qty').value)
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
      `<div>确定删除「${escapeHtml(item.area)} / ${escapeHtml(item.name)}」吗？存在待审批申请时无法删除。</div>`,
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
              await refreshItems();
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
          <button class="btn btn-primary" id="exp-items">导出台账（物品状态）</button>
          <button class="btn btn-primary" id="exp-reqs">导出申请审批记录</button>
        </div>
      </div>`;
    $('#exp-items').onclick = () => { window.location.href = '/api/export/items'; };
    $('#exp-reqs').onclick = () => { window.location.href = '/api/export/requests'; };
  }

  // ---------- 管理端：账号管理 ----------
  async function renderAccounts(c) {
    try {
      const data = await api('/api/users');
      state.users = data.users;
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
              <td>${u.role === 'admin' ? '管理员' : '普通账号'}</td>
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
    document.querySelectorAll('[data-reset]').forEach((b) => {
      b.onclick = () => openResetModal(Number(b.dataset.reset), b.dataset.name);
    });
    document.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api(`/api/users/${b.dataset.toggle}/toggle-disabled`, 'POST', {});
          toast('已更新');
          renderAccounts($('#content'));
        } catch (e) { toast(e.message); }
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
        <select id="us-role"><option value="user">普通账号</option><option value="admin">管理员</option></select>
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
      await Promise.all([refreshItems(), refreshRequests()]);
      showMain();
    } catch (err) {
      $('#login-error').textContent = err.message;
    }
  });

  $('#btn-logout').addEventListener('click', async () => {
    try { await api('/api/logout', 'POST', {}); } catch { /* ignore */ }
    showLogin();
  });

  $('#modal-mask').addEventListener('click', (e) => {
    if (e.target === $('#modal-mask')) closeModal();
  });

  (async function boot() {
    try {
      const data = await api('/api/me');
      state.user = data.user;
      await Promise.all([refreshItems(), refreshRequests()]);
      showMain();
    } catch {
      showLogin();
    }
  })();
})();
